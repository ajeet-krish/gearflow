// Modal Vite proxy integration tests. Exercises the real modalProxy
// middleware from vite.config.ts with a fake upstream, zero live calls.

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { modalProxy } from "../../vite.config";
import { MODAL_MAX_BODY_BYTES, MODAL_MODEL_ID, ModalRateLimiter } from "./modalGate";
import type { Connect } from "vite";

const MODAL_URL = "https://example-workspace--spark-open.modal.run/v1/chat/completions";
const MODAL_TOKEN = "wk-testworkspace.ws-testsecret";

interface CapturedResponse {
    statusCode: number;
    headers: Record<string, string>;
    chunks: Buffer[];
    text: string;
    writes: Buffer[];
}

interface ProxyRequest {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: string;
    ip: string;
    origin?: string;
}

function testDeps(over: Partial<Parameters<typeof modalProxy>[0]> = {}): Parameters<typeof modalProxy>[0] {
    return {
        getAuthHeaders: () => ({ authorization: `Bearer ${MODAL_TOKEN}` }),
        upstreamUrl: MODAL_URL,
        limiter: new ModalRateLimiter(1000, 60 * 1000),
        ...over,
    };
}

function getHandler(deps: Parameters<typeof modalProxy>[0]): Connect.NextHandleFunction {
    const plugin = modalProxy(deps);
    const seen: Connect.NextHandleFunction[] = [];
    plugin.configureServer({ middlewares: { use: (h: Connect.NextHandleFunction) => seen.push(h) } } as never);
    if (seen.length !== 1) throw new Error("expected one modal middleware");
    return seen[0];
}

function runProxy(
    handler: Connect.NextHandleFunction,
    opts: ProxyRequest,
    hooks: {
        onWrite?: (chunk: Buffer) => boolean;
        closeAfterMs?: number;
        emitClose?: boolean;
        emitResClose?: boolean;
        reqCloseAfterMs?: number;
        emitReqClose?: boolean;
    } = {}
): Promise<CapturedResponse> {
    return new Promise((resolve) => {
        const req = new EventEmitter() as EventEmitter & {
            url: string;
            method: string;
            headers: Record<string, string>;
            socket: { remoteAddress: string };
            destroy: () => void;
        };
        req.url = opts.url;
        req.method = opts.method;
        req.headers = { host: "localhost:5173", ...opts.headers };
        if (opts.origin !== undefined) req.headers.origin = opts.origin;
        req.socket = { remoteAddress: opts.ip };
        req.destroy = (): void => undefined;
        const headers: Record<string, string> = {};
        const writes: Buffer[] = [];
        const resEmitter = new EventEmitter();
        const res = Object.assign(resEmitter, {
            statusCode: 200,
            writableEnded: false,
            writableFinished: false,
            destroyed: false,
            setHeader: (name: string, value: string): void => {
                headers[name.toLowerCase()] = value;
            },
            write: (chunk: Buffer): boolean => {
                writes.push(Buffer.from(chunk));
                if (hooks.onWrite !== undefined) return hooks.onWrite(chunk);
                return true;
            },
            end: (data?: unknown): void => {
                (res as unknown as { writableEnded: boolean }).writableEnded = true;
                (res as unknown as { writableFinished: boolean }).writableFinished = true;
                if (data !== undefined) writes.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
                resolve({ statusCode: (res as unknown as { statusCode: number }).statusCode, headers, chunks: writes, text: Buffer.concat(writes).toString("utf8"), writes });
            },
        }) as unknown as EventEmitter & {
            statusCode: number;
            writableEnded: boolean;
            writableFinished: boolean;
            destroyed: boolean;
            setHeader: (name: string, value: string) => void;
            write: (chunk: Buffer) => boolean;
            end: (data?: unknown) => void;
        };
        // Preserve drain auto resolve for doubles without an explicit drain emitter.
        const nativeOnce = resEmitter.once.bind(resEmitter);
        (res as unknown as { once: (event: string, cb: () => void) => void }).once = (event: string, cb: () => void): void => {
            if (event === "drain") {
                nativeOnce(event, cb);
                setTimeout(() => resEmitter.emit("drain"), 0);
                return;
            }
            nativeOnce(event, cb);
        };
        const next = (): void => {
            resolve({ statusCode: 404, headers, chunks: [], text: "", writes });
        };
        handler(req as never, res as never, next);
        setTimeout(() => req.emit("data", Buffer.from(opts.body, "utf8")), 0);
        setTimeout(() => req.emit("end"), 5);
        // req close fires on normal completion and must never abort the upstream.
        const emitReqClose = hooks.emitReqClose ?? hooks.emitClose;
        if (hooks.reqCloseAfterMs !== undefined) {
            setTimeout(() => req.emit("close"), hooks.reqCloseAfterMs);
        } else if (emitReqClose !== false) {
            setTimeout(() => req.emit("close"), 2000);
        }
        // res close with writableFinished false means the client actually went away.
        if (hooks.closeAfterMs !== undefined) {
            setTimeout(() => {
                (res as unknown as { destroyed: boolean }).destroyed = true;
                resEmitter.emit("close");
            }, hooks.closeAfterMs);
        } else if (hooks.emitResClose === true) {
            setTimeout(() => {
                (res as unknown as { destroyed: boolean }).destroyed = true;
                resEmitter.emit("close");
            }, 2000);
        }
    });
}

