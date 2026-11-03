// Block intent tests. Dimensions, pairs, lone number filtering, clamps,
// question and negation guards, never throws, open_theory accept and reject,
// plus schema block missing width, height, and center rejections.

import { describe, expect, it } from "vitest";
import { buildBlockEnvelope, parseBlockIntent } from "./blockIntent";
import { validateAgentAction } from "./agentActions";
import { validateGeometrySpec, validateParametricSpec } from "@/contracts/schema";

const LIVE = { lbmEffective: false, statsReady: false, hasTke: false, hasRecirc: false, agentFirst: false };

function blockSpec(overrides: Record<string, unknown> = {}): unknown {
    return {
        geometry: {
            kind: "block",
            chord: 1,
            alphaDeg: 0,
            nPoints: 120,
            width: 0.5,
            height: 0.5,
            center: { x: 0.5, y: 0 },
            ...overrides,
        },
        reynolds: 50000,
        rationale: "Block test spec.",
    };
}

describe("parseBlockIntent dimensions", () => {
    it("parses explicit width and height", () => {
        const got = parseBlockIntent("set a block with width 0.6 and height 0.8", null);
        expect(got?.kind).toBe("apply");
        if (got?.kind === "apply") {
            expect(got.width).toBeCloseTo(0.6);
            expect(got.height).toBeCloseTo(0.8);
            expect(got.confidence).toBeGreaterThanOrEqual(0.9);
        }
    });

    it("parses side and size as a square", () => {
        const side = parseBlockIntent("make a square with side 0.7", null);
        expect(side?.kind).toBe("apply");
        if (side?.kind === "apply") {
            expect(side.width).toBeCloseTo(0.7);
            expect(side.height).toBeCloseTo(0.7);
        }
        const size = parseBlockIntent("block with size 0.9", null);
        expect(size?.kind).toBe("apply");
        if (size?.kind === "apply") {
            expect(size.width).toBeCloseTo(0.9);
            expect(size.height).toBeCloseTo(0.9);
        }
    });

    it("parses by and x pairs", () => {
        const by = parseBlockIntent("rectangle 1.2 by 0.6", null);
        expect(by?.kind).toBe("apply");
        if (by?.kind === "apply") {
            expect(by.width).toBeCloseTo(1.2);
            expect(by.height).toBeCloseTo(0.6);
        }
        const cross = parseBlockIntent("block 2x1", null);
        expect(cross?.kind).toBe("apply");
        if (cross?.kind === "apply") {
            expect(cross.width).toBeCloseTo(2);
            expect(cross.height).toBeCloseTo(1);
        }
    });

    it("notes a lone width mirrored to height and vice versa", () => {
        const loneWidth = parseBlockIntent("block with width 0.7", null);
        expect(loneWidth?.kind).toBe("apply");
        if (loneWidth?.kind === "apply") {
            expect(loneWidth.width).toBeCloseTo(0.7);
            expect(loneWidth.height).toBeCloseTo(0.7);
            expect(loneWidth.notes.join(" ")).toContain("mirrored");
        }
        const loneHeight = parseBlockIntent("rectangle with height 0.9", null);
        expect(loneHeight?.kind).toBe("apply");
        if (loneHeight?.kind === "apply") {
            expect(loneHeight.width).toBeCloseTo(0.9);
            expect(loneHeight.height).toBeCloseTo(0.9);
            expect(loneHeight.notes.join(" ")).toContain("mirrored");
        }
    });

    it("returns null for a bare mention with no size", () => {
        expect(parseBlockIntent("square", null)).toBeNull();
        expect(parseBlockIntent("show me a square", null)).toBeNull();
        expect(parseBlockIntent("block", null)).toBeNull();
        expect(parseBlockIntent("rectangle", null)).toBeNull();
    });

    it("filters alpha and Re numbers from the lone square side", () => {
        const got = parseBlockIntent("square alpha 6 Re 50000 side 0.5", null);
        expect(got?.kind).toBe("apply");
        if (got?.kind === "apply") {
            expect(got.width).toBeCloseTo(0.5);
            expect(got.height).toBeCloseTo(0.5);
        }
    });

    it("clamps out of envelope extents with notes and corrections", () => {
        const got = parseBlockIntent("block with width 10 and height 0.01", null);
        expect(got?.kind).toBe("apply");
        if (got?.kind === "apply") {
            expect(got.width).toBeLessThanOrEqual(3);
            expect(got.height).toBeGreaterThanOrEqual(0.1);
            expect(got.notes.join(" ")).toContain("clamped");
            expect(got.corrections.length).toBeGreaterThan(0);
            expect(got.corrections.join(" ")).toContain("clamped");
        }
    });
});

