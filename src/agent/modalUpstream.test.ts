// Modal upstream tests. Resolver plus Modal upstream replay through
// both the server handler and the Vite proxy. Modal-only with fail-closed
// 503 on missing or hostile config, zero live calls.

import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
    MODAL_MODEL_ID,
    ModalRateLimiter,
    resolveModalModelId,
    resolveModalUpstreamUrl,
} from "./modalGate";
import { createModalServerHandler } from "./modalServerHandler";
import { modalProxy } from "../../vite.config";
import type { Connect } from "vite";

const MODAL_URL = "https://example-workspace--spark-open.modal.run/v1/chat/completions";
const MODAL_TOKEN = "wk-testworkspace.ws-testsecret";

beforeEach(() => {
    delete process.env.MODAL_CHAT_URL;
    delete process.env.MODAL_MODEL_ID;
    delete process.env.MODAL_PROXY_TOKEN;
    delete process.env.MODAL_DISABLED;
});

afterEach(() => {
    delete process.env.MODAL_CHAT_URL;
    delete process.env.MODAL_MODEL_ID;
    delete process.env.MODAL_PROXY_TOKEN;
    delete process.env.MODAL_DISABLED;
    vi.unstubAllEnvs();
});

function jsonUpstream(payload: unknown, init: { status?: number } = {}): Response {
    return new Response(JSON.stringify(payload), {
        status: init.status ?? 200,
        headers: { "content-type": "application/json" },
    });
}

function sseUpstream(chunks: string[]): Response {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const c of chunks) controller.enqueue(encoder.encode(c));
            controller.close();
        },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function runServerHandler(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
    body: string
): Promise<{ statusCode: number; headers: Record<string, string>; text: string; writes: Buffer[] }> {
    return new Promise((resolve) => {
        const req = new EventEmitter() as EventEmitter & {
            url: string;
            method: string;
            headers: Record<string, string>;
            socket: { remoteAddress: string };
            destroy: () => void;
        };
        req.url = "/api/modal/chat/completions";
        req.method = "POST";
        req.headers = { host: "localhost:5173" };
        req.socket = { remoteAddress: "10.20.0.1" };
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
                return true;
            },
            end: (data?: unknown): void => {
                (res as unknown as { writableEnded: boolean }).writableEnded = true;
                if (data !== undefined) writes.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
                resolve({
                    statusCode: (res as unknown as { statusCode: number }).statusCode,
                    headers,
                    text: Buffer.concat(writes).toString("utf8"),
                    writes,
                });
            },
        }) as unknown as ServerResponse & EventEmitter;
        handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);
        setTimeout(() => req.emit("data", Buffer.from(body, "utf8")), 0);
        setTimeout(() => req.emit("end"), 5);
        setTimeout(() => req.emit("close"), 2000);
    });
}

function getViteHandler(deps: Parameters<typeof modalProxy>[0]): Connect.NextHandleFunction {
    const plugin = modalProxy(deps);
    const seen: Connect.NextHandleFunction[] = [];
    plugin.configureServer({ middlewares: { use: (h: Connect.NextHandleFunction) => seen.push(h) } } as never);
    if (seen.length !== 1) throw new Error("expected one modal middleware");
    return seen[0];
}

function runViteHandler(
    handler: Connect.NextHandleFunction,
    body: string
): Promise<{ statusCode: number; headers: Record<string, string>; text: string; writes: Buffer[] }> {
    return new Promise((resolve) => {
        const req = new EventEmitter() as EventEmitter & {
            url: string;
            method: string;
            headers: Record<string, string>;
            socket: { remoteAddress: string };
            destroy: () => void;
        };
        req.url = "/api/modal/chat/completions";
        req.method = "POST";
        req.headers = { host: "localhost:5173" };
        req.socket = { remoteAddress: "10.20.0.2" };
        req.destroy = (): void => undefined;
        const headers: Record<string, string> = {};
        const writes: Buffer[] = [];
        const res = {
            statusCode: 200,
            writableEnded: false,
            destroyed: false,
            setHeader: (name: string, value: string): void => {
                headers[name.toLowerCase()] = value;
            },
            write: (chunk: Buffer): boolean => {
                writes.push(Buffer.from(chunk));
                return true;
            },
            end: (data?: unknown): void => {
                res.writableEnded = true;
                if (data !== undefined) writes.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
                resolve({ statusCode: res.statusCode, headers, text: Buffer.concat(writes).toString("utf8"), writes });
            },
            once: (event: string, cb: () => void): void => {
                if (event === "drain") setTimeout(cb, 0);
            },
        };
        handler(req as never, res as never, () => undefined);
        setTimeout(() => req.emit("data", Buffer.from(body, "utf8")), 0);
        setTimeout(() => req.emit("end"), 5);
        setTimeout(() => req.emit("close"), 2000);
    });
}

