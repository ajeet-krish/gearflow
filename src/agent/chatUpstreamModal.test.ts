// Modal upstream cutover tests. Resolver plus fake Modal upstream replay
// through both the server handler and the Vite proxy. Zero live calls.

import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
    BASETEN_MODEL_ID,
    BASETEN_UPSTREAM_URL,
    BasetenRateLimiter,
    MODAL_MODEL_ID,
    forceModel,
    isAllowedChatUpstreamUrl,
    resolveChatUpstream,
    resolveChatUpstreamFromEnv,
    resolveModalModelId,
} from "./basetenGate";
import { createBasetenServerHandler } from "./basetenServerHandler";
import { basetenProxy } from "../../vite.config";
import type { Connect } from "vite";

const MODAL_URL = "https://example-workspace--spark-open.modal.run/v1/chat/completions";
const MODAL_TOKEN = "wk-testworkspace.ws-testsecret";

beforeEach(() => {
    delete process.env.CHAT_UPSTREAM;
    delete process.env.MODAL_CHAT_URL;
    delete process.env.MODAL_MODEL_ID;
    delete process.env.MODAL_PROXY_TOKEN;
    delete process.env.BASETEN_API_KEY;
    delete process.env.BASETEN_DISABLED;
});

afterEach(() => {
    delete process.env.CHAT_UPSTREAM;
    delete process.env.MODAL_CHAT_URL;
    delete process.env.MODAL_MODEL_ID;
    delete process.env.MODAL_PROXY_TOKEN;
    delete process.env.BASETEN_API_KEY;
    delete process.env.BASETEN_DISABLED;
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
        req.url = "/api/baseten/chat/completions";
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

function getViteHandler(deps: Parameters<typeof basetenProxy>[0]): Connect.NextHandleFunction {
    const plugin = basetenProxy(deps);
    const seen: Connect.NextHandleFunction[] = [];
    plugin.configureServer({ middlewares: { use: (h: Connect.NextHandleFunction) => seen.push(h) } } as never);
    if (seen.length !== 1) throw new Error("expected one baseten middleware");
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
        req.url = "/api/baseten/chat/completions";
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

describe("resolveChatUpstream", () => {
    it("defaults to baseten when kind is unset", () => {
        expect(resolveChatUpstream(undefined, undefined)).toEqual({ kind: "baseten", url: BASETEN_UPSTREAM_URL });
        expect(resolveChatUpstream("", undefined)).toEqual({ kind: "baseten", url: BASETEN_UPSTREAM_URL });
    });

    it("selects modal with a valid Modal URL", () => {
        expect(resolveChatUpstream("modal", MODAL_URL)).toEqual({ kind: "modal", url: MODAL_URL });
    });

    it("falls back to baseten for invalid kinds and hostile URLs", () => {
        expect(resolveChatUpstream("bogus", MODAL_URL).kind).toBe("baseten");
        expect(resolveChatUpstream("modal", undefined).kind).toBe("baseten");
        expect(resolveChatUpstream("modal", "").kind).toBe("baseten");
        expect(resolveChatUpstream("modal", "http://example.modal.run/v1/chat/completions").kind).toBe("baseten");
        expect(resolveChatUpstream("modal", "https://evil.example/v1/chat/completions").kind).toBe("baseten");
        expect(resolveChatUpstream("modal", "https://user:pass@example-workspace.modal.run/v1").kind).toBe("baseten");
        for (const bad of [
            "javascript:alert(1)",
            "data:text/plain,hi",
            "ftp://example.modal.run/v1",
            "//example.modal.run/v1",
        ]) {
            expect(resolveChatUpstream("modal", bad).kind).toBe("baseten");
        }
    });
});

describe("forceModel upstream kind", () => {
    it("keeps the Baseten pin by default and for invalid kinds", () => {
        expect((forceModel({ model: "x" }) as Record<string, unknown>).model).toBe(BASETEN_MODEL_ID);
        expect((forceModel({ model: "x" }, "bogus") as Record<string, unknown>).model).toBe(BASETEN_MODEL_ID);
    });

    it("pins the Modal endpoint name by default when kind is modal", () => {
        const out = forceModel({ model: "attacker", n: 9, max_tokens: 4096 }, "modal") as Record<string, unknown>;
        expect(out.model).toBe(MODAL_MODEL_ID);
        expect(MODAL_MODEL_ID).toBe("gearflow-chat");
        expect(out.n).toBe(1);
        expect(out.max_tokens).toBe(700);
    });

    it("resolves the Modal default from the pinned constant without env", () => {
        expect(resolveModalModelId({})).toBe("gearflow-chat");
        expect(resolveModalModelId({ MODAL_MODEL_ID: "" })).toBe("gearflow-chat");
        expect(resolveModalModelId({ MODAL_MODEL_ID: "   " })).toBe("gearflow-chat");
    });

    it("overrides the Modal model from MODAL_MODEL_ID env for renames", () => {
        vi.stubEnv("MODAL_MODEL_ID", "custom-endpoint");
        const out = forceModel({ model: "attacker", n: 9, max_tokens: 4096 }, "modal") as Record<string, unknown>;
        expect(out.model).toBe("custom-endpoint");
        expect(resolveModalModelId()).toBe("custom-endpoint");
        vi.unstubAllEnvs();
        const backToDefault = forceModel({ model: "attacker" }, "modal") as Record<string, unknown>;
        expect(backToDefault.model).toBe("gearflow-chat");
    });

    it("keeps the Baseten pin when MODAL_MODEL_ID env is set", () => {
        vi.stubEnv("MODAL_MODEL_ID", "custom-endpoint");
        expect((forceModel({ model: "x" }) as Record<string, unknown>).model).toBe(BASETEN_MODEL_ID);
        expect((forceModel({ model: "x" }, "bogus") as Record<string, unknown>).model).toBe(BASETEN_MODEL_ID);
        expect(BASETEN_MODEL_ID).toBe("meta-models/muse-spark-open-1026");
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
        const handler = createBasetenServerHandler({
            fetchFn: fetchFn as unknown as typeof fetch,
            getAuthHeaders: () => ({ authorization: `Bearer ${MODAL_TOKEN}` }),
            upstreamUrl: MODAL_URL,
            chatKind: "modal",
            limiter: new BasetenRateLimiter(1000, 60 * 1000),
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
        const handler = createBasetenServerHandler({
            fetchFn: fetchFn as unknown as typeof fetch,
            getAuthHeaders: () => ({ authorization: `Bearer ${MODAL_TOKEN}` }),
            upstreamUrl: MODAL_URL,
            chatKind: "modal",
            limiter: new BasetenRateLimiter(1000, 60 * 1000),
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
            chatKind: "modal",
            limiter: new BasetenRateLimiter(1000, 60 * 1000),
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
        process.env.CHAT_UPSTREAM = "modal";
        process.env.MODAL_CHAT_URL = MODAL_URL;
        process.env.MODAL_PROXY_TOKEN = MODAL_TOKEN;
        expect(resolveChatUpstreamFromEnv()).toEqual({ kind: "modal", url: MODAL_URL });
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
        const handler = createBasetenServerHandler({
            fetchFn: fetchFn as unknown as typeof fetch,
            limiter: new BasetenRateLimiter(1000, 60 * 1000),
        });
        const out = await runServerHandler(handler, JSON.stringify({ model: "attacker", stream: false }));
        expect(out.statusCode).toBe(200);
        expect(seenUrl).toBe(MODAL_URL);
        expect(seenAuth).toBe(`Bearer ${MODAL_TOKEN}`);
        expect((JSON.parse(seenBody) as Record<string, unknown>).model).toBe(MODAL_MODEL_ID);
    });

    it("resolves Modal from env through the shared helper in the Vite proxy", async () => {
        process.env.CHAT_UPSTREAM = "modal";
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
            limiter: new BasetenRateLimiter(1000, 60 * 1000),
        });
        const out = await runViteHandler(handler, JSON.stringify({ model: "attacker", stream: false }));
        expect(out.statusCode).toBe(200);
        expect(seenUrl).toBe(MODAL_URL);
        expect(seenAuth).toBe(`Bearer ${MODAL_TOKEN}`);
        expect((JSON.parse(seenBody) as Record<string, unknown>).model).toBe(MODAL_MODEL_ID);
    });

    it("falls back to Baseten for a hostile MODAL_CHAT_URL at the handler level", async () => {
        process.env.CHAT_UPSTREAM = "modal";
        process.env.MODAL_CHAT_URL = "https://evil.example/v1/chat/completions";
        process.env.BASETEN_API_KEY = "base-test-key";
        let seenUrl = "";
        let seenBody = "";
        const fetchFn = vi.fn(async (url: unknown, init: unknown) => {
            seenUrl = String(url);
            seenBody = String((init as { body?: unknown }).body ?? "");
            return jsonUpstream({ id: "chatcmpl-fallback", choices: [{ message: { content: "ok" } }] });
        });
        const handler = createBasetenServerHandler({
            fetchFn: fetchFn as unknown as typeof fetch,
            limiter: new BasetenRateLimiter(1000, 60 * 1000),
        });
        const out = await runServerHandler(handler, JSON.stringify({ model: "attacker" }));
        expect(out.statusCode).toBe(200);
        expect(seenUrl).toBe(BASETEN_UPSTREAM_URL);
        expect((JSON.parse(seenBody) as Record<string, unknown>).model).toBe(BASETEN_MODEL_ID);
    });

    it("ignores a hostile upstreamUrl override and keeps the resolved upstream", async () => {
        process.env.BASETEN_API_KEY = "base-test-key";
        let seenUrl = "";
        const fetchFn = vi.fn(async (url: unknown) => {
            seenUrl = String(url);
            return jsonUpstream({ id: "chatcmpl-override", choices: [{ message: { content: "ok" } }] });
        });
        const handler = createBasetenServerHandler({
            fetchFn: fetchFn as unknown as typeof fetch,
            upstreamUrl: "https://evil.example/v1/chat/completions",
            chatKind: "modal",
            limiter: new BasetenRateLimiter(1000, 60 * 1000),
        });
        const out = await runServerHandler(handler, JSON.stringify({ model: "attacker" }));
        expect(out.statusCode).toBe(200);
        expect(seenUrl).toBe(BASETEN_UPSTREAM_URL);
    });

    it("returns 503 when Modal is selected without a proxy token", async () => {
        process.env.CHAT_UPSTREAM = "modal";
        process.env.MODAL_CHAT_URL = MODAL_URL;
        const fetchFn = vi.fn(async () => jsonUpstream({ choices: [] }));
        const handler = createBasetenServerHandler({
            fetchFn: fetchFn as unknown as typeof fetch,
            limiter: new BasetenRateLimiter(1000, 60 * 1000),
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
            chatKind: "modal",
            limiter: new BasetenRateLimiter(1000, 60 * 1000),
        });
        const out = await runViteHandler(handler, JSON.stringify({ stream: true }));
        expect(out.statusCode).toBe(200);
        expect(out.headers["content-type"]).toBe("text/event-stream");
        expect(out.writes.length).toBeGreaterThanOrEqual(3);
        expect(out.text).toContain("reasoning_content");
        expect(out.text).toContain("[DONE]");
    });
});

describe("modal allowlist hardening", () => {
    it("rejects modal.com hosts, query strings, and fragments", () => {
        expect(isAllowedChatUpstreamUrl("modal", "https://modal.com/v1/chat/completions")).toBe(false);
        expect(isAllowedChatUpstreamUrl("modal", "https://foo.modal.com/v1/chat/completions")).toBe(false);
        expect(isAllowedChatUpstreamUrl("modal", `${MODAL_URL}?token=secret`)).toBe(false);
        expect(isAllowedChatUpstreamUrl("modal", `${MODAL_URL}#secret`)).toBe(false);
        expect(resolveChatUpstream("modal", "https://foo.modal.com/v1").kind).toBe("baseten");
        expect(resolveChatUpstream("modal", `${MODAL_URL}?token=secret`).kind).toBe("baseten");
        expect(resolveChatUpstream("modal", `${MODAL_URL}#secret`).kind).toBe("baseten");
    });

    it("still allows bare modal.run serving hosts", () => {
        expect(isAllowedChatUpstreamUrl("modal", MODAL_URL)).toBe(true);
        expect(isAllowedChatUpstreamUrl("modal", "https://modal.run/v1/chat/completions")).toBe(true);
    });
});
