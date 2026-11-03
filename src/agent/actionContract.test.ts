// R2 action contract tests. The validator kinds and the console auto
// apply plus confirm sets must agree, and the prompt stays physics-only
// with a physics actions line (no engine or field token names). Pure,
// zero network.

import { describe, expect, it } from "vitest";
import {
    ACTION_KINDS,
    PRESET_ACTION_KINDS,
    RETIRED_ACTION_KINDS,
    RUN_ACTION_KINDS,
    SETUP_ACTION_KINDS,
    actionContractSummary,
    validateAgentAction,
    type AgentValidationContext,
} from "./agentActions";
import { RUN_KINDS, SETUP_KINDS, buildModalMessages, physicsViewFor } from "@/ui/AgentConsole";
import { buildAgentContext } from "./agentContext";

const ANALYTIC: AgentValidationContext = { lbmEffective: false, statsReady: false, hasTke: false, hasRecirc: false };

function promptSystem(): string {
    const messages = buildModalMessages("Explain this run", null, []);
    expect(messages.length).toBeGreaterThan(0);
    return messages[0].content;
}

function fullPromptText(ctx: Parameters<typeof buildModalMessages>[1]): string {
    const messages = buildModalMessages("Explain this run with a sweep", ctx, []);
    return messages.map((m) => m.content).join("\n");
}

function richContext() {
    return buildAgentContext({
        spec: { kind: "naca4", naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 }, chord: 1, alphaDeg: 6, nPoints: 120 },
        reynolds: 50000,
        regime: "laminar, attached",
        bodyLabel: "NACA 2412",
        backend: "lbm pending",
        engine: "lbm",
        gridLabel: "128x128",
        cl: 0.6,
        cpMin: -1.2,
        lbmStatus: "running",
        lbmHasSnapshot: true,
        lbmEffective: true,
        lbmStatsReady: true,
        lbmStats: { samples: 10, startStep: 0, step: 10, recircFraction: 0.1, cdMean: 0.02, clMean: 0.6, clRms: 0.01, strouhal: 0.2 },
        variable: "omega",
        effectiveVariable: "omega",
        hasTke: true,
        hasRecirc: true,
        validation: { pass: 1, warn: 0, fail: 0, info: 0 },
        provenanceLabel: "lbm live",
        offline: false,
        neuralAvailable: true,
        neuralEnvelopeSummary: "provisional neural envelope with weights",
        displayedPath: "lbm",
        surrogate: { path: "surrogate", weightsVersion: "v1", strouhal: 0.2, vorticityPeak: 3.1 } as never,
    } as never);
}

describe("action contract drift guard", () => {
    it("validator contract kinds match the exported kind lists", () => {
        const contract = actionContractSummary();
        expect([...contract.kinds].sort()).toEqual([...ACTION_KINDS].sort());
        expect([...contract.setupKinds].sort()).toEqual([...SETUP_ACTION_KINDS].sort());
        expect([...contract.runKinds].sort()).toEqual([...RUN_ACTION_KINDS].sort());
        expect([...contract.retiredKinds].sort()).toEqual([...RETIRED_ACTION_KINDS].sort());
    });

    it("console sets equal the validator setup plus run kinds", () => {
        const contract = actionContractSummary();
        expect([...SETUP_KINDS].sort()).toEqual([...contract.setupKinds].sort());
        expect([...RUN_KINDS].sort()).toEqual([...contract.runKinds].sort());
        expect(new Set([...SETUP_KINDS, ...RUN_KINDS])).toEqual(new Set(contract.kinds));
    });

    it("prompt uses a physics actions line with no engine, field, or run token names", () => {
        const system = promptSystem();
        const validLine = system.split("\n").find((l) => l.startsWith("Valid actions:")) ?? "";
        expect(validLine.length).toBeGreaterThan(0);
        expect(validLine).toContain("angle of attack (alpha)");
        expect(validLine).toContain("Reynolds number (Re)");
        const lowered = validLine.toLowerCase();
        for (const banned of ["run_lbm", "cancel_lbm", "set_field", "set_engine"]) {
            expect(lowered).not.toContain(banned);
        }
        for (const retired of RETIRED_ACTION_KINDS) {
            expect(validLine).not.toContain(retired);
        }
    });

    it("every live preset kind validates through the preset path", () => {
        for (const kind of PRESET_ACTION_KINDS) {
            const checked = validateAgentAction({ kind }, ANALYTIC);
            expect(checked.ok).toBe(true);
        }
        const retired = validateAgentAction({ kind: "setup_high_pressure" }, ANALYTIC);
        expect(retired.ok).toBe(false);
        expect(retired.reason ?? "").toContain("diverges at every tested gap and Re");
    });
});

