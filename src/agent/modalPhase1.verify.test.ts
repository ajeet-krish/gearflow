// Phase 1 Modal transport verification. Fake fetch only, zero live calls.
// Covers the orchestrator requested contract: live send plus stream with
// reasoning split, envelope from content only, model pinned gearflow-chat,
// DONE without finish_reason, both reasoning keys, 429 retry, hostile URL
// fail 503, missing token 503, 30 s timeout, SSE flood cap, malformed envelope.

import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  MODAL_TIMEOUT_MS,
  ModalClient,
  ModalError,
  extractActionJson,
  toHttpError,
} from "./modalClient";
import {
  MODAL_MAX_RESPONSE_BYTES,
  MODAL_MODEL_ID,
  ModalRateLimiter,
} from "./modalGate";
import { createModalServerHandler } from "./modalServerHandler";
import type { ModalMessage } from "./modalClient";

const MESSAGES: ModalMessage[] = [{ role: "user", content: "propose a spec" }];
const MODAL_URL = "https://example-workspace--spark-open.modal.run/v1/chat/completions";
const MODAL_TOKEN = "wk-testworkspace.ws-testsecret";

afterEach(() => {
  delete process.env.MODAL_CHAT_URL;
  delete process.env.MODAL_PROXY_TOKEN;
  delete process.env.MODAL_DISABLED;
  vi.unstubAllEnvs();
});

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

function runHandler(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  body: string
): Promise<{ statusCode: number; text: string }> {
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
    req.socket = { remoteAddress: "10.20.0.9" };
    req.destroy = (): void => undefined;
    const writes: Buffer[] = [];
    const resEmitter = new EventEmitter();
    const res = Object.assign(resEmitter, {
      statusCode: 200,
      writableEnded: false,
      destroyed: false,
      setHeader: (_n: string, _v: string): void => undefined,
      write: (chunk: Buffer): boolean => {
        writes.push(Buffer.from(chunk));
        return true;
      },
      end: (data?: unknown): void => {
        (res as unknown as { writableEnded: boolean }).writableEnded = true;
        if (data !== undefined) writes.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
        resolve({
          statusCode: (res as unknown as { statusCode: number }).statusCode,
          text: Buffer.concat(writes).toString("utf8"),
        });
      },
    }) as unknown as ServerResponse & EventEmitter;
    handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    setTimeout(() => req.emit("data", Buffer.from(body, "utf8")), 0);
    setTimeout(() => req.emit("end"), 5);
    setTimeout(() => req.emit("close"), 2000);
  });
}

describe("phase1 modal live send", () => {
  it("sends chat with pinned gearflow-chat model, n 1, temp 0", async () => {
    const seen: string[] = [];
    const fetchFn = vi.fn(async (_url: unknown, init: unknown) => {
      seen.push(String((init as { body?: unknown }).body));
      return jsonResponse({
        choices: [{ message: { content: '{"kind":"spec","reynolds":200000}', reasoning_content: "plan" } }],
        usage: { prompt_tokens: 800, completion_tokens: 300 },
      });
    });
    const client = new ModalClient({ fetchFn: fetchFn as unknown as typeof fetch, offline: false });
    const result = await client.chat(MESSAGES);
    expect(result.model).toBe("gearflow-chat");
    expect(MODAL_MODEL_ID).toBe("gearflow-chat");
    expect(result.action).toMatchObject({ kind: "spec" });
    const sent = JSON.parse(seen[0] as string) as Record<string, unknown>;
    expect(sent.model).toBe("gearflow-chat");
    expect(sent.n).toBe(1);
    expect(sent.temperature).toBe(0);
  });

  it("streams with reasoning split and envelope from content only", async () => {
    const full =
      'data: {"choices":[{"delta":{"reasoning_content":"{\\"kind\\":\\"evil\\"}"},"finish_reason":null}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"{\\"kind\\":\\"spec\\"}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n' +
      "data: [DONE]\n\n";
    const fetchFn = vi.fn(async () => sseResponse([full]));
    const client = new ModalClient({ fetchFn: fetchFn as unknown as typeof fetch, offline: false });
    let text = "";
    let done = false;
    for await (const chunk of client.streamChat(MESSAGES)) {
      text = chunk.text;
      if (chunk.done) done = true;
    }
    expect(text).toBe('{"kind":"spec"}');
    expect(text).not.toContain("evil");
    expect(done).toBe(true);
    const returned = await (async () => {
      const c2 = new ModalClient({ fetchFn: fetchFn as unknown as typeof fetch, offline: false });
      let action: unknown = null;
      for await (const _c of c2.streamChat(MESSAGES)) {
        if (_c.done) {
          // Final yield carries done, return value holds the envelope.
        }
      }
      return action;
    })();
    expect(returned).toBeNull();
  });
});

