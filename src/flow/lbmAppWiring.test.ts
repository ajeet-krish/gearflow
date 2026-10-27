// App LBM wiring assertions: failover label, error slot, blockage note,
// and placeholder resets. Reads App.tsx source so the contract cannot drift
// without a test failure. No Worker or browser needed.

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = resolve(here, "../App.tsx");
const barPath = resolve(here, "../ui/SolverBar.tsx");
const configPath = resolve(here, "./lbmRunConfig.ts");

describe("LBM App wiring", () => {
    it("renders the failover label and wires worker errors to failover", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).toContain("analytic fallback serving frames. No LBM numbers shown.");
        expect(src).toContain("onerror");
        expect(src).toContain("lbmFailover");
        // Reset contract: fresh runs and failover drop stale LBM state.
        expect(src).toContain("setLbmHasSnapshot(false)");
        // Blockage note contract: computed, stored, and rendered.
        expect(src).toContain("blockageForGeometry");
        expect(src).toContain("setBlockageNote");
        // Placeholder source is gated on the first snapshot.
        expect(src).toContain('lbmHasSnapshot ? "lbm-binary" : "analytic-potential"');
        // Displayed Cl is gated on the first snapshot (n/a before it).
        expect(src).toContain("lbmHasSnapshot && lbmForces");
    });

    it("wires configurable run state into init and the fallback", async () => {
        const src = await readFile(appPath, "utf8");
        // Run state and effective LES selection.
        expect(src).toContain("lbmULattice");
        expect(src).toContain("lbmTargetSteps");
        expect(src).toContain("lbmLesAuto");
        expect(src).toContain("lbmLesEffective");
        // init carries the configured values.
        expect(src).toContain("uLattice: lbmULattice");
        expect(src).toContain("targetSteps: lbmTargetSteps");
        expect(src).toContain("lesEnabled: lbmLesEffective");
        // The write-only gen key is gone, the effect deps array is canonical.
        expect(src).not.toContain("lbmGenKeyRef");
        expect(src).toContain("The effect deps array above is the canonical re-init trigger.");
        // Progress fallback uses the configured target steps.
        expect(src).toContain("lbmProgress.targetSteps > 0 ? lbmProgress.targetSteps : lbmTargetSteps");
    });

    it("resets a high Re once on LBM entry and never loops", async () => {
        const src = await readFile(appPath, "utf8");
        // Transition guard keyed on the mode change, not on every render.
        expect(src).toContain("lbmEnterSeenRef");
        expect(src).toContain("lbmEntryTransition(engineMode, reynolds, lbmEnterSeenRef.current)");
        // High Re resets to 200 with a notice, deliberate low Re survives.
        expect(src).toContain("setReynolds(transition.reynolds)");
        expect(src).toContain("setLbmNotice(transition.notice)");
        expect(src).toContain("lbmNotice");
        const cfgSrc = await readFile(configPath, "utf8");
        expect(cfgSrc).toContain("LBM needs low Re, Re set to 200 for the run default.");
    });

    it("caps the SolverBar Re input while LBM is active", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).toContain("maxRe={lbmActive ? LBM_MAX_RE : 1000000}");
        const barSrc = await readFile(barPath, "utf8");
        expect(barSrc).toContain("maxRe");
        expect(barSrc).toContain("max={maxRe}");
    });

    it("routes the rail Re slider and parametric applies through the LBM cap", async () => {
        const src = await readFile(appPath, "utf8");
        // Rail log slider shares the capped bar handler, SolverBar keeps its maxRe.
        expect(src).toContain("onReynoldsChange={onReynoldsBar}");
        expect(src).toContain("maxRe={lbmActive ? LBM_MAX_RE : 1000000}");
        // Parametric applies (MetaPanel, agent set_spec) clamp under LBM and note it.
        expect(src).toContain("clampReForEngine(next.reynolds, lbmActive)");
        expect(src).toContain("setLbmNotice(LBM_PARAM_CAP_NOTICE)");
    });

    it("exposes an actionable tau recovery that sets Re 200", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).toContain("withLbmTauGuidance(stepped)");
        // Measured guidance lives in the shared run config module.
        const cfgSrc = await readFile(configPath, "utf8");
        expect(cfgSrc).toContain("LBM_TAU_GUIDANCE");
        expect(cfgSrc).toContain("stable below about Re 480 at u 0.05");
        expect(src).toContain("lbmRecoveryRe");
        expect(src).toContain("onLbmRecoverRe");
        // Recover clears the failover latch in step with the Re change.
        expect(src).toContain("setLbmFailed(null)");
        expect(src).toContain("setReynolds(lbmRecoveryRe)");
        expect(src).toContain("Recover at Re 200");
    });

    it("gates Run on the pre-flight and logs blocks to the run log", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).toContain("preflightLbm(");
        expect(src).toContain("Run blocked");
        // Append only terminal hook: step plus message plus level.
        expect(src).toContain("RunLogEntry");
        expect(src).toContain("appendRunLog");
        expect(src).toContain("runLog");
    });

    it("threads the death step into the failover notice", async () => {
        const src = await readFile(appPath, "utf8");
        // Last completed step rides into the notice and the readout.
        expect(src).toContain("lbmProgressRef");
        expect(src).toContain("Diverged at step");
        expect(src).toContain("of ${target}");
        expect(src).toContain("step: last.step, targetSteps: target");
        // The honest fallback still clears the snapshot and latches.
        expect(src).toContain("setLbmHasSnapshot(false)");
    });
});
