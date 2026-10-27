// Baseten client tests. Fake fetch only, zero live calls.

import { describe, expect, it, vi } from "vitest";
import {
    BASETEN_RETRY_DEFAULT_MS,
    BasetenClient,
    BasetenError,
    estimateBasetenCost,
    extractActionJson,
    retryDelayMs,
} from "./basetenClient";
import { BASETEN_MODEL_ID } from "./basetenGate";
import type { BasetenMessage } from "./basetenClient";

const MESSAGES: BasetenMessage[] = [{ role: "user", content: "propose a spec" }];

function jsonResponse(payload: unknown, init: { status?: number; retryAfter?: string | null } = {}): Response {
    const status = init.status ?? 200;
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name: string) => (name.toLowerCase() === "retry-after" ? (init.retryAfter ?? null) : null) },
        json: async () => payload,
        text: async () => JSON.stringify(payload),
        body: null,
    } as unknown as Response;
}

function chatPayload(text: string, usage = { prompt_tokens: 800, completion_tokens: 300 }): unknown {
    return {
        choices: [{ message: { content: text, reasoning_content: "" }, finish_reason: "stop" }],
        usage,
    };
}

function sseResponse(chunks: string[]): Response {
    const encoder = new TextEncoder();
    const parts = chunks.map((c) => encoder.encode(c));
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
        },
    });
    return {
        ok: true,
        status: 200,
        headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "text/event-stream" : null) },
        json: async () => {
            throw new Error("streaming body has no JSON");
        },
        text: async () => chunks.join(""),
        body,
    } as unknown as Response;
}

describe("chat success envelope", () => {
    it("returns text plus usage plus cost and reports the eval hook", async () => {
        const seen: string[] = [];
        const fetchFn = vi.fn(async (_url: unknown, init: unknown) => {
            seen.push(String((init as { body?: unknown }).body));
            return jsonResponse(chatPayload('{"kind":"spec","reynolds":200000}'));
        });
        const evals: Array<{ model: string; inputTokens: number; outputTokens: number; costUsd: number }> = [];
        const client = new BasetenClient({
            fetchFn: fetchFn as unknown as typeof fetch,
            offline: false,
            onEval: (p) => {
                evals.push({ model: p.model, inputTokens: p.inputTokens, outputTokens: p.outputTokens, costUsd: p.costUsd });
            },
        });
        const result = await client.chat(MESSAGES);
        expect(result.model).toBe(BASETEN_MODEL_ID);
        expect(result.action).toMatchObject({ kind: "spec" });
        expect(result.usage.inputTokens).toBe(800);
        expect(result.usage.outputTokens).toBe(300);
        expect(result.costUsd).toBeCloseTo(0.002275, 6);
        expect(JSON.parse(seen[0] as string).model).toBe(BASETEN_MODEL_ID);
        expect(JSON.parse(seen[0] as string).n).toBe(1);
        expect(evals).toHaveLength(1);
        expect(evals[0].model).toBe(BASETEN_MODEL_ID);
        expect(evals[0].costUsd).toBeCloseTo(0.002275, 6);
    });
});

describe("extractActionJson", () => {
    it("pulls the fenced action-json block out of prose", () => {
        const text = 'Here is the plan\n```action-json\n{"kind":"chat","reply":"hi"}\n```\nDone';
        expect(extractActionJson(text)).toMatchObject({ kind: "chat" });
    });

    it("falls back to raw JSON and throws validation on prose", () => {
        expect(extractActionJson('{"kind":"spec"}')).toMatchObject({ kind: "spec" });
        expect(() => extractActionJson("just some words")).toThrow(BasetenError);
        try {
            extractActionJson("just some words");
        } catch (e) {
            expect((e as BasetenError).code).toBe("validation");
        }
    });
});