describe("modal endpoint model", () => {
    it("pins the Modal endpoint name by default", () => {
        expect(MODAL_MODEL_ID).toBe("gearflow-chat");
        expect(resolveModalModelId({})).toBe("gearflow-chat");
        expect(resolveModalModelId({ MODAL_MODEL_ID: "" })).toBe("gearflow-chat");
    });

    it("overrides the Modal model from MODAL_MODEL_ID env for renames", () => {
        expect(resolveModalModelId({ MODAL_MODEL_ID: "custom-endpoint" })).toBe("custom-endpoint");
    });
});

describe("modal handler replay", () => {
    it("replays an OpenAI shaped JSON body through the server handler", async () => {
        let seenUrl = "";
        let seenAuth = "";
        let seenBody = "";
        const fetchFn = vi.fn(async (url: unknown, init: unknown) => {
            seenUrl = String(url);
            seenAuth = String((init as { headers?: Record<string, string> }).headers?.authorization ?? "");
            seenBody = String((init as { body?: unknown }).body ?? "");
            return jsonUpstream({
                id: "chatcmpl-modal-1",
                choices: [{ message: { content: '{"action":"explain"}', reasoning_content: "thought" } }],
                usage: { prompt_tokens: 10, completion_tokens: 5 },
            });
        });
        const handler = createModalServerHandler({
            fetchFn: fetchFn as unknown as typeof fetch,
            getAuthHeaders: () => ({ authorization: `Bearer ${MODAL_TOKEN}` }),
            upstreamUrl: MODAL_URL,
            limiter: new ModalRateLimiter(1000, 60 * 1000),
        });
        const out = await runServerHandler(handler, JSON.stringify({ model: "attacker", stream: false }));
        expect(out.statusCode).toBe(200);
        expect(seenUrl).toBe(MODAL_URL);
        expect(seenAuth).toBe(`Bearer ${MODAL_TOKEN}`);
        expect((JSON.parse(seenBody) as Record<string, unknown>).model).toBe(MODAL_MODEL_ID);
        expect(out.text).toContain("explain");
    });

    it("replays SSE with reasoning_content plus DONE through the server handler", async () => {
        const chunks = [
            'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
            "data: [DONE]\n\n",
        ];
        const fetchFn = vi.fn(async () => sseUpstream(chunks));
        const handler = createModalServerHandler({
            fetchFn: fetchFn as unknown as typeof fetch,
            getAuthHeaders: () => ({ authorization: `Bearer ${MODAL_TOKEN}` }),
            upstreamUrl: MODAL_URL,
            limiter: new ModalRateLimiter(1000, 60 * 1000),
        });
        const out = await runServerHandler(handler, JSON.stringify({ stream: true }));
        expect(out.statusCode).toBe(200);
        expect(out.headers["content-type"]).toBe("text/event-stream");
        expect(out.writes.length).toBeGreaterThanOrEqual(3);
        expect(out.text).toContain("reasoning_content");
        expect(out.text).toContain("[DONE]");
    });
});