describe("prompt snapshot", () => {
    it("labels high_pressure retired, quotes Re 1200, never 50000 or orifice Re 1000", () => {
        const system = promptSystem();
        expect(system).toContain("retired");
        expect(system).toContain("setup_high_pressure is retired");
        expect(system).toContain("setup_high_re_wake");
        expect(system).toContain("1200");
        expect(system).not.toContain("50000");
        expect(system).not.toContain("Re 1000");
    });

    it("carries the any-code set_spec instruction with physics-only guidance", () => {
        const system = promptSystem();
        expect(system).toContain("set_spec");
        expect(system).toContain("Any 4-digit NACA rides one set_spec");
        expect(system).toContain("rationale");
        expect(system).toContain("Agent setup NACA 2415 alpha 6.");
        expect(system).toContain("e.g. NACA 0012, 2412, 4412 presets");
        expect(system).toContain("lift coefficient (Cl)");
        expect(system).toContain("pressure coefficient (Cp)");
        expect(system).toContain("angle of attack (alpha)");
        expect(system).toContain("Reynolds number (Re)");
        expect(system).toContain("one sentence describing the new case");
        expect(system).toContain("before versus after table plus Why plus Try next");
        expect(system).toContain("potential flow picture omits separation and stall");
        expect(system).not.toContain("Analytic only");
        expect(system).not.toContain("omega");
        expect(system).not.toContain("LBM");
        expect(system).not.toContain("Strouhal");
        expect(system).not.toContain("envelope");
        expect(system).not.toContain("fallback");
        expect(system).not.toContain("weights");
    });

    it("preset lines match live expandCasePreset output with expanded terms", () => {
        const system = promptSystem();
        expect(system).toContain("(Re) 100");
        expect(system).toContain("(Re) 700");
        expect(system).toContain("(Re) 1200");
        expect(system).toContain("angle of attack (alpha)");
    });

    it("teaches the NACA p bound, the rejection rule, and the block chord fence", () => {
        const system = promptSystem();
        expect(system).toContain("when camber (m) is above 0");
        expect(system).toContain("(0, 1)");
        expect(system).toContain("nearest valid");
        expect(system).toContain("No teaching prose for unapplied cases");
        expect(system).toContain("canvas unchanged");
        expect(system).toContain('"chord":1');
        expect(system).toContain('"center":{"x":0.5,"y":0}');
        expect(system).toContain("angle of attack (alpha) influence");
        expect(system).toContain("no action fence");
        expect(system).toContain("agent runs now");
    });
});

describe("physics-only prompt leak guard", () => {
    it("projects live context to body, alpha, reynolds, cl, cpMin, regime only", () => {
        const view = physicsViewFor(richContext());
        expect(Object.keys(view).sort()).toEqual(["alphaDeg", "body", "cl", "cpMin", "regime", "reynolds"].sort());
        expect(view.body).toContain("NACA 2412");
    });

    it("full assembled messages carry no banned tokens case-insensitively", () => {
        const text = fullPromptText(richContext());
        const lowered = text.toLowerCase();
        const banned = [
            "run_lbm",
            "cancel_lbm",
            "set_field",
            "set_engine",
            "strouhal",
            "neural",
            "weights",
            "vorticity",
            "\"lbm\"",
            "\"field\"",
            "\"engine\"",
            "\"surrogate\"",
        ];
        for (const token of banned) {
            expect(lowered).not.toContain(token);
        }
        expect(lowered).toContain("naca 2412");
    });
});