describe("streamChat DONE accumulation", () => {
    it("accumulates content plus reasoning deltas across chunk boundaries", async () => {
        const full =
            'data: {"choices":[{"delta":{"content":"hel"},"finish_reason":null}]}\n\n' +
            'data: {"choices":[{"delta":{"reasoning_content":"lo"},"finish_reason":null}]}\n\n' +
            'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}],"usage":{"prompt_tokens":800,"completion_tokens":300}}\n\n' +
            "data: [DONE]\n\n";
        const mid = Math.floor(full.length * 0.4);
        const cut = full.indexOf("hel") + 2;
        const fetchFn = vi.fn(async () => sseResponse([full.slice(0, cut), full.slice(cut, mid), full.slice(mid)]));
        const client = new BasetenClient({ fetchFn: fetchFn as unknown as typeof fetch, offline: false });
        const deltas: string[] = [];
        let finalText = "";
        let doneSeen = false;
        for await (const chunk of client.streamChat(MESSAGES)) {
            if (chunk.delta.length > 0) deltas.push(chunk.delta);
            finalText = chunk.text;
            if (chunk.done) doneSeen = true;
        }
        expect(deltas.join("")).toBe("hello world");
        expect(finalText).toBe("hello world");
        expect(doneSeen).toBe(true);
    });
});