function jsonUpstream(payload: unknown, init: { status?: number; retryAfter?: string; contentType?: string } = {}): Response {
    const status = init.status ?? 200;
    const headers: Record<string, string> = { "content-type": init.contentType ?? "application/json" };
    if (init.retryAfter !== undefined) headers["retry-after"] = init.retryAfter;
    return new Response(JSON.stringify(payload), { status, headers });
}

function sseUpstream(chunks: string[], init: { status?: number } = {}): Response {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const c of chunks) controller.enqueue(encoder.encode(c));
            controller.close();
        },
    });
    return new Response(body, {
        status: init.status ?? 200,
        headers: { "content-type": "text/event-stream" },
    });
}

describe("modalProxy wiring", () => {
    it("forces the pinned model, temp 0, and caps max_tokens before forwarding", async () => {
        let seenBody = "";
        const fetchFn = vi.fn(async (_url: unknown, init: unknown) => {
            seenBody = String((init as { body?: unknown }).body);
            return jsonUpstream({ choices: [{ message: { content: "hi" } }] });
        });
        const handler = getHandler(testDeps({
            fetchFn: fetchFn as unknown as typeof fetch,
        }));
        const out = await runProxy(handler, {
            method: "POST",
            url: "/api/modal/chat/completions",
            headers: {},
            body: JSON.stringify({ model: "attacker-model", n: 9, max_tokens: 4096, temperature: 0.9, stream: false }),
            ip: "10.1.0.1",
        });
        const sent = JSON.parse(seenBody) as Record<string, unknown>;
        expect(sent.model).toBe(MODAL_MODEL_ID);
        expect(sent.n).toBe(1);
        expect(sent.max_tokens).toBe(400);
        expect(sent.temperature).toBe(0);
        expect(out.statusCode).toBe(200);
    });

    it("returns 503 when the proxy token is absent", async () => {
        const fetchFn = vi.fn(async () => jsonUpstream({}));
        const handler = getHandler({
            getAuthHeaders: () => undefined,
            upstreamUrl: MODAL_URL,
            limiter: new ModalRateLimiter(1000, 60 * 1000),
        });
        const out = await runProxy(handler, {
            method: "POST",
            url: "/api/modal/chat/completions",
            headers: {},
            body: "{}",
            ip: "10.1.0.2",
        });
        expect(out.statusCode).toBe(503);
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it("returns 503 when MODAL_CHAT_URL is missing (fail closed, no fallback)", async () => {
        const fetchFn = vi.fn(async () => jsonUpstream({}));
        const handler = getHandler({
            getAuthHeaders: () => ({ authorization: `Bearer ${MODAL_TOKEN}` }),
            limiter: new ModalRateLimiter(1000, 60 * 1000),
        });
        const out = await runProxy(handler, {
            method: "POST",
            url: "/api/modal/chat/completions",
            headers: {},
            body: "{}",
            ip: "10.1.0.22",
        });
        expect(out.statusCode).toBe(503);
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it("rejects cross origin requests with 403", async () => {
        const fetchFn = vi.fn(async () => jsonUpstream({}));
        const handler = getHandler(testDeps({
            fetchFn: fetchFn as unknown as typeof fetch,
        }));
        const out = await runProxy(handler, {
            method: "POST",
            url: "/api/modal/chat/completions",
            headers: {},
            body: "{}",
            ip: "10.1.0.3",
            origin: "https://evil.example",
        });
        expect(out.statusCode).toBe(403);
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it("rate limits the second request with 429", async () => {
        const fetchFn = vi.fn(async () => jsonUpstream({}));
        const limiter = new ModalRateLimiter(1, 60 * 1000);
        const handler = getHandler(testDeps({ fetchFn: fetchFn as unknown as typeof fetch, limiter }));
        const first = await runProxy(handler, {
            method: "POST", url: "/api/modal/chat/completions", headers: {}, body: "{}", ip: "10.9.9.9",
        });
        expect(first.statusCode).toBe(200);
        const second = await runProxy(handler, {
            method: "POST", url: "/api/modal/chat/completions", headers: {}, body: "{}", ip: "10.9.9.9",
        });
        expect(second.statusCode).toBe(429);
    });

    it("rejects bodies over 64 KiB with 413", async () => {
        const fetchFn = vi.fn(async () => jsonUpstream({}));
        const handler = getHandler(testDeps({
            fetchFn: fetchFn as unknown as typeof fetch,
        }));
        const out = await runProxy(handler, {
            method: "POST",
            url: "/api/modal/chat/completions",
            headers: {},
            body: JSON.stringify({ filler: "x".repeat(MODAL_MAX_BODY_BYTES + 1) }),
            ip: "10.1.0.4",
        });
        expect(out.statusCode).toBe(413);
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it("maps a leaking non stream upstream error to a generic body", async () => {
        const fetchFn = vi.fn(async () =>
            jsonUpstream(
                { error: { message: "leak sk-secret-detail-xyz Bearer abc", code: "internal-trace" } },
                { status: 500, retryAfter: "3" }
            )
        );
        const handler = getHandler(testDeps({
            fetchFn: fetchFn as unknown as typeof fetch,
        }));
        const out = await runProxy(handler, {
            method: "POST",
            url: "/api/modal/chat/completions",
            headers: {},
            body: JSON.stringify({ stream: false }),
            ip: "10.1.0.5",
        });
        expect(out.statusCode).toBe(500);
        expect(out.text).not.toContain("sk-secret-detail-xyz");
        expect(out.text).not.toContain("Bearer");
        expect(JSON.parse(out.text)).toMatchObject({ error: expect.any(String) });
        expect(out.headers["retry-after"]).toBe("3");
        expect(out.headers["content-type"]).toBe("application/json");
    });

    it("maps a leaking stream path upstream error to generic JSON, not SSE", async () => {
        const fetchFn = vi.fn(async () => sseUpstream(["data: leak\n\n"], { status: 429 }));
        const handler = getHandler(testDeps({
            fetchFn: fetchFn as unknown as typeof fetch,
        }));
        const out = await runProxy(handler, {
            method: "POST",
            url: "/api/modal/chat/completions",
            headers: {},
            body: JSON.stringify({ stream: true }),
            ip: "10.1.0.6",
        });
        expect(out.statusCode).toBe(429);
        expect(out.headers["content-type"]).toBe("application/json");
        expect(out.text).not.toContain("leak");
        expect(out.text).toContain("rate limited");
    });

    it("delivers SSE chunks incrementally with SSE headers", async () => {
        const chunks = ['data: {"choices":[{"delta":{"content":"hel"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n', "data: [DONE]\n\n"];
        const fetchFn = vi.fn(async () => sseUpstream(chunks));
        const handler = getHandler(testDeps({
            fetchFn: fetchFn as unknown as typeof fetch,
        }));
        const out = await runProxy(handler, {
            method: "POST",
            url: "/api/modal/chat/completions",
            headers: {},
            body: JSON.stringify({ stream: true }),
            ip: "10.1.0.7",
        });
        expect(out.statusCode).toBe(200);
        expect(out.headers["content-type"]).toBe("text/event-stream");
        expect(out.writes.length).toBeGreaterThanOrEqual(3);
        expect(out.text).toContain("hel");
        expect(out.text).toContain("[DONE]");
    });

    it("returns 502 when declared content length exceeds the response cap", async () => {
        const big = "x".repeat(100);
        const fetchFn = vi.fn(
            async () =>
                new Response(big, {
                    status: 200,
                    headers: { "content-type": "application/json", "content-length": String(2 * 1024 * 1024) },
                })
        );
        const handler = getHandler(testDeps({
            fetchFn: fetchFn as unknown as typeof fetch,
        }));
        const out = await runProxy(handler, {
            method: "POST",
            url: "/api/modal/chat/completions",
            headers: {},
            body: JSON.stringify({ stream: false }),
            ip: "10.1.0.8",
        });
        expect(out.statusCode).toBe(502);
        expect(out.text).not.toContain(big.slice(0, 10));
    });

    it("returns 502 when accumulated non stream bytes exceed the cap", async () => {
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode("a".repeat(600 * 1024)));
                controller.enqueue(encoder.encode("b".repeat(600 * 1024)));
                controller.close();
            },
        });
        const fetchFn = vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
        const handler = getHandler(testDeps({
            fetchFn: fetchFn as unknown as typeof fetch,
        }));
        const out = await runProxy(handler, {
            method: "POST",
            url: "/api/modal/chat/completions",
            headers: {},
            body: JSON.stringify({ stream: false }),
            ip: "10.1.0.9",
        });
        expect(out.statusCode).toBe(502);
    });

    it("ends a stalled SSE stream at the idle deadline instead of hanging", async () => {
        const encoder = new TextEncoder();
        const hanging = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
            },
        });
        const fetchFn = vi.fn(async () => new Response(hanging, { status: 200, headers: { "content-type": "text/event-stream" } }));
        const handler = getHandler(testDeps({
            fetchFn: fetchFn as unknown as typeof fetch,
            timeoutMs: 50,
        }));
        const out = await runProxy(
            handler,
            {
                method: "POST",
                url: "/api/modal/chat/completions",
                headers: {},
                body: JSON.stringify({ stream: true }),
                ip: "10.1.0.10",
            },
            { emitClose: false }
        );
        expect(out.statusCode).toBe(200);
        expect(out.text).toContain("hi");
    });

    it("cancels the upstream reader on res close while the stream is open", async () => {
        let cancelled = false;
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode("data: hello\n\n"));
            },
            cancel() {
                cancelled = true;
            },
        });
        const fetchFn = vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));
        const handler = getHandler(testDeps({
            fetchFn: fetchFn as unknown as typeof fetch,
            timeoutMs: 5000,
        }));
        await runProxy(
            handler,
            {
                method: "POST",
                url: "/api/modal/chat/completions",
                headers: {},
                body: JSON.stringify({ stream: true }),
                ip: "10.1.0.11",
            },
            { closeAfterMs: 30 }
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(cancelled).toBe(true);
    });

    it("does not abort the upstream on req close (normal request completion)", async () => {
        let fetchAborted = false;
        const fetchFn = vi.fn(async (_url: unknown, init: unknown) => {
            await new Promise((resolve) => setTimeout(resolve, 30));
            try {
                (init as { signal?: AbortSignal }).signal?.throwIfAborted();
            } catch {
                fetchAborted = true;
                throw new DOMException("aborted", "AbortError");
            }
            if ((init as { signal?: AbortSignal }).signal?.aborted) {
                fetchAborted = true;
                throw new DOMException("aborted", "AbortError");
            }
            return jsonUpstream({ choices: [{ message: { content: "hi" } }] });
        });
        const handler = getHandler(testDeps({
            fetchFn: fetchFn as unknown as typeof fetch,
        }));
        const out = await runProxy(
            handler,
            {
                method: "POST",
                url: "/api/modal/chat/completions",
                headers: {},
                body: JSON.stringify({ stream: false }),
                ip: "10.1.0.12",
            },
            { reqCloseAfterMs: 10, emitResClose: false }
        );
        expect(fetchAborted).toBe(false);
        expect(fetchFn).toHaveBeenCalledTimes(1);
        expect(out.statusCode).toBe(200);
        expect(out.text).toContain("hi");
    });

    it("ignores res close after the response finished (writableFinished guard)", async () => {
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode(JSON.stringify({ ok: true })));
                controller.close();
            },
            cancel() {
                cancelled = true;
            },
        });
        const fetchFn = vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
        const handler = getHandler(testDeps({
            fetchFn: fetchFn as unknown as typeof fetch,
        }));
        const out = await runProxy(
            handler,
            {
                method: "POST",
                url: "/api/modal/chat/completions",
                headers: {},
                body: JSON.stringify({ stream: false }),
                ip: "10.1.0.13",
            },
            { emitResClose: false }
        );
        expect(out.statusCode).toBe(200);
        expect(cancelled).toBe(false);
    });
});