describe("modal vite parity", () => {
    it("routes the Vite proxy to the same Modal upstream, model, and auth", async () => {
        let seenUrl = "";
        let seenAuth = "";
        let seenBody = "";
        const fetchFn = vi.fn(async (url: unknown, init: unknown) => {
            seenUrl = String(url);
            seenAuth = String((init as { headers?: Record<string, string> }).headers?.authorization ?? "");
            seenBody = String((init as { body?: unknown }).body ?? "");
            return jsonUpstream({
                id: "chatcmpl-modal-2",
                choices: [{ message: { content: '{"action":"explain"}', reasoning_content: "parity" } }],
            });
        });
        const handler = getViteHandler({
            fetchFn: fetchFn as unknown as typeof fetch,
            getAuthHeaders: () => ({ authorization: `Bearer ${MODAL_TOKEN}` }),
            upstreamUrl: MODAL_URL,
            limiter: new ModalRateLimiter(1000, 60 * 1000),
        });
        const out = await runViteHandler(handler, JSON.stringify({ model: "attacker", stream: false }));
        expect(out.statusCode).toBe(200);
        expect(seenUrl).toBe(MODAL_URL);
        expect(seenAuth).toBe(`Bearer ${MODAL_TOKEN}`);
        expect((JSON.parse(seenBody) as Record<string, unknown>).model).toBe(MODAL_MODEL_ID);
        expect(out.text).toContain("explain");
    });
});

