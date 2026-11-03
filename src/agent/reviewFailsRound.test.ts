// Review FAIL fixes: alias strictness, custom tab, sweep dwell, pressure
// rescue, bare rescue. One test per item, pure and deterministic.

import { describe, expect, it } from "vitest";
import { MAX_ENVELOPE_ACTIONS, parseAgentEnvelope, type AgentValidationContext } from "./agentActions";
import { bodyTabIdForSpec } from "@/ui/caseTabs";
import { describeSweepResult, runAlphaSweep, SWEEP_ALPHAS } from "./alphaSweep";
import { localReply } from "./localAssistant";
import type { AgentContext } from "./agentContext";

const ANALYTIC: AgentValidationContext = { lbmEffective: false, statsReady: false, hasTke: false, hasRecirc: false, agentFirst: false };

function fence(payload: unknown): string {
    return `Tuning.\n\`\`\`action-json\n${JSON.stringify(payload)}\n\`\`\``;
}

function makeCtx(over: Partial<AgentContext> = {}): AgentContext {
    return {
        spec: { kind: "naca4", alphaDeg: 6, reynolds: 50000, naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 } },
        reynolds: 50000,
        regime: "attached laminar",
        bodyLabel: "NACA 2412",
        alphaDeg: 6,
        backend: "analytic",
        engine: "analytic",
        gridLabel: "grid 128",
        cl: 0.6,
        cpMin: -1.2,
        lbm: { status: "idle", hasSnapshot: false, effective: false, statsReady: false, stats: null },
        field: { variable: "speed", effective: "speed", hasTke: false, hasRecirc: false },
        validation: { pass: 1, warn: 0, fail: 0, info: 0 },
        provenanceLabel: "analytic",
        offline: true,
        honesty: [],
        neural: { available: false, envelope: "provisional", path: "analytic" },
        ...over,
    };
}

describe("review fix 1: preset alias strictness", () => {
    it("leaves conflicting categories untouched for strict rejection", () => {
        const out = parseAgentEnvelope(fence({ kind: "set_preset", preset: "cylinder airfoil" }), ANALYTIC);
        expect(out.actions).toEqual([]);
        expect(out.rejections.join(" ")).toContain("unknown action kind");
    });

    it("leaves bare wake alone with no mapping", () => {
        const out = parseAgentEnvelope(fence({ kind: "set_preset", preset: "wake" }), ANALYTIC);
        expect(out.actions).toEqual([]);
        expect(out.rejections.join(" ")).toContain("unknown action kind");
    });

    it("does not map high resistance without a bounded re or wake word", () => {
        const out = parseAgentEnvelope(fence({ kind: "set_preset", preset: "high resistance" }), ANALYTIC);
        expect(out.actions).toEqual([]);
        expect(out.rejections.join(" ")).toContain("unknown action kind");
    });

    it("still maps an explicit high re wake qualifier", () => {
        const out = parseAgentEnvelope(fence({ kind: "set_preset", preset: "high re wake" }), ANALYTIC);
        expect(out.actions).toEqual([{ kind: "setup_high_re_wake" }]);
    });

    it("still maps unambiguous cylinder shedding talk", () => {
        const out = parseAgentEnvelope(fence({ kind: "set_preset", preset: "cylinder" }), ANALYTIC);
        expect(out.actions).toEqual([{ kind: "setup_shedding" }]);
    });
});

describe("review fix 2: custom tab leaves the tab unchanged", () => {
    it("returns null for custom and unknown kinds", () => {
        expect(bodyTabIdForSpec({ kind: "custom", chord: 1, alphaDeg: 0, nPoints: 4, polygon: [{ x: 0, y: 0 }] })).toBeNull();
        expect(bodyTabIdForSpec({ kind: "naca4", chord: 1, alphaDeg: 6, nPoints: 120 })).toBe("airfoil");
        expect(bodyTabIdForSpec({ kind: "cylinder", chord: 1, alphaDeg: 0, nPoints: 120 })).toBe("cylinder");
        expect(bodyTabIdForSpec({ kind: "block", chord: 1, alphaDeg: 0, nPoints: 120 })).toBe("block");
        expect(bodyTabIdForSpec({ kind: "orifice", chord: 1, alphaDeg: 0, nPoints: 120 })).toBe("orifice");
    });
});

describe("review fix 3: sweep dwell and stopped label", () => {
    it("skips yieldPaint after the final alpha", async () => {
        let yields = 0;
        const result = await runAlphaSweep({
            stepAlpha: () => ({ cl: 0.5, cpMin: -1, solveMs: 1 }),
            alphas: [-4, -2, 0],
            yieldPaint: () => {
                yields += 1;
            },
            startAlpha: 6,
        });
        expect(result.points.length).toBe(3);
        expect(yields).toBe(2);
    });

    it("labels only the unfinished staircase as stopped", () => {
        const full = {
            points: SWEEP_ALPHAS.map((alphaDeg) => ({ alphaDeg, cl: 0.5, cpMin: -1, solveMs: 1, dClVsPrev: null, dCpVsPrev: null })),
            cancelled: true,
            startedFrom: 6,
            finalAlpha: 12,
        };
        expect(describeSweepResult(full)).not.toContain("Stopped early");
        const partial = {
            points: full.points.slice(0, 2),
            cancelled: true,
            startedFrom: 6,
            finalAlpha: -2,
        };
        expect(describeSweepResult(partial)).toContain("Stopped early");
    });
});

describe("review fix 4: pressure rescue negation and envelope cap", () => {
    it("stages nothing on declined high pressure talk", () => {
        const out = localReply("do not show the high pressure zone", makeCtx());
        expect(out.actions).toEqual([]);
    });

    it("never exceeds the envelope action cap on a crowded pressure request", () => {
        expect(MAX_ENVELOPE_ACTIONS).toBe(5);
        const out = localReply(
            "show the high pressure zone, set alpha 6, set Re 50000, switch engine to lbm, show field cp, run the lbm solve",
            makeCtx()
        );
        expect(out.actions.length).toBeLessThanOrEqual(MAX_ENVELOPE_ACTIONS);
    });
});

describe("review fix 5: bare rescue definitional guard", () => {
    it("leaves embedded definitional clauses with zero actions", () => {
        for (const text of ["show me what a cylinder is", "show me what the block is", "show me what an orifice is"]) {
            const out = localReply(text, makeCtx());
            expect(out.actions).toEqual([]);
        }
    });
});
