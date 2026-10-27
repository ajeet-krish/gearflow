// Phase B3 session spend tests. Pure predicates, zero live calls.

import { describe, expect, it } from "vitest";
import { addSpend, createSpend, isSoftStopped, SESSION_SPEND_CAP_USD } from "./sessionSpend";

describe("SESSION_SPEND_CAP_USD", () => {
    it("pins the soft stop at five dollars", () => {
        expect(SESSION_SPEND_CAP_USD).toBe(5);
    });
});

describe("isSoftStopped", () => {
    it("stays local under the cap", () => {
        expect(isSoftStopped(0)).toBe(false);
        expect(isSoftStopped(4.9999)).toBe(false);
        expect(isSoftStopped(0.01)).toBe(false);
    });

    it("stops at and over the cap", () => {
        expect(isSoftStopped(5)).toBe(true);
        expect(isSoftStopped(5.0001)).toBe(true);
        expect(isSoftStopped(25, 20)).toBe(true);
    });

    it("honors an explicit cap", () => {
        expect(isSoftStopped(10, 20)).toBe(false);
        expect(isSoftStopped(20, 20)).toBe(true);
    });

    it("is NaN safe and rejects non numbers without throwing", () => {
        expect(isSoftStopped(Number.NaN)).toBe(false);
        expect(isSoftStopped(Number.POSITIVE_INFINITY)).toBe(false);
        expect(isSoftStopped(5, Number.NaN)).toBe(false);
        expect(isSoftStopped("5" as unknown as number)).toBe(false);
        expect(isSoftStopped(null)).toBe(false);
        expect(isSoftStopped(undefined)).toBe(false);
    });
});

describe("addSpend", () => {
    it("accumulates tokens and cost into a new object", () => {
        const start = createSpend();
        const next = addSpend(start, { inputTokens: 10, outputTokens: 20 }, 0.001);
        expect(next).toEqual({ inputTokens: 10, outputTokens: 20, costUsd: 0.001 });
        expect(start).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
        const again = addSpend(next, { inputTokens: 5, outputTokens: 5 }, 0.002);
        expect(again).toEqual({ inputTokens: 15, outputTokens: 25, costUsd: 0.003 });
    });

    it("coerces NaN and negative inputs to zero and never throws", () => {
        const out = addSpend(null, { inputTokens: Number.NaN, outputTokens: -3 }, Number.NaN);
        expect(out).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
        expect(Number.isFinite(out.inputTokens)).toBe(true);
        expect(Number.isFinite(out.outputTokens)).toBe(true);
        expect(Number.isFinite(out.costUsd)).toBe(true);
        const undef = addSpend(undefined, undefined, undefined);
        expect(undef).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
    });

    it("floors fractional token counts", () => {
        const out = addSpend(createSpend(), { inputTokens: 10.9, outputTokens: 3.2 }, 0);
        expect(out.inputTokens).toBe(10);
        expect(out.outputTokens).toBe(3);
    });
});
