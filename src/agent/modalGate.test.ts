// Modal gate unit tests. Pure predicates only, no live network.

import { describe, expect, it } from "vitest";
import {
    MODAL_MAX_BODY_BYTES,
    MODAL_MAX_MESSAGE_CHARS,
    MODAL_MAX_MESSAGES,
    MODAL_MAX_RESPONSE_BYTES,
    MODAL_MAX_TOKENS,
    MODAL_MAX_TOTAL_MESSAGE_CHARS,
    MODAL_MODEL_ID,
    MODAL_PATH,
    MODAL_RATE_LIMIT_MAX_ENTRIES,
    ModalRateLimiter,
    checkBodySize,
    forceModel,
    isAllowedModalUpstreamUrl,
    isModalDisabled,
    isModalPath,
    isRetryable,
    resolveModalModelId,
    resolveModalUpstreamUrl,
    sanitizeModalMessages,
    toGenericError,
} from "./modalGate";

const MODAL_URL = "https://example-workspace--spark-open.modal.run/v1/chat/completions";

describe("isModalPath", () => {
    it("allows POST to the single pinned path", () => {
        expect(isModalPath("POST", MODAL_PATH)).toBe(true);
    });

    it("allows a trailing slash on the pinned path", () => {
        expect(isModalPath("POST", `${MODAL_PATH}/`)).toBe(true);
    });

    it("rejects non POST methods", () => {
        expect(isModalPath("GET", MODAL_PATH)).toBe(false);
        expect(isModalPath("PUT", MODAL_PATH)).toBe(false);
        expect(isModalPath("OPTIONS", MODAL_PATH)).toBe(false);
    });

    it("rejects other modal paths", () => {
        expect(isModalPath("POST", "/api/modal/models")).toBe(false);
        expect(isModalPath("POST", "/api/modal/chat/completions/extra")).toBe(false);
        expect(isModalPath("POST", "/api/meta/chat/completions")).toBe(false);
        expect(isModalPath("POST", "/api/baseten/chat/completions")).toBe(false);
    });

    it("rejects dot segments and missing urls", () => {
        expect(isModalPath("POST", "/api/modal/../chat/completions")).toBe(false);
        expect(isModalPath("POST", undefined)).toBe(false);
        expect(isModalPath(undefined, MODAL_PATH)).toBe(false);
    });
});

describe("checkBodySize", () => {
    it("accepts bodies up to 64 KiB", () => {
        expect(checkBodySize(0)).toBe(true);
        expect(checkBodySize(MODAL_MAX_BODY_BYTES)).toBe(true);
        expect(MODAL_MAX_BODY_BYTES).toBe(64 * 1024);
    });

    it("rejects bodies over the cap", () => {
        expect(checkBodySize(MODAL_MAX_BODY_BYTES + 1)).toBe(false);
        expect(checkBodySize(Number.NaN)).toBe(false);
        expect(checkBodySize(-1)).toBe(false);
    });
});

describe("forceModel", () => {
    it("overwrites any client model with the pinned id", () => {
        const out = forceModel({ model: "attacker-model", messages: [] }) as Record<string, unknown>;
        expect(out.model).toBe(MODAL_MODEL_ID);
        expect(MODAL_MODEL_ID).toBe("gearflow-chat");
    });

    it("forces n to 1 and temperature to 0", () => {
        const out = forceModel({ model: MODAL_MODEL_ID, n: 4, temperature: 0.9 }) as Record<string, unknown>;
        expect(out.n).toBe(1);
        expect(out.temperature).toBe(0);
    });

    it("caps max_tokens at 700 and keeps smaller values", () => {
        const capped = forceModel({ model: "x", max_tokens: 4096 }) as Record<string, unknown>;
        expect(capped.max_tokens).toBe(MODAL_MAX_TOKENS);
        expect(MODAL_MAX_TOKENS).toBe(700);
        const kept = forceModel({ model: "x", max_tokens: 300 }) as Record<string, unknown>;
        expect(kept.max_tokens).toBe(300);
        const missing = forceModel({ model: "x" }) as Record<string, unknown>;
        expect(missing.max_tokens).toBe(700);
    });

    it("does not mutate the input object", () => {
        const input = { model: "other", n: 2, max_tokens: 100 };
        forceModel(input);
        expect(input.model).toBe("other");
        expect(input.n).toBe(2);
    });

    it("wraps non objects in a pinned envelope", () => {
        const out = forceModel(null) as Record<string, unknown>;
        expect(out.model).toBe(MODAL_MODEL_ID);
        expect(out.n).toBe(1);
    });

    it("resolves the Modal default from the pinned constant without env", () => {
        expect(resolveModalModelId({})).toBe("gearflow-chat");
        expect(resolveModalModelId({ MODAL_MODEL_ID: "" })).toBe("gearflow-chat");
        expect(resolveModalModelId({ MODAL_MODEL_ID: "   " })).toBe("gearflow-chat");
    });

    it("overrides the Modal model from MODAL_MODEL_ID env for renames", () => {
        const out = forceModel({ model: "attacker", n: 9, max_tokens: 4096 }, { MODAL_MODEL_ID: "custom-endpoint" }) as Record<string, unknown>;
        expect(out.model).toBe("custom-endpoint");
        expect(resolveModalModelId({ MODAL_MODEL_ID: "custom-endpoint" })).toBe("custom-endpoint");
    });
});

