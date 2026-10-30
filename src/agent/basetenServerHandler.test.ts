// Baseten Vercel server handler tests. Exercises createBasetenServerHandler
// from src/agent/basetenServerHandler.ts with a fake upstream, zero live
// calls. Mirrors the vite basetenProxy cases (path, origin, disabled,
// limiter, key, body cap, forced model, generic errors, SSE passthrough,
// kill switch) plus forwarded IP keying, absent Origin allow and reject
// modes, invalid JSON, and hostile base URL validation.

import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createBasetenServerHandler } from "./basetenServerHandler";
import type { BasetenServerHandlerDeps } from "./basetenServerHandler";
import { BASETEN_MAX_BODY_BYTES, BASETEN_MODEL_ID, BasetenRateLimiter } from "./basetenGate";
import { resolveBasetenBaseUrl } from "./basetenClient";

interface CapturedResponse {
    statusCode: number;
    headers: Record<string, string>;
    chunks: Buffer[];
    text: string;
    writes: Buffer[];
}

interface ServerRequest {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: string;
    ip: string;
    origin?: string;
}

function getHandler(deps: BasetenServerHandlerDeps): (req: IncomingMessage, res: ServerResponse) => void {
    return createBasetenServerHandler(deps);
}

function runHandler(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
    opts: ServerRequest,
    hooks: {
        onWrite?: (chunk: Buffer) => boolean;
        closeAfterMs?: number;
        emitClose?: boolean;
        emitResClose?: boolean;
        drainAfterMs?: number;
    } = {}
): Promise<CapturedResponse> {
    return new Promise((resolve) => {
        const req = new EventEmitter() as EventEmitter & {
            url: string;
            method: string;
            headers: Record<string, string>;
            socket: { remoteAddress: string };
            destroy: () => void;
            removeListener: (event: string, cb: (...args: unknown[]) => void) => EventEmitter;
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
                (resEmitter as unknown as { writableEnded: boolean }).writableEnded = true;
                const self = res as unknown as { writableEnded: boolean };
                self.writableEnded = true;
                if (data !== undefined) writes.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
                resolve({ statusCode: (res as unknown as { statusCode: number }).statusCode, headers, chunks: writes, text: Buffer.concat(writes).toString("utf8"), writes });
            },
        }) as unknown as ServerResponse & EventEmitter & { writableEnded: boolean; destroyed: boolean };
        const emitBothClose = (): void => {
            (res as unknown as { destroyed: boolean }).destroyed = true;
            resEmitter.emit("close");
            req.emit("close");
        };
        handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);
        setTimeout(() => req.emit("data", Buffer.from(opts.body, "utf8")), 0);
        setTimeout(() => req.emit("end"), 5);
        if (hooks.drainAfterMs !== undefined) {
            setTimeout(() => resEmitter.emit("drain"), hooks.drainAfterMs);
        }
        if (hooks.closeAfterMs !== undefined) {
            setTimeout(() => {
                if (hooks.emitResClose === false) {
                    req.emit("close");
                } else {
                    emitBothClose();
                }
            }, hooks.closeAfterMs);
        } else if (hooks.emitClose !== false) {
            setTimeout(() => req.emit("close"), 2000);
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

beforeEach(() => {
    delete process.env.BASETEN_DISABLED;
});

afterEach(() => {
    delete process.env.BASETEN_DISABLED;
    vi.unstubAllEnvs();
});

describe("basetenServerHandler wiring", () => {
    it("returns 405 for GET and 404 for POST off path", async () => {
        const fetchFn = vi.fn(async () => jsonUpstream({}));
        const handler = getHandler({
            fetchFn: fetchFn as unknown as typeof fetch,
            getKey: () => "test-key",
            limiter: new BasetenRateLimiter(1000, 60 * 1000),
        });
        const get = await runHandler(handler, {
            method: "GET", url: "/api/baseten/chat/completions", headers: {}, body: "", ip: "10.2.0.1",
        });
        expect(get.statusCode).toBe(405);
        const wrong = await runHandler(handler, {
            method: "POST", url: "/api/baseten/wrong", headers: {}, body: "{}", ip: "10.2.0.1",
        });
        expect(wrong.statusCode).toBe(404);
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it("forces the pinned model and caps max_tokens before forwarding", async () => {
        let seenBody = "";
        const fetchFn = vi.fn(async (_url: unknown, init: unknown) => {
            seenBody = String((init as { body?: unknown }).body);
            return jsonUpstream({ choices: [{ message: { content: "hi" } }] });
        });
        const handler = getHandler({
            fetchFn: fetchFn as unknown as typeof fetch,
            getKey: () => "test-key",
            limiter: new BasetenRateLimiter(1000, 60 * 1000),
        });
        const out = await runHandler(handler, {
            method: "POST",
            url: "/api/baseten/chat/completions",
            headers: {},
            body: JSON.stringify({ model: "attacker-model", n: 9, max_tokens: 4096, stream: false }),
            ip: "10.2.0.2",
        });
        const sent = JSON.parse(seenBody) as Record<string, unknown>;
        expect(sent.model).toBe(BASETEN_MODEL_ID);
        expect(sent.n).toBe(1);
        expect(sent.max_tokens).toBe(700);
        expect(out.statusCode).toBe(200);
    });

    it("returns 503 when the server key is absent", async () => {
        const fetchFn = vi.fn(async () => jsonUpstream({}));
        const handler = getHandler({
            fetchFn: fetchFn as unknown as typeof fetch,
            getKey: () => undefined,
            limiter: new BasetenRateLimiter(1000, 60 * 1000),
        });
        const out = await runHandler(handler, {
            method: "POST",
            url: "/api/baseten/chat/completions",
            headers: {},
            body: "{}",
            ip: "10.2.0.3",
        });
        expect(out.statusCode).toBe(503);
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it("returns 503 when the kill switch is set", async () => {
        process.env.BASETEN_DISABLED = "true";
        const fetchFn = vi.fn(async () => jsonUpstream({}));
        const handler = getHandler({
            fetchFn: fetchFn as unknown as typeof fetch,
            getKey: () => "test-key",
            limiter: new BasetenRateLimiter(1000, 60 * 1000),
        });
        const out = await runHandler(handler, {
            method: "POST",
            url: "/api/baseten/chat/completions",
            headers: {},
            body: "{}",
            ip: "10.2.0.4",
        });
        expect(out.statusCode).toBe(503);
        expect(JSON.parse(out.text)).toMatchObject({ error: expect.any(String) });
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it("rejects cross origin requests with 403", async () => {
        const fetchFn = vi.fn(async () => jsonUpstream({}));
        const handler = getHandler({
            fetchFn: fetchFn as unknown as typeof fetch,
            getKey: () => "test-key",
            limiter: new BasetenRateLimiter(1000, 60 * 1000),
        });
        const out = await runHandler(handler, {
            method: "POST",
            url: "/api/baseten/chat/completions",
            headers: {},
            body: "{}",
            ip: "10.2.0.5",
            origin: "https://evil.example",
        });
        expect(out.statusCode).toBe(403);
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it("allows absent Origin by default but rejects it with requireOrigin", async () => {
        const fetchFn = vi.fn(async () => jsonUpstream({ ok: true }));
        const open = getHandler({
            fetchFn: fetchFn as unknown as typeof fetch,
            getKey: () => "test-key",
            limiter: new BasetenRateLimiter(1000, 60 * 1000),
        });
        const allowed = await runHandler(open, {
            method: "POST", url: "/api/baseten/chat/completions", headers: {}, body: "{}", ip: "10.2.0.6",
        });
        expect(allowed.statusCode).toBe(200);

        const strictFetch = vi.fn(async () => jsonUpstream({ ok: true }));
        const strict = getHandler({
            fetchFn: strictFetch as unknown as typeof fetch,
            getKey: () => "test-key",
            limiter: new BasetenRateLimiter(1000, 60 * 1000),
            requireOrigin: true,
        });
        const rejected = await runHandler(strict, {
            method: "POST", url: "/api/baseten/chat/completions", headers: {}, body: "{}", ip: "10.2.0.6",
        });
        expect(rejected.statusCode).toBe(403);
        expect(strictFetch).not.toHaveBeenCalled();
        const withOrigin = await runHandler(strict, {
            method: "POST",
            url: "/api/baseten/chat/completions",
            headers: {},
            body: "{}",
            ip: "10.2.0.6",
            origin: "http://localhost:5173",
        });
        expect(withOrigin.statusCode).toBe(200);
        expect(strictFetch).toHaveBeenCalledTimes(1);
    });

    it("rate limits the second request with 429", async () => {
        const fetchFn = vi.fn(async () => jsonUpstream({}));
        const limiter = new BasetenRateLimiter(1, 60 * 1000);
        const handler = getHandler({ fetchFn: fetchFn as unknown as typeof fetch, getKey: () => "k", limiter });
        const first = await runHandler(handler, {
            method: "POST", url: "/api/baseten/chat/completions", headers: {}, body: "{}", ip: "10.9.9.9",
        });
        expect(first.statusCode).toBe(200);
        const second = await runHandler(handler, {
            method: "POST", url: "/api/baseten/chat/completions", headers: {}, body: "{}", ip: "10.9.9.9",
        });
        expect(second.statusCode).toBe(429);
    });

    it("keys the limiter by x-forwarded-for first entry, then x-real-ip", async () => {
        const seen: string[] = [];
        const recording = { allow: (ip: string): boolean => { seen.push(ip); return true; } };
        const fetchFn = vi.fn(async () => jsonUpstream({ ok: true }));
        const handler = getHandler({
            fetchFn: fetchFn as unknown as typeof fetch,
            getKey: () => "test-key",
            limiter: recording,
        });
        await runHandler(handler, {
            method: "POST",
            url: "/api/baseten/chat/completions",
            headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
            body: "{}",
            ip: "9.9.9.9",
        });
        expect(seen).toEqual(["1.2.3.4"]);
        await runHandler(handler, {
            method: "POST",
            url: "/api/baseten/chat/completions",
            headers: { "x-real-ip": "2.3.4.5" },
            body: "{}",
            ip: "9.9.9.9",
        });
        expect(seen).toEqual(["1.2.3.4", "2.3.4.5"]);
        await runHandler(handler, {
            method: "POST",
            url: "/api/baseten/chat/completions",
            headers: {},
            body: "{}",
            ip: "9.9.9.9",
        });
        expect(seen).toEqual(["1.2.3.4", "2.3.4.5", "9.9.9.9"]);
    });

    it("rejects bodies over 64 KiB with 413", async () => {
        const fetchFn = vi.fn(async () => jsonUpstream({}));
        const handler = getHandler({
            fetchFn: fetchFn as unknown as typeof fetch,
            getKey: () => "test-key",
            limiter: new BasetenRateLimiter(1000, 60 * 1000),
        });
        const out = await runHandler(handler, {
            method: "POST",
            url: "/api/baseten/chat/completions",
            headers: {},
            body: JSON.stringify({ filler: "x".repeat(BASETEN_MAX_BODY_BYTES + 1) }),
            ip: "10.2.0.7",
        });
        expect(out.statusCode).toBe(413);
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it("returns 400 for invalid JSON bodies", async () => {
        const fetchFn = vi.fn(async () => jsonUpstream({}));
        const handler = getHandler({
            fetchFn: fetchFn as unknown as typeof fetch,
            getKey: () => "test-key",
            limiter: new BasetenRateLimiter(1000, 60 * 1000),
        });
        const out = await runHandler(handler, {
            method: "POST",
            url: "/api/baseten/chat/completions",
            headers: {},
            body: "{not-json",
            ip: "10.2.0.8",
        });
        expect(out.statusCode).toBe(400);
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it("maps a leaking non stream upstream error to a generic body", async () => {
        const fetchFn = vi.fn(async () =>
            jsonUpstream(
                { error: { message: "leak sk-secret-detail-xyz Bearer abc", code: "internal-trace" } },
                { status: 500, retryAfter: "3" }
            )
        );
        const handler = getHandler({
            fetchFn: fetchFn as unknown as typeof fetch,
            getKey: () => "test-key",
            limiter: new BasetenRateLimiter(1000, 60 * 1000),
        });
        const out = await runHandler(handler, {
            method: "POST",
            url: "/api/baseten/chat/completions",
            headers: {},
            body: JSON.stringify({ stream: false }),
            ip: "10.2.0.9",
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
        const handler = getHandler({
            fetchFn: fetchFn as unknown as typeof fetch,
            getKey: () => "test-key",
            limiter: new BasetenRateLimiter(1000, 60 * 1000),
        });
        const out = await runHandler(handler, {
            method: "POST",
            url: "/api/baseten/chat/completions",
            headers: {},
            body: JSON.stringify({ stream: true }),
            ip: "10.2.0.10",
        });
        expect(out.statusCode).toBe(429);
        expect(out.headers["content-type"]).toBe("application/json");
        expect(out.text).not.toContain("leak");
        expect(out.text).toContain("rate limited");
    });

    it("delivers SSE chunks incrementally with SSE headers", async () => {
        const chunks = ['data: {"choices":[{"delta":{"content":"hel"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n', "data: [DONE]\n\n"];
        const fetchFn = vi.fn(async () => sseUpstream(chunks));
        const handler = getHandler({
            fetchFn: fetchFn as unknown as typeof fetch,
            getKey: () => "test-key",
            limiter: new BasetenRateLimiter(1000, 60 * 1000),
        });
        const out = await runHandler(handler, {
            method: "POST",
            url: "/api/baseten/chat/completions",
            headers: {},
            body: JSON.stringify({ stream: true }),
            ip: "10.2.0.11",
        });
        expect(out.statusCode).toBe(200);
        expect(out.headers["content-type"]).toBe("text/event-stream");
        expect(out.headers["cache-control"]).toBe("no-cache");
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
        const handler = getHandler({
            fetchFn: fetchFn as unknown as typeof fetch,
            getKey: () => "test-key",
            limiter: new BasetenRateLimiter(1000, 60 * 1000),
        });
        const out = await runHandler(handler, {
            method: "POST",
            url: "/api/baseten/chat/completions",
            headers: {},
            body: JSON.stringify({ stream: false }),
            ip: "10.2.0.12",
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
        const handler = getHandler({
            fetchFn: fetchFn as unknown as typeof fetch,
            getKey: () => "test-key",
            limiter: new BasetenRateLimiter(1000, 60 * 1000),
        });
        const out = await runHandler(handler, {
            method: "POST",
            url: "/api/baseten/chat/completions",
            headers: {},
            body: JSON.stringify({ stream: false }),
            ip: "10.2.0.13",
        });
        expect(out.statusCode).toBe(502);
    });

    it("returns 502 when the upstream fetch throws", async () => {
        const fetchFn = vi.fn(async () => { throw new Error("boom"); });
        const handler = getHandler({
            fetchFn: fetchFn as unknown as typeof fetch,
            getKey: () => "test-key",
            limiter: new BasetenRateLimiter(1000, 60 * 1000),
        });
        const out = await runHandler(handler, {
            method: "POST",
            url: "/api/baseten/chat/completions",
            headers: {},
            body: "{}",
            ip: "10.2.0.14",
        });
        expect(out.statusCode).toBe(502);
        expect(JSON.parse(out.text)).toMatchObject({ error: expect.any(String) });
    });

    it("cancels the upstream reader when the client disconnects mid stream", async () => {
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
        const handler = getHandler({
            fetchFn: fetchFn as unknown as typeof fetch,
            getKey: () => "test-key",
            limiter: new BasetenRateLimiter(1000, 60 * 1000),
            timeoutMs: 5000,
        });
        await runHandler(
            handler,
            {
                method: "POST",
                url: "/api/baseten/chat/completions",
                headers: {},
                body: JSON.stringify({ stream: true }),
                ip: "10.2.0.15",
            },
            { closeAfterMs: 30 }
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(cancelled).toBe(true);
    });

    it("ends a stalled SSE stream at the idle deadline instead of hanging", async () => {
        const encoder = new TextEncoder();
        const hanging = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
            },
        });
        const fetchFn = vi.fn(async () => new Response(hanging, { status: 200, headers: { "content-type": "text/event-stream" } }));
        const handler = getHandler({
            fetchFn: fetchFn as unknown as typeof fetch,
            getKey: () => "test-key",
            limiter: new BasetenRateLimiter(1000, 60 * 1000),
            timeoutMs: 50,
        });
        const out = await runHandler(
            handler,
            {
                method: "POST",
                url: "/api/baseten/chat/completions",
                headers: {},
                body: JSON.stringify({ stream: true }),
                ip: "10.2.0.16",
            },
            { emitClose: false }
        );
        expect(out.statusCode).toBe(200);
        expect(out.text).toContain("hi");
    });

    it("waits for drain when write returns false then delivers all chunks", async () => {
        const chunks = ['data: {"choices":[{"delta":{"content":"hel"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n', "data: [DONE]\n\n"];
        const fetchFn = vi.fn(async () => sseUpstream(chunks));
        const handler = getHandler({
            fetchFn: fetchFn as unknown as typeof fetch,
            getKey: () => "test-key",
            limiter: new BasetenRateLimiter(1000, 60 * 1000),
        });
        let calls = 0;
        const out = await runHandler(
            handler,
            {
                method: "POST",
                url: "/api/baseten/chat/completions",
                headers: {},
                body: JSON.stringify({ stream: true }),
                ip: "10.2.0.17",
            },
            {
                emitClose: false,
                onWrite: () => {
                    calls += 1;
                    if (calls === 1) {
                        setTimeout(() => {
                            // Release backpressure after the first write.
                        }, 0);
                        return false;
                    }
                    return true;
                },
                drainAfterMs: 10,
            }
        );
        expect(out.statusCode).toBe(200);
        expect(out.text).toContain("hel");
        expect(out.text).toContain("[DONE]");
        expect(out.writes.length).toBeGreaterThanOrEqual(3);
    });

    it("releases a pending drain and finishes when the client disconnects during backpressure", async () => {
        let cancelled = false;
        const encoder = new TextEncoder();
        let readerRef: { cancel: () => void } | null = null;
        const hanging = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode("data: hello\n\n"));
                controller.enqueue(encoder.encode("data: world\n\n"));
            },
            cancel() {
                cancelled = true;
            },
        });
        void readerRef;
        const fetchFn = vi.fn(async () => new Response(hanging, { status: 200, headers: { "content-type": "text/event-stream" } }));
        const handler = getHandler({
            fetchFn: fetchFn as unknown as typeof fetch,
            getKey: () => "test-key",
            limiter: new BasetenRateLimiter(1000, 60 * 1000),
            timeoutMs: 5000,
        });
        const startedAt = Date.now();
        const out = await Promise.race([
            runHandler(
                handler,
                {
                    method: "POST",
                    url: "/api/baseten/chat/completions",
                    headers: {},
                    body: JSON.stringify({ stream: true }),
                    ip: "10.2.0.18",
                },
                {
                    onWrite: () => false,
                    closeAfterMs: 30,
                    drainAfterMs: 5000,
                }
            ),
            new Promise<never>((_resolve, reject) => {
                setTimeout(() => reject(new Error("drain deadlock: handler did not finish after close")), 1000);
            }),
        ]);
        expect(Date.now() - startedAt).toBeLessThan(1000);
        expect(out.statusCode).toBe(200);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(cancelled).toBe(true);
    });
});

describe("baseten prod adapter pins", () => {
    it("pins requireOrigin true and maxDuration 60 on the Vercel adapter", async () => {
        vi.stubEnv("BASETEN_API_KEY", "test-key");
        const upstream = vi.fn(async () => jsonUpstream({ ok: true }));
        const realFetch = globalThis.fetch;
        vi.stubGlobal("fetch", upstream as unknown as typeof fetch);
        try {
            vi.resetModules();
            const mod = await import("../../api/baseten/chat/completions");
            expect(mod.config).toMatchObject({ maxDuration: 60 });
            expect(typeof mod.default).toBe("function");
            const rejected = await runHandler(mod.default as unknown as (req: IncomingMessage, res: ServerResponse) => void, {
                method: "POST",
                url: "/api/baseten/chat/completions",
                headers: {},
                body: "{}",
                ip: "10.3.0.1",
            });
            expect(rejected.statusCode).toBe(403);
            expect(upstream).not.toHaveBeenCalled();
            const allowed = await runHandler(mod.default as unknown as (req: IncomingMessage, res: ServerResponse) => void, {
                method: "POST",
                url: "/api/baseten/chat/completions",
                headers: {},
                body: "{}",
                ip: "10.3.0.2",
                origin: "http://localhost:5173",
            });
            expect(allowed.statusCode).toBe(200);
            expect(upstream).toHaveBeenCalledTimes(1);
        } finally {
            vi.stubGlobal("fetch", realFetch);
            vi.unstubAllEnvs();
        }
    });
});

describe("resolveBasetenBaseUrl hostile values", () => {
    it("falls back to the default for hostile explicit values", () => {
        expect(resolveBasetenBaseUrl("javascript:alert(1)")).toBe("/api/baseten");
        expect(resolveBasetenBaseUrl("data:text/plain,hi")).toBe("/api/baseten");
        expect(resolveBasetenBaseUrl("ftp://example.com/baseten")).toBe("/api/baseten");
        expect(resolveBasetenBaseUrl("//evil.example/baseten")).toBe("/api/baseten");
        expect(resolveBasetenBaseUrl("/api/../evil")).toBe("/api/baseten");
        expect(resolveBasetenBaseUrl("/api/baseten?key=secret")).toBe("/api/baseten");
        expect(resolveBasetenBaseUrl("/api/baseten#frag")).toBe("/api/baseten");
        expect(resolveBasetenBaseUrl("https://user:pass@example.com/baseten")).toBe("/api/baseten");
        expect(resolveBasetenBaseUrl("https://example.com/baseten?key=1")).toBe("/api/baseten");
        expect(resolveBasetenBaseUrl("https://example.com/baseten#frag")).toBe("/api/baseten");
        expect(resolveBasetenBaseUrl("https://example.com/../evil")).toBe("/api/baseten");
    });

    it("falls back to the default for hostile env values", () => {
        vi.stubEnv("VITE_BASETEN_URL", "javascript:alert(1)");
        expect(resolveBasetenBaseUrl()).toBe("/api/baseten");
        vi.stubEnv("VITE_BASETEN_URL", "https://user:pass@example.com/baseten");
        expect(resolveBasetenBaseUrl()).toBe("/api/baseten");
        vi.stubEnv("VITE_BASETEN_URL", "//evil.example/baseten");
        expect(resolveBasetenBaseUrl()).toBe("/api/baseten");
        vi.stubEnv("VITE_BASETEN_URL", "/api/../evil");
        expect(resolveBasetenBaseUrl()).toBe("/api/baseten");
    });

    it("still allows safe relative and https bases", () => {
        vi.stubEnv("VITE_BASETEN_URL", "");
        expect(resolveBasetenBaseUrl("/api/baseten")).toBe("/api/baseten");
        expect(resolveBasetenBaseUrl("https://proxy.example.com/baseten")).toBe("https://proxy.example.com/baseten");
    });
});