describe("parseBlockIntent guards", () => {
    it("returns null on questions", () => {
        for (const text of [
            "what is a square cylinder",
            "why use a block",
            "explain the square wake",
            "compare square and rectangle",
            "square vs rectangle",
        ]) {
            expect(parseBlockIntent(text, null)).toBeNull();
        }
    });

    it("returns null on negations", () => {
        for (const text of [
            "do not make a square",
            "do not use a block",
            "never use a square",
            "no square please",
            "not a square, use an airfoil",
        ]) {
            expect(parseBlockIntent(text, null)).toBeNull();
        }
    });

    it("returns null for non block text", () => {
        expect(parseBlockIntent("set NACA 2412 alpha 6", null)).toBeNull();
        expect(parseBlockIntent("", null)).toBeNull();
        expect(parseBlockIntent("   ", null)).toBeNull();
    });

    it("never throws on bad input or bad context", () => {
        const bad: unknown[] = [null, undefined, 42, {}, [], "", "   "];
        for (const v of bad) {
            expect(parseBlockIntent(v, null)).toBeNull();
        }
        expect(() => parseBlockIntent("square side 0.5", { alphaDeg: 42 as unknown as number })).not.toThrow();
        expect(() => parseBlockIntent(null, null)).not.toThrow();
        expect(() => buildBlockEnvelope(null as never, null)).not.toThrow();
        const fallen = buildBlockEnvelope(null as never, null);
        expect(fallen.candidates).toEqual([]);
    });
});

describe("parseBlockIntent envelope", () => {
    it("builds one validated set_spec candidate", () => {
        const apply = parseBlockIntent("block with width 0.6 and height 0.8", null);
        expect(apply?.kind).toBe("apply");
        if (apply?.kind !== "apply") throw new Error("expected a block apply");
        const env = buildBlockEnvelope(apply);
        expect(env.candidates).toHaveLength(1);
        expect(env.candidates[0].kind).toBe("set_spec");
        expect(validateAgentAction(env.candidates[0], LIVE).ok).toBe(true);
    });
});

describe("open_theory validation", () => {
    it("accepts a known topic", () => {
        const checked = validateAgentAction({ kind: "open_theory", topic: "naca-geometry" }, LIVE);
        expect(checked.ok).toBe(true);
        expect(checked.action).toEqual({ kind: "open_theory", topic: "naca-geometry" });
    });

    it("rejects unknown and missing topics", () => {
        const unknown = validateAgentAction({ kind: "open_theory", topic: "nope-topic" }, LIVE);
        expect(unknown.ok).toBe(false);
        expect(unknown.reason ?? "").toContain("unknown");
        const missing = validateAgentAction({ kind: "open_theory" }, LIVE);
        expect(missing.ok).toBe(false);
        expect(missing.reason ?? "").toContain("topic");
    });
});

describe("schema block completeness", () => {
    it("rejects block specs missing width, height, or center", () => {
        const { width: _w, ...noWidth } = (blockSpec() as { geometry: Record<string, unknown> }).geometry;
        expect(() => validateGeometrySpec({ ...noWidth })).toThrow(/width/);
        const { height: _h, ...noHeight } = (blockSpec() as { geometry: Record<string, unknown> }).geometry;
        expect(() => validateGeometrySpec({ ...noHeight })).toThrow(/height/);
        const { center: _c, ...noCenter } = (blockSpec() as { geometry: Record<string, unknown> }).geometry;
        expect(() => validateGeometrySpec({ ...noCenter })).toThrow(/center/);
        expect(() => validateParametricSpec(blockSpec())).not.toThrow();
        expect(_w).toBeDefined();
        expect(_h).toBeDefined();
        expect(_c).toBeDefined();
    });
});