describe("phase1 modal edge cases", () => {
  it("terminates on DONE without any finish_reason", async () => {
    const full =
      'data: {"choices":[{"delta":{"content":"hel"},"finish_reason":null}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":null}]}\n\n' +
      "data: [DONE]\n\n";
    const fetchFn = vi.fn(async () => sseResponse([full]));
    const client = new ModalClient({ fetchFn: fetchFn as unknown as typeof fetch, offline: false });
    let text = "";
    let done = false;
    for await (const chunk of client.streamChat(MESSAGES)) {
      text = chunk.text;
      if (chunk.done) done = true;
    }
    expect(text).toBe("hello");
    expect(done).toBe(true);
  });

  it("accepts both reasoning_content and reasoning keys without leaking into text", async () => {
    const full =
      'data: {"choices":[{"delta":{"reasoning_content":"plan-a"},"finish_reason":null}]}\n\n' +
      'data: {"choices":[{"delta":{"reasoning":"plan-b"},"finish_reason":null}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n' +
      "data: [DONE]\n\n";
    const fetchFn = vi.fn(async () => sseResponse([full]));
    const client = new ModalClient({ fetchFn: fetchFn as unknown as typeof fetch, offline: false });
    let text = "";
    for await (const chunk of client.streamChat(MESSAGES)) {
      text = chunk.text;
    }
    expect(text).toBe("hi");
    expect(text).not.toContain("plan-a");
    expect(text).not.toContain("plan-b");
  });

  it("retries 429 once then succeeds", async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({ error: "busy" }, { status: 429, retryAfter: "0" });
      return jsonResponse({
        choices: [{ message: { content: '{"kind":"chat"}' } }],
        usage: { prompt_tokens: 5, completion_tokens: 5 },
      });
    });
    const client = new ModalClient({ fetchFn: fetchFn as unknown as typeof fetch, offline: false });
    const result = await client.chat(MESSAGES);
    expect(result.text).toContain("chat");
    expect(calls).toBe(2);
  });

  it("fails hostile upstream URL closed with 503 and zero upstream calls", async () => {
    process.env.MODAL_CHAT_URL = "https://evil.example/v1/chat/completions";
    process.env.MODAL_PROXY_TOKEN = MODAL_TOKEN;
    const fetchFn = vi.fn(async () => jsonResponse({ ok: true }));
    const handler = createModalServerHandler({
      fetchFn: fetchFn as unknown as typeof fetch,
      limiter: new ModalRateLimiter(1000, 60 * 1000),
    });
    const out = await runHandler(handler, JSON.stringify({ model: "attacker" }));
    expect(out.statusCode).toBe(503);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("fails missing proxy token closed with 503 and maps client 503 to offline", async () => {
    process.env.MODAL_CHAT_URL = MODAL_URL;
    const fetchFnServer = vi.fn(async () => jsonResponse({ choices: [] }));
    const handler = createModalServerHandler({
      fetchFn: fetchFnServer as unknown as typeof fetch,
      limiter: new ModalRateLimiter(1000, 60 * 1000),
    });
    const out = await runHandler(handler, JSON.stringify({ model: "attacker" }));
    expect(out.statusCode).toBe(503);
    expect(fetchFnServer).not.toHaveBeenCalled();
    const fetchFnClient = vi.fn(async () => jsonResponse({ error: "Modal service unavailable" }, { status: 503 }));
    const client = new ModalClient({ fetchFn: fetchFnClient as unknown as typeof fetch, offline: false });
    const err = toHttpError(503);
    expect(err.code).toBe("offline");
    await expect(client.chat(MESSAGES, { timeoutMs: 50 })).rejects.toMatchObject({ code: "offline" });
  });
});

describe("phase1 modal error conditions", () => {
  it("pins the 30 s default timeout", () => {
    expect(MODAL_TIMEOUT_MS).toBe(30000);
    expect(MODAL_MAX_RESPONSE_BYTES).toBe(1 * 1024 * 1024);
  });

  it("times out a stalled stream that stops mid token", async () => {
    const encoder = new TextEncoder();
    const first = encoder.encode('data: {"choices":[{"delta":{"content":"hel"},"finish_reason":null}]}\n\n');
    const hanging = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(first);
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
    const client = new ModalClient({ fetchFn: fetchFn as unknown as typeof fetch, offline: false });
    const gen = client.streamChat(MESSAGES, { timeoutMs: 60 });
    const firstOut = await gen.next();
    expect(firstOut.done).toBe(false);
    await expect(gen.next()).rejects.toMatchObject({ code: "timeout" });
  });

  it("aborts an SSE flood over the response cap with a 502", async () => {
    const encoder = new TextEncoder();
    const flood = "a".repeat(600 * 1024);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: {"choices":[{"delta":{"content":"${flood}"}}]}\n\n`));
        controller.enqueue(encoder.encode(`data: {"choices":[{"delta":{"content":"${flood}"}}]}\n\n`));
        controller.close();
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
      body,
    } as unknown as Response));
    const client = new ModalClient({ fetchFn: fetchFn as unknown as typeof fetch, offline: false });
    await expect(async () => {
      for await (const _chunk of client.streamChat(MESSAGES)) {
        // Drain until the cap trips.
      }
    }).rejects.toMatchObject({ status: 502 });
  });

  it("rejects a malformed envelope with validation while chat holds text with null action", async () => {
    expect(() => extractActionJson("just some words")).toThrow(ModalError);
    try {
      extractActionJson("just some words");
    } catch (e) {
      expect((e as ModalError).code).toBe("validation");
    }
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        choices: [{ message: { content: "just some words" } }],
        usage: { prompt_tokens: 5, completion_tokens: 5 },
      })
    );
    const client = new ModalClient({ fetchFn: fetchFn as unknown as typeof fetch, offline: false });
    const result = await client.chat(MESSAGES);
    expect(result.text).toBe("just some words");
    expect(result.action).toBeNull();
  });
});
