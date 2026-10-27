// Baseten gate unit tests. Pure predicates only, no live network.

import { describe, expect, it } from "vitest";
import {
    BASETEN_MAX_BODY_BYTES,
    BASETEN_MAX_RESPONSE_BYTES,
    BASETEN_MAX_TOKENS,
    BASETEN_MODEL_ID,
    BASETEN_PATH,
    BasetenRateLimiter,
    checkBodySize,
    forceModel,
    isBasetenPath,
    isRetryable,
    toGenericError,
} from "./basetenGate";

describe("isBasetenPath", () => {
    it("allows POST to the single pinned path", () => {
        expect(isBasetenPath("POST", BASETEN_PATH)).toBe(true);
    });

    it("allows a trailing slash on the pinned path", () => {
        expect(isBasetenPath("POST", `${BASETEN_PATH}/`)).toBe(true);
    });

    it("rejects non POST methods", () => {
        expect(isBasetenPath("GET", BASETEN_PATH)).toBe(false);
        expect(isBasetenPath("PUT", BASETEN_PATH)).toBe(false);
        expect(isBasetenPath("OPTIONS", BASETEN_PATH)).toBe(false);
    });

    it("rejects other baseten paths", () => {
        expect(isBasetenPath("POST", "/api/baseten/models")).toBe(false);
        expect(isBasetenPath("POST", "/api/baseten/chat/completions/extra")).toBe(false);
        expect(isBasetenPath("POST", "/api/meta/chat/completions")).toBe(false);
    });

    it("rejects dot segments and missing urls", () => {
        expect(isBasetenPath("POST", "/api/baseten/../chat/completions")).toBe(false);
        expect(isBasetenPath("POST", undefined)).toBe(false);
        expect(isBasetenPath(undefined, BASETEN_PATH)).toBe(false);
    });
});

describe("checkBodySize", () => {
    it("accepts bodies up to 64 KiB", () => {
        expect(checkBodySize(0)).toBe(true);
        expect(checkBodySize(BASETEN_MAX_BODY_BYTES)).toBe(true);
        expect(BASETEN_MAX_BODY_BYTES).toBe(64 * 1024);
    });

    it("rejects bodies over the cap", () => {
        expect(checkBodySize(BASETEN_MAX_BODY_BYTES + 1)).toBe(false);
        expect(checkBodySize(Number.NaN)).toBe(false);
        expect(checkBodySize(-1)).toBe(false);
    });
});

describe("forceModel", () => {
    it("overwrites any client model with the pinned id", () => {
        const out = forceModel({ model: "attacker-model", messages: [] }) as Record<string, unknown>;
        expect(out.model).toBe(BASETEN_MODEL_ID);
        expect(BASETEN_MODEL_ID).toBe("meta-models/muse-spark-open-1026");
    });

    it("forces n to 1", () => {
        const out = forceModel({ model: BASETEN_MODEL_ID, n: 4 }) as Record<string, unknown>;
        expect(out.n).toBe(1);
    });

    it("caps max_tokens at 700 and keeps smaller values", () => {
        const capped = forceModel({ model: "x", max_tokens: 4096 }) as Record<string, unknown>;
        expect(capped.max_tokens).toBe(BASETEN_MAX_TOKENS);
        expect(BASETEN_MAX_TOKENS).toBe(700);
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
        expect(out.model).toBe(BASETEN_MODEL_ID);
        expect(out.n).toBe(1);
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

describe("BasetenRateLimiter", () => {
    it("allows 10 per minute per IP then blocks", () => {
        const limiter = new BasetenRateLimiter(10, 60 * 1000);
        const now = 1_000_000;
        for (let i = 0; i < 10; i += 1) {
            expect(limiter.allow("1.2.3.4", now + i)).toBe(true);
        }
        expect(limiter.allow("1.2.3.4", now + 11)).toBe(false);
        expect(limiter.allow("5.6.7.8", now + 11)).toBe(true);
    });

    it("evicts expired entries so idle addresses do not grow the map", () => {
        const limiter = new BasetenRateLimiter(10, 60 * 1000);
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
        expect(BASETEN_MAX_RESPONSE_BYTES).toBe(1 * 1024 * 1024);
    });
});