describe("resolveModalUpstreamUrl", () => {
    it("returns the trimmed URL for a valid Modal URL", () => {
        expect(resolveModalUpstreamUrl({ MODAL_CHAT_URL: MODAL_URL })).toBe(MODAL_URL);
        expect(resolveModalUpstreamUrl({ MODAL_CHAT_URL: `  ${MODAL_URL}  ` })).toBe(MODAL_URL);
        expect(resolveModalUpstreamUrl({ MODAL_CHAT_URL: "https://modal.run/v1/chat/completions" })).toBe(
            "https://modal.run/v1/chat/completions"
        );
        expect(resolveModalUpstreamUrl({ MODAL_CHAT_URL: "https://modal.direct/v1/chat/completions" })).toBe(
            "https://modal.direct/v1/chat/completions"
        );
        expect(
            resolveModalUpstreamUrl({
                MODAL_CHAT_URL: "https://example-workspace--spark-open.modal.direct/v1/chat/completions",
            })
        ).toBe("https://example-workspace--spark-open.modal.direct/v1/chat/completions");
    });

    it("fails closed to null for missing, empty, or hostile values", () => {
        expect(resolveModalUpstreamUrl({})).toBeNull();
        expect(resolveModalUpstreamUrl({ MODAL_CHAT_URL: "" })).toBeNull();
        expect(resolveModalUpstreamUrl({ MODAL_CHAT_URL: "   " })).toBeNull();
        expect(resolveModalUpstreamUrl({ MODAL_CHAT_URL: undefined })).toBeNull();
        for (const bad of [
            "http://example.modal.run/v1/chat/completions",
            "https://evil.example/v1/chat/completions",
            "https://user:pass@example-workspace.modal.run/v1",
            "https://modal.com/v1/chat/completions",
            "https://foo.modal.com/v1/chat/completions",
            "javascript:alert(1)",
            "data:text/plain,hi",
            "ftp://example.modal.run/v1",
            "//example.modal.run/v1",
            `${MODAL_URL}?token=secret`,
            `${MODAL_URL}#secret`,
        ]) {
            expect(resolveModalUpstreamUrl({ MODAL_CHAT_URL: bad })).toBeNull();
        }
    });

    it("rejects modal.com hosts, query strings, and fragments", () => {
        expect(isAllowedModalUpstreamUrl("https://modal.com/v1/chat/completions")).toBe(false);
        expect(isAllowedModalUpstreamUrl("https://foo.modal.com/v1/chat/completions")).toBe(false);
        expect(isAllowedModalUpstreamUrl("https://modal.direct.evil.example/v1/chat/completions")).toBe(false);
        expect(isAllowedModalUpstreamUrl(`${MODAL_URL}?token=secret`)).toBe(false);
        expect(isAllowedModalUpstreamUrl(`${MODAL_URL}#secret`)).toBe(false);
        expect(isAllowedModalUpstreamUrl("https://example-workspace--spark-open.modal.direct/v1/chat/completions?token=secret")).toBe(
            false
        );
    });

    it("still allows bare modal.run serving hosts", () => {
        expect(isAllowedModalUpstreamUrl(MODAL_URL)).toBe(true);
        expect(isAllowedModalUpstreamUrl("https://modal.run/v1/chat/completions")).toBe(true);
    });

    it("allows modal.direct serving hosts and rejects lookalikes", () => {
        expect(isAllowedModalUpstreamUrl("https://modal.direct/v1/chat/completions")).toBe(true);
        expect(isAllowedModalUpstreamUrl("https://example-workspace--spark-open.modal.direct/v1/chat/completions")).toBe(
            true
        );
        expect(isAllowedModalUpstreamUrl("http://example.modal.direct/v1/chat/completions")).toBe(false);
        expect(isAllowedModalUpstreamUrl("https://user:pass@example-workspace.modal.direct/v1")).toBe(false);
        expect(isAllowedModalUpstreamUrl("https://modal.com/v1/chat/completions")).toBe(false);
        expect(isAllowedModalUpstreamUrl("https://foo.modal.com/v1/chat/completions")).toBe(false);
        expect(isAllowedModalUpstreamUrl("https://modal.run.evil.example/v1/chat/completions")).toBe(false);
    });
});

describe("isRetryable", () => {
    it("marks 429 and 5xx as retryable", () => {
        expect(isRetryable(429)).toBe(true);
        expect(isRetryable(500)).toBe(true);
        expect(isRetryable(502)).toBe(true);
        expect(isRetryable(503)).toBe(true);
    });

    it("marks 4xx client errors as final", () => {
        expect(isRetryable(400)).toBe(false);
        expect(isRetryable(401)).toBe(false);
        expect(isRetryable(404)).toBe(false);
    });
});