describe("env driven upstream", () => {
    it("resolves Modal from env through the shared helper in the handler", async () => {
        process.env.MODAL_CHAT_URL = MODAL_URL;
        process.env.MODAL_PROXY_TOKEN = MODAL_TOKEN;
        expect(resolveModalUpstreamUrl()).toBe(MODAL_URL);
        let seenUrl = "";
        let seenAuth = "";
        let seenBody = "";
        const fetchFn = vi.fn(async (url: unknown, init: unknown) => {
            seenUrl = String(url);
            seenAuth = String((init as { headers?: Record<string, string> }).headers?.authorization ?? "");
            seenBody = String((init as { body?: unknown }).body ?? "");
            return jsonUpstream({
                id: "chatcmpl-modal-env",
                choices: [{ message: { content: '{"action":"explain"}' } }],
            });
        });
        const handler = createModalServerHandler({
            fetchFn: fetchFn as unknown as typeof fetch,
            limiter: new ModalRateLimiter(1000, 60 * 1000),
        });
        const out = await runServerHandler(handler, JSON.stringify({ model: "attacker", stream: false }));
        expect(out.statusCode).toBe(200);
        expect(seenUrl).toBe(MODAL_URL);
        expect(seenAuth).toBe(`Bearer ${MODAL_TOKEN}`);
        expect((JSON.parse(seenBody) as Record<string, unknown>).model).toBe(MODAL_MODEL_ID);
    });

    it("resolves Modal from env through the shared helper in the Vite proxy", async () => {
        process.env.MODAL_CHAT_URL = MODAL_URL;
        process.env.MODAL_PROXY_TOKEN = MODAL_TOKEN;
        let seenUrl = "";
        let seenAuth = "";
        let seenBody = "";
        const fetchFn = vi.fn(async (url: unknown, init: unknown) => {
            seenUrl = String(url);
            seenAuth = String((init as { headers?: Record<string, string> }).headers?.authorization ?? "");
            seenBody = String((init as { body?: unknown }).body ?? "");
            return jsonUpstream({
                id: "chatcmpl-modal-env-vite",
                choices: [{ message: { content: '{"action":"explain"}' } }],
            });
        });
        const handler = getViteHandler({
            fetchFn: fetchFn as unknown as typeof fetch,
            limiter: new ModalRateLimiter(1000, 60 * 1000),
        });
        const out = await runViteHandler(handler, JSON.stringify({ model: "attacker", stream: false }));
        expect(out.statusCode).toBe(200);
        expect(seenUrl).toBe(MODAL_URL);
        expect(seenAuth).toBe(`Bearer ${MODAL_TOKEN}`);
        expect((JSON.parse(seenBody) as Record<string, unknown>).model).toBe(MODAL_MODEL_ID);
    });

    it("resolves a modal.direct upstream from env", async () => {
        process.env.MODAL_CHAT_URL = "https://example-workspace--spark-open.modal.direct/v1/chat/completions";
        process.env.MODAL_PROXY_TOKEN = MODAL_TOKEN;
        expect(resolveModalUpstreamUrl()).toBe("https://example-workspace--spark-open.modal.direct/v1/chat/completions");
        const fetchFn = vi.fn(async () => jsonUpstream({ choices: [{ message: { content: "ok" } }] }));
        const handler = createModalServerHandler({
            fetchFn: fetchFn as unknown as typeof fetch,
            limiter: new ModalRateLimiter(1000, 60 * 1000),
        });
        const out = await runServerHandler(handler, JSON.stringify({ model: "attacker" }));
        expect(out.statusCode).toBe(200);
        expect(fetchFn).toHaveBeenCalled();
    });

    it("fails closed to 503 for a hostile MODAL_CHAT_URL at the handler level", async () => {
        process.env.MODAL_CHAT_URL = "https://evil.example/v1/chat/completions";
        process.env.MODAL_PROXY_TOKEN = MODAL_TOKEN;
        expect(resolveModalUpstreamUrl()).toBeNull();
        const fetchFn = vi.fn(async () => jsonUpstream({ ok: true }));
        const handler = createModalServerHandler({
            fetchFn: fetchFn as unknown as typeof fetch,
            limiter: new ModalRateLimiter(1000, 60 * 1000),
        });
        const out = await runServerHandler(handler, JSON.stringify({ model: "attacker" }));
        expect(out.statusCode).toBe(503);
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it("fails closed to 503 for modal.com upstreams", async () => {
        for (const hostile of ["https://modal.com/v1/chat/completions", "https://foo.modal.com/v1/chat/completions"]) {
            process.env.MODAL_CHAT_URL = hostile;
            process.env.MODAL_PROXY_TOKEN = MODAL_TOKEN;
            expect(resolveModalUpstreamUrl()).toBeNull();
            const fetchFn = vi.fn(async () => jsonUpstream({ ok: true }));
            const handler = createModalServerHandler({
                fetchFn: fetchFn as unknown as typeof fetch,
                limiter: new ModalRateLimiter(1000, 60 * 1000),
            });
            const out = await runServerHandler(handler, JSON.stringify({ model: "attacker" }));
            expect(out.statusCode).toBe(503);
            expect(fetchFn).not.toHaveBeenCalled();
        }
    });

    it("ignores a hostile upstreamUrl override and keeps the resolved upstream", async () => {
        process.env.MODAL_CHAT_URL = MODAL_URL;
        process.env.MODAL_PROXY_TOKEN = MODAL_TOKEN;
        let seenUrl = "";
        const fetchFn = vi.fn(async (url: unknown) => {
            seenUrl = String(url);
            return jsonUpstream({ id: "chatcmpl-override", choices: [{ message: { content: "ok" } }] });
        });
        const handler = createModalServerHandler({
            fetchFn: fetchFn as unknown as typeof fetch,
            upstreamUrl: "https://evil.example/v1/chat/completions",
            limiter: new ModalRateLimiter(1000, 60 * 1000),
        });
        const out = await runServerHandler(handler, JSON.stringify({ model: "attacker" }));
        expect(out.statusCode).toBe(200);
        expect(seenUrl).toBe(MODAL_URL);
    });

    it("returns 503 when the proxy token is missing", async () => {
        process.env.MODAL_CHAT_URL = MODAL_URL;
        const fetchFn = vi.fn(async () => jsonUpstream({ choices: [] }));
        const handler = createModalServerHandler({
            fetchFn: fetchFn as unknown as typeof fetch,
            limiter: new ModalRateLimiter(1000, 60 * 1000),
        });
        const out = await runServerHandler(handler, JSON.stringify({ model: "attacker" }));
        expect(out.statusCode).toBe(503);
        expect(fetchFn).not.toHaveBeenCalled();
    });
});

describe("vite SSE replay", () => {
    it("streams reasoning_content plus DONE through the Vite proxy", async () => {
        const chunks = [
            'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
            "data: [DONE]\n\n",
        ];
        const fetchFn = vi.fn(async () => sseUpstream(chunks));
        const handler = getViteHandler({
            fetchFn: fetchFn as unknown as typeof fetch,
            getAuthHeaders: () => ({ authorization: `Bearer ${MODAL_TOKEN}` }),
            upstreamUrl: MODAL_URL,
            limiter: new ModalRateLimiter(1000, 60 * 1000),
        });
        const out = await runViteHandler(handler, JSON.stringify({ stream: true }));
        expect(out.statusCode).toBe(200);
        expect(out.headers["content-type"]).toBe("text/event-stream");
        expect(out.writes.length).toBeGreaterThanOrEqual(3);
        expect(out.text).toContain("reasoning_content");
        expect(out.text).toContain("[DONE]");
    });
});