describe("abort and timeout", () => {
    it("surfaces abort without retrying when the signal is already aborted", async () => {
        const fetchFn = vi.fn(async () => jsonResponse(chatPayload("{}")));
        const client = new BasetenClient({ fetchFn: fetchFn as unknown as typeof fetch, offline: false });
        const controller = new AbortController();
        controller.abort();
        await expect(client.chat(MESSAGES, { signal: controller.signal })).rejects.toMatchObject({ code: "abort" });
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it("retries once on timeout then fails", async () => {
        let calls = 0;
        const fetchFn = vi.fn(async (_url: unknown, init: unknown) => {
            calls += 1;
            const signal = (init as { signal?: AbortSignal }).signal;
            return new Promise<Response>((_resolve, reject) => {
                signal?.addEventListener("abort", () => {
                    const err = new Error("aborted");
                    err.name = "AbortError";
                    reject(err);
                });
            });
        });
        const client = new BasetenClient({ fetchFn: fetchFn as unknown as typeof fetch, offline: false });
        await expect(client.chat(MESSAGES, { timeoutMs: 20 })).rejects.toMatchObject({ code: "timeout" });
        expect(calls).toBe(2);
    });
});

describe("error mapping", () => {
    it("maps 404 to a generic model error without the upstream body", async () => {
        const fetchFn = vi.fn(async () =>
            jsonResponse({ error: { message: "please check model", code: "secret-detail-xyz" } }, { status: 404 })
        );
        const client = new BasetenClient({ fetchFn: fetchFn as unknown as typeof fetch, offline: false });
        let err: BasetenError | null = null;
        try {
            await client.chat(MESSAGES);
        } catch (e) {
            err = e as BasetenError;
        }
        expect(err).toBeInstanceOf(BasetenError);
        expect(err?.status).toBe(404);
        expect(err?.retryable).toBe(false);
        expect(err?.message).toContain("model");
        expect(err?.message ?? "").not.toContain("secret-detail-xyz");
    });

    it("honors retry-after and retries 429 once", async () => {
        let calls = 0;
        const fetchFn = vi.fn(async () => {
            calls += 1;
            if (calls === 1) return jsonResponse({ error: "busy" }, { status: 429, retryAfter: "0" });
            return jsonResponse(chatPayload('{"kind":"chat"}'));
        });
        const client = new BasetenClient({ fetchFn: fetchFn as unknown as typeof fetch, offline: false });
        const result = await client.chat(MESSAGES);
        expect(result.text).toContain("chat");
        expect(calls).toBe(2);
    });

    it("maps the no key 503 path to offline", async () => {
        const fetchFn = vi.fn(async () => jsonResponse({ error: "Baseten service unavailable" }, { status: 503 }));
        const client = new BasetenClient({ fetchFn: fetchFn as unknown as typeof fetch, offline: false });
        await expect(client.chat(MESSAGES, { timeoutMs: 50 })).rejects.toMatchObject({ code: "offline" });
    });
});

describe("usage plus cost reporting", () => {
    it("prices 800 in plus 300 out near $0.0023", () => {
        expect(estimateBasetenCost(800, 300)).toBeCloseTo(0.002275, 6);
    });

    it("prices cached input at the reduced rate", () => {
        const full = estimateBasetenCost(800, 300, 0);
        const cached = estimateBasetenCost(800, 300, 800);
        expect(cached).toBeLessThan(full);
        expect(cached).toBeCloseTo((800 * 0.15) / 1_000_000 + (300 * 4.25) / 1_000_000, 9);
    });

    it("clamps cached tokens to input when cached exceeds input", () => {
        const cost = estimateBasetenCost(100, 50, 500);
        expect(cost).toBeCloseTo((100 * 0.15) / 1_000_000 + (50 * 4.25) / 1_000_000, 9);
    });
});

describe("retry delay parsing", () => {
    it("parses delay seconds and clamps an HTTP date to the cap", () => {
        expect(retryDelayMs("2")).toBe(2000);
        expect(retryDelayMs("0")).toBe(0);
        const future = new Date(Date.now() + 60_000).toUTCString();
        expect(retryDelayMs(future)).toBeLessThanOrEqual(8000);
        expect(retryDelayMs(future)).toBeGreaterThan(0);
        expect(retryDelayMs("not-a-date")).toBe(BASETEN_RETRY_DEFAULT_MS);
        expect(retryDelayMs(null)).toBe(BASETEN_RETRY_DEFAULT_MS);
    });

    it("waits a nonzero bounded backoff before retrying when retry-after is absent", async () => {
        let calls = 0;
        const fetchFn = vi.fn(async () => {
            calls += 1;
            if (calls === 1) return jsonResponse({ error: "busy" }, { status: 429, retryAfter: null });
            return jsonResponse(chatPayload('{"kind":"chat"}'));
        });
        const client = new BasetenClient({ fetchFn: fetchFn as unknown as typeof fetch, offline: false });
        const start = Date.now();
        const result = await client.chat(MESSAGES);
        const elapsed = Date.now() - start;
        expect(result.text).toContain("chat");
        expect(calls).toBe(2);
        expect(elapsed).toBeGreaterThanOrEqual(BASETEN_RETRY_DEFAULT_MS - 50);
    });
});

describe("extractActionJson fence fallback", () => {
    it("falls through a malformed action-json fence to the next valid one", () => {
        const text =
            'first try\n```action-json\n{not valid json\n```\nsecond try\n```action-json\n{"kind":"spec","reynolds":200000}\n```';
        expect(extractActionJson(text)).toMatchObject({ kind: "spec" });
    });
});

describe("stream timeout and abort", () => {
    it("times out a stalled stream that stops mid token", async () => {
        const encoder = new TextEncoder();
        const firstChunk = encoder.encode('data: {"choices":[{"delta":{"content":"hel"},"finish_reason":null}]}\n\n');
        const hanging = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(firstChunk);
            },
        });
        const fetchFn = vi.fn(async () => ({
            ok: true,
            status: 200,
            headers: { get: () => "text/event-stream" },
            json: async () => {
                throw new Error("streaming body has no JSON");
            },
            text: async () => "",
            body: hanging,
        } as unknown as Response));
        const client = new BasetenClient({ fetchFn: fetchFn as unknown as typeof fetch, offline: false });
        const gen = client.streamChat(MESSAGES, { timeoutMs: 60 });
        const first = await gen.next();
        expect(first.done).toBe(false);
        await expect(gen.next()).rejects.toMatchObject({ code: "timeout" });
    });

    it("aborts a hung stream read when the caller disconnects", async () => {
        const hanging = new ReadableStream<Uint8Array>({ start() {} });
        const fetchFn = vi.fn(async () => ({
            ok: true,
            status: 200,
            headers: { get: () => "text/event-stream" },
            json: async () => {
                throw new Error("streaming body has no JSON");
            },
            text: async () => "",
            body: hanging,
        } as unknown as Response));
        const client = new BasetenClient({ fetchFn: fetchFn as unknown as typeof fetch, offline: false });
        const controller = new AbortController();
        const gen = client.streamChat(MESSAGES, { signal: controller.signal, timeoutMs: 5000 });
        const pending = gen.next();
        controller.abort();
        await expect(pending).rejects.toMatchObject({ code: "abort" });
    });
});
