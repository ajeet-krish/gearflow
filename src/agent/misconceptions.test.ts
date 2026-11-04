// P4 misconception tests: triggers plus experiment validity. Pure, offline.

import { describe, expect, it } from "vitest";
import { detectMisconception, misconceptionFlows } from "./misconceptions";
import { validateAgentAction } from "./agentActions";
import { experimentFor } from "./tutorPolicy";
import { localReply } from "./localAssistant";
import type { AgentContext } from "./agentContext";

function makeCtx(): AgentContext {
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
        neural: {
            available: false,
            envelope: "provisional neural envelope",
            path: "analytic",
        },
    };
}

describe("detectMisconception triggers", () => {
    it("detects the stall by potential model claim", () => {
        const out = detectMisconception("stall is shown by the potential model", makeCtx());
        expect(out?.id).toBe("stall-potential");
        expect(out?.whatModelShows).toContain("omits separation");
    });
    it("detects Re does nothing", () => {
        const out = detectMisconception("Re does nothing here", makeCtx());
        expect(out?.id).toBe("re-no-effect");
    });
    it("detects Cl rises forever with alpha", () => {
        const out = detectMisconception("Cl rises forever with alpha", makeCtx());
        expect(out?.id).toBe("cl-forever");
    });
    it("detects CpMin as measured pressure", () => {
        const out = detectMisconception("CpMin is measured pressure in pascal", makeCtx());
        expect(out?.id).toBe("cpmin-measured");
    });
    it("leaves plain CpMin definition questions to the glossary", () => {
        expect(detectMisconception("what is cpmin", makeCtx())).toBeNull();
        expect(detectMisconception("what is cpmin in this run", makeCtx())).toBeNull();
        expect(detectMisconception("what is cpmin in this run?", makeCtx())).toBeNull();
    });
    it("leaves definitional value and means phrasings to the glossary", () => {
        expect(detectMisconception("what is cpmin value", makeCtx())).toBeNull();
        expect(detectMisconception("what is cpmin means", makeCtx())).toBeNull();
        expect(detectMisconception("what is cpmin value means", makeCtx())).toBeNull();
        expect(detectMisconception("what does cpmin mean", makeCtx())).toBeNull();
    });
    it("still detects a what is question that carries a measurement claim", () => {
        const out = detectMisconception("what is cpmin measured in pascal", makeCtx());
        expect(out?.id).toBe("cpmin-measured");
    });
    it("returns null for plain chat and never throws on bad input", () => {
        expect(detectMisconception("hello there", makeCtx())).toBeNull();
        for (const bad of ["", "   ", null, undefined, 42, {}]) {
            expect(() => detectMisconception(bad, makeCtx())).not.toThrow();
            expect(detectMisconception(bad, makeCtx())).toBeNull();
        }
        expect(() => detectMisconception("stall shown by potential", null)).not.toThrow();
    });
});

describe("misconception experiments use valid action kinds only", () => {
    it("every flow experiment validates clean under the analytic gate", () => {
        for (const flow of misconceptionFlows()) {
            const checked = validateAgentAction(flow.experimentAction, {
                lbmEffective: false,
                statsReady: false,
                hasTke: false,
                hasRecirc: false,
                agentFirst: true,
            });
            expect(checked.ok).toBe(true);
            expect(checked.action).not.toBeNull();
        }
    });
    it("names the staged action as the first step in every experiment", () => {
        for (const flow of misconceptionFlows()) {
            const text = flow.experimentText.toLowerCase();
            expect(text).toContain("first");
            const action = flow.experimentAction;
            if (action.kind === "set_field") {
                expect(text).toContain(action.field);
            } else if (action.kind === "set_alpha") {
                expect(text).toContain("alpha");
                expect(text).toContain(String(action.alphaDeg));
            } else if (action.kind === "set_reynolds") {
                expect(text).toContain(String(action.reynolds));
            } else {
                throw new Error(`unpinned experiment action kind ${(action as { kind: string }).kind}`);
            }
        }
    });
    it("no flow experiment proposes an LBM run", () => {
        for (const flow of misconceptionFlows()) {
            expect(flow.experimentAction.kind).not.toBe("run_lbm");
            expect(flow.experimentAction.kind).not.toBe("cancel_lbm");
            expect(flow.experimentText).not.toContain("run_lbm");
        }
    });
    it("Physics Agent experimentFor stays analytic only with no LBM runs", () => {
        for (const flow of misconceptionFlows()) {
            void flow;
        }
        const concepts = ["attached-lift", "suction-peak", "stall-separation", "karman-shedding", "turbulent-wake", "stagnation", "general"] as const;
        for (const c of concepts) {
            const text = experimentFor(c);
            expect(text.length).toBeGreaterThan(0);
            expect(text).not.toContain("LBM");
            expect(text).not.toContain("Press Run");
        }
    });
});

describe("misconception handling removed from chat", () => {
    it("answers the stall claim with the separation note and zero staged actions", () => {
        const out = localReply("stall is shown by the potential model", makeCtx());
        expect(out.reply).not.toContain("Teaching note");
        expect(out.reply).toContain("omits separation");
        expect(out.actions).toEqual([]);
        expect(out.reply).toContain("Canvas unchanged");
    });
    it("answers Re does nothing with a plain note and zero staged actions", () => {
        const out = localReply("Re does nothing here", makeCtx());
        expect(out.reply).not.toContain("Teaching note");
        expect(out.actions).toEqual([]);
        expect(out.reply).toContain("Canvas unchanged");
    });
});
