// R2 action contract tests. The validator kinds, the prompt kinds, and the
// console auto apply plus confirm sets must agree three ways, and the prompt
// snapshot pins the retired preset plus honest Re values. Pure, zero network.

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
import { RUN_KINDS, SETUP_KINDS, buildBasetenMessages } from "@/ui/AgentConsole";

const ANALYTIC: AgentValidationContext = { lbmEffective: false, statsReady: false, hasTke: false, hasRecirc: false };

function promptSystem(): string {
    const messages = buildBasetenMessages("Explain this run", null, []);
    expect(messages.length).toBeGreaterThan(0);
    return messages[0].content;
}

function promptKinds(system: string): string[] {
    const line = system.split("\n").find((l) => l.startsWith("Valid kinds:"));
    expect(line).toBeDefined();
    return (line as string)
        .slice("Valid kinds:".length)
        .replace(/\.\s*$/, "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
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

    it("prompt kinds equal the validator kinds three ways, retired stays out", () => {
        const contract = actionContractSummary();
        const kinds = promptKinds(promptSystem());
        expect([...kinds].sort()).toEqual([...contract.kinds].sort());
        expect([...kinds].sort()).toEqual([...SETUP_KINDS, ...RUN_KINDS].sort());
        for (const retired of RETIRED_ACTION_KINDS) {
            expect(kinds).not.toContain(retired);
        }
        expect(kinds).toContain("setup_high_re_wake");
        expect(kinds).toContain("set_spec");
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

    it("carries the arbitrary code set_spec instruction plus the tutor thickness line", () => {
        const system = promptSystem();
        expect(system).toContain("set_spec");
        expect(system).toContain("0012, 2412, and 4412");
        expect(system).toContain("6 to 18%");
        expect(system).toContain("physics explainer");
    });

    it("preset lines match live expandCasePreset output", () => {
        const system = promptSystem();
        expect(system).toContain("Re 100");
        expect(system).toContain("Re 700");
        expect(system).toContain("Re 1200");
    });
});
