// Review FAIL round fixes, one contract per item, pure and deterministic.
// Contract note for set_preset: the parser keeps unambiguous bare body
// aliases (cylinder or shedding or karman or vortex maps to setup_shedding,
// high Re wake maps to setup_high_re_wake, NACA or airfoil maps to
// setup_airfoil, high pressure maps to retired setup_high_pressure) and
// strictly rejects conflicting or unknown presets (bare wake, high
// resistance, cylinder airfoil together, block or rectangle or orifice
// presets) with an unknown action kind rejection and zero actions. The
// prompt, the normalizePresetAlias parser, and these tests pin that same
// contract; the console settle never applies a set_preset fence directly.

import { describe, expect, it } from "vitest";
import { MAX_ENVELOPE_ACTIONS, parseAgentEnvelope, type AgentValidationContext } from "./agentActions";
import { bodyTabIdForSpec } from "@/ui/caseTabs";
import { describeSweepResult, runAlphaSweep, SWEEP_ALPHAS } from "./alphaSweep";
import { localReply } from "./localAssistant";
import { buildCylinderEnvelope, parseCylinderIntent } from "./cylinderIntent";
import { atomicSetupActions, collapseToOneSentence, executorFaultCopy, firstSentenceReply } from "@/ui/AgentConsole";
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

describe("review fix 6: declined bare and explain negation settles zero actions", () => {
    it("leaves declined cylinder, airfoil, and orifice talk untouched", () => {
        for (const text of [
            "do not show me a cylinder",
            "never set up an airfoil",
            "do not set up the orifice",
            "do not show the block",
            "never run the lbm solve",
            "do not set alpha 6",
            "do not explain the cylinder",
            "never explain the shedding case",
        ]) {
            const out = localReply(text, makeCtx());
            expect(out.actions).toEqual([]);
        }
    });
});

describe("review fix 7: explain-tolerant cylinder radius keeps size end to end", () => {
    it("parses explain cylinder radius 0.5 with the radius intact", () => {
        const apply = parseCylinderIntent("explain the cylinder with radius 0.5", { reynolds: 50000 });
        expect(apply).not.toBeNull();
        expect(apply?.radius).toBeCloseTo(0.5, 9);
        const built = buildCylinderEnvelope(apply!, { reynolds: 50000 });
        expect(built.candidates.length).toBe(1);
        expect(built.candidates[0].kind).toBe("set_spec");
        expect(collapseToOneSentence(built.reply).split(".").filter(Boolean).length).toBeLessThanOrEqual(1 + 1);
        expect(built.reply).toContain("0.5");
    });
});

describe("review fix 8: setup envelopes settle atomically with honest fault copy", () => {
    it("settles zero actions when a setup envelope carries rejections", () => {
        expect(atomicSetupActions([{ kind: "setup_shedding" }], ["preset setup rejected"])).toEqual([]);
        expect(atomicSetupActions([{ kind: "setup_shedding" }], [])).toEqual([{ kind: "setup_shedding" }]);
        expect(atomicSetupActions([{ kind: "set_alpha", alphaDeg: 6 }], ["set_alpha rejected"])).toEqual([
            { kind: "set_alpha", alphaDeg: 6 },
        ]);
    });

    it("claims unchanged only when nothing applied yet", () => {
        expect(executorFaultCopy("setup_shedding", 0)).toContain("canvas unchanged");
        expect(executorFaultCopy("setup_shedding", 2)).not.toContain("canvas unchanged");
        expect(executorFaultCopy("setup_shedding", 2)).toContain("after 2 applied");
    });
});

describe("review fix 9: set_preset contract pins alias mapping plus strict rejection", () => {
    it("strictly rejects unknown or conflicting set_preset fences", () => {
        for (const preset of ["wake", "high resistance", "cylinder airfoil", "block", "orifice", "rectangle"]) {
            const out = parseAgentEnvelope(fence({ kind: "set_preset", preset }), ANALYTIC);
            expect(out.actions).toEqual([]);
            expect(out.rejections.join(" ")).toContain("unknown action kind");
        }
    });
});

describe("review fix 10: settled replies stay one sentence with applied values", () => {
    it("sanitizes multi-sentence model replies to one sentence", () => {
        expect(firstSentenceReply("Applying the cylinder. Teaching follows.")).toBe("Applying the cylinder.");
        expect(collapseToOneSentence("Applying the cylinder. Note: radius kept.")).toBe(
            "Applying the cylinder; note: radius kept."
        );
    });
});
