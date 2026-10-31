// P1 agent-first startup tests. Flags default on, the startup resolver
// forces LBM off while reporting the ignored ?engine=lbm request, and the
// App source carries the worker, neural, frame, and executor guards. Pure,
// zero network, zero DOM.

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
    agentFirstFlags,
    lbmWorkerArmed,
    neuralLoadAllowed,
    resolveAgentFirst,
    resolveAgentFirstStartup,
    type AgentFirstFlags,
} from "./agentFirst";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = resolve(here, "..", "App.tsx");

const FIRST: AgentFirstFlags = { agentFirst: true, lbmEnabled: false, surrogateEnabled: false, engineSwitchingEnabled: false };

describe("agentFirstFlags defaults", () => {
    it("defaults to agent-first on with every engine path off", () => {
        const flags = agentFirstFlags();
        expect(flags.agentFirst).toBe(true);
        expect(flags.lbmEnabled).toBe(false);
        expect(flags.surrogateEnabled).toBe(false);
        expect(flags.engineSwitchingEnabled).toBe(false);
    });

    it("never throws", () => {
        expect(() => agentFirstFlags()).not.toThrow();
        expect(() => resolveAgentFirst(undefined)).not.toThrow();
        expect(() => resolveAgentFirstStartup("?engine=lbm")).not.toThrow();
        expect(() => lbmWorkerArmed(null, true)).not.toThrow();
        expect(() => neuralLoadAllowed(undefined)).not.toThrow();
    });

    it("lets an explicit boolean win over the build-time default", () => {
        expect(resolveAgentFirst(true)).toBe(true);
        expect(resolveAgentFirst(false)).toBe(false);
        expect(resolveAgentFirst(undefined)).toBe(true);
        expect(resolveAgentFirst(null)).toBe(true);
    });
});

describe("agent-first startup resolution", () => {
    it("forces lbmArmed false and reports the ignored ?engine=lbm request", () => {
        expect(resolveAgentFirstStartup("?engine=lbm")).toEqual({ lbmArmed: false, ignoredLbmRequest: true });
        expect(resolveAgentFirstStartup("engine=lbm")).toEqual({ lbmArmed: false, ignoredLbmRequest: true });
    });

    it("stays quiet when LBM was never requested", () => {
        expect(resolveAgentFirstStartup("")).toEqual({ lbmArmed: false, ignoredLbmRequest: false });
        expect(resolveAgentFirstStartup("?engine=wasm")).toEqual({ lbmArmed: false, ignoredLbmRequest: false });
        expect(resolveAgentFirstStartup("?debug=1")).toEqual({ lbmArmed: false, ignoredLbmRequest: false });
    });
});

describe("agent-first startup gates", () => {
    it("never arms the LBM worker under the flag, even when requested", () => {
        expect(lbmWorkerArmed(FIRST, true)).toBe(false);
        expect(lbmWorkerArmed(FIRST, false)).toBe(false);
        expect(lbmWorkerArmed({ ...FIRST, agentFirst: false }, true)).toBe(true);
        expect(lbmWorkerArmed({ ...FIRST, agentFirst: false }, false)).toBe(false);
    });

    it("never allows neural loads under the flag", () => {
        expect(neuralLoadAllowed(FIRST)).toBe(false);
        expect(neuralLoadAllowed({ ...FIRST, agentFirst: false })).toBe(true);
    });
});

describe("App agent-first wiring", () => {
    it("forces lbmArmed off at startup and guards engine switching", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).toContain("resolveAgentFirstStartup(window.location.search).lbmArmed");
        expect(src).toContain("if (agentFirst.agentFirst && next) return;");
    });

    it("gates worker creation and neural loads behind the flag predicates", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).toContain("if (!lbmWorkerArmed(agentFirst, lbmActive)) return;");
        expect(src).toContain("neuralLoadAllowed(agentFirst)");
        expect(src).toContain('setNeuralV3Status("unavailable")');
        expect(src).toContain("?engine=lbm ignored, serving the analytic frame.");
    });

    it("collapses the frame selector to the solved analytic frame with analytic labels", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).toContain("const frame = agentFirst.agentFirst ? solved.frame : (fixtureSolved");
        expect(src).toContain('? "ANALYTIC"');
        expect(src).toContain("agentFirstRejectionFor(action)");
    });

    it("suppresses neural unavailable and failed notices under the flag", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).toContain("!agentFirst.agentFirst && isNeuralV3Pending");
        expect(src).toContain('!agentFirst.agentFirst && neuralV3Status === "failed"');
        expect(src).toContain('!agentFirst.agentFirst && neuralV3Status === "unavailable"');
    });
});