describe("toGenericError", () => {
    it("keeps status plus the retryable flag", () => {
        expect(toGenericError(429)).toMatchObject({ status: 429, retryable: true });
        expect(toGenericError(503)).toMatchObject({ status: 503, retryable: true });
        expect(toGenericError(404)).toMatchObject({ status: 404, retryable: false });
        expect(toGenericError(401)).toMatchObject({ status: 401, retryable: false });
    });

    it("uses generic messages that never echo upstream detail", () => {
        expect(toGenericError(404).message).toContain("model");
        expect(toGenericError(429).message).toContain("rate limited");
        for (const status of [400, 401, 404, 429, 500, 502, 503]) {
            const msg = toGenericError(status).message;
            expect(msg).not.toContain("sk-");
            expect(msg).not.toContain("Bearer");
            expect(msg.length).toBeGreaterThan(0);
        }
    });
});

describe("ModalRateLimiter", () => {
    it("allows 10 per minute per IP then blocks", () => {
        const limiter = new ModalRateLimiter(10, 60 * 1000);
        const now = 1_000_000;
        for (let i = 0; i < 10; i += 1) {
            expect(limiter.allow("1.2.3.4", now + i)).toBe(true);
        }
        expect(limiter.allow("1.2.3.4", now + 11)).toBe(false);
        expect(limiter.allow("5.6.7.8", now + 11)).toBe(true);
    });

    it("evicts expired entries so idle addresses do not grow the map", () => {
        const limiter = new ModalRateLimiter(10, 60 * 1000);
        const start = 2_000_000;
        for (let i = 0; i < 25; i += 1) {
            limiter.allow(`10.0.0.${i}`, start);
        }
        expect(limiter.size()).toBe(25);
        limiter.allow("10.0.0.99", start + 61 * 1000);
        expect(limiter.size()).toBeLessThan(25);
        expect(limiter.size()).toBeGreaterThan(0);
    });

    it("pins the non stream response cap at 1 MiB", () => {
        expect(MODAL_MAX_RESPONSE_BYTES).toBe(1 * 1024 * 1024);
    });

    it("hard caps entries with LRU eviction under an IP flood", () => {
        const limiter = new ModalRateLimiter(10, 60 * 1000);
        const start = 3_000_000;
        for (let i = 0; i < MODAL_RATE_LIMIT_MAX_ENTRIES + 500; i += 1) {
            limiter.allow(`192.168.1.${i}`, start + i);
        }
        expect(limiter.size()).toBeLessThanOrEqual(MODAL_RATE_LIMIT_MAX_ENTRIES);
    });
});

describe("forceModel allowlist", () => {
    it("strips non allowlisted fields and keeps only messages plus forced values", () => {
        const out = forceModel({
            model: "attacker",
            messages: [{ role: "user", content: "hi" }],
            stream: true,
            tools: [{ type: "function" }],
            tool_choice: "auto",
            top_p: 0.9,
            frequency_penalty: 2,
            extra: "smuggle",
        }) as Record<string, unknown>;
        expect(out.model).toBe(MODAL_MODEL_ID);
        expect(out.n).toBe(1);
        expect(out.temperature).toBe(0);
        expect(out.stream).toBe(true);
        expect(out.messages).toEqual([{ role: "user", content: "hi" }]);
        expect("tools" in out).toBe(false);
        expect("tool_choice" in out).toBe(false);
        expect("top_p" in out).toBe(false);
        expect("extra" in out).toBe(false);
        expect(Object.keys(out).sort()).toEqual(
            ["max_tokens", "messages", "model", "n", "stream", "temperature"].sort()
        );
    });

    it("validates message roles and caps count plus chars", () => {
        const many = Array.from({ length: MODAL_MAX_MESSAGES + 10 }, (_v, i) => ({
            role: i % 2 === 0 ? "user" : "evil",
            content: "x".repeat(MODAL_MAX_MESSAGE_CHARS + 100),
        }));
        const out = forceModel({ messages: many, stream: false }) as unknown as {
            messages: Array<{ role: string; content: string }>;
        };
        expect(out.messages.length).toBeLessThanOrEqual(MODAL_MAX_MESSAGES);
        for (const m of out.messages) {
            expect(["system", "user", "assistant"]).toContain(m.role);
            expect(m.content.length).toBeLessThanOrEqual(MODAL_MAX_MESSAGE_CHARS);
        }
        const total = out.messages.reduce((n, m) => n + m.content.length, 0);
        expect(total).toBeLessThanOrEqual(MODAL_MAX_TOTAL_MESSAGE_CHARS);
    });

    it("drops non string content and over budget totals", () => {
        expect(sanitizeModalMessages("nope")).toEqual([]);
        expect(sanitizeModalMessages([{ role: "user", content: 123 }])).toEqual([]);
        const big = [
            { role: "user", content: "a".repeat(MODAL_MAX_TOTAL_MESSAGE_CHARS) },
            { role: "user", content: "b".repeat(100) },
        ];
        const sanitized = sanitizeModalMessages(big);
        const total = sanitized.reduce((n, m) => n + m.content.length, 0);
        expect(total).toBeLessThanOrEqual(MODAL_MAX_TOTAL_MESSAGE_CHARS);
    });
});
