// Phase 4 agent case setup tests. Pure, deterministic, zero live calls.
// Covers validator envelope awareness, out of domain rejections with zero
// actions (so the executor stays idle), phenomenological local triggers,
// honest cannot do replies, clarification flow, confirm chip run gating,
// context neural honesty, and the five action cap.

import { describe, expect, it, vi } from "vitest";
import { parseAgentEnvelope, validateAgentAction, type AgentValidationContext } from "./agentActions";
import { buildAgentContext, type AppSnapshot } from "./agentContext";
import { localReply } from "./localAssistant";
import type { AgentContext } from "./agentContext";

const ANALYTIC: AgentValidationContext = { lbmEffective: false, statsReady: false, hasTke: false, hasRecirc: false };
const NEURAL: AgentValidationContext = { lbmEffective: false, statsReady: false, hasTke: false, hasRecirc: false, neuralAvailable: true };

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
        neural: {
            available: false,
            envelope: "provisional neural envelope [naca0012, naca2412, naca4412, cylinder, block], alpha [-4, 8], Re [20, 1200], no weights yet",
            path: "analytic",
        },
        ...over,
    };
}

function snapshot(over: Partial<AppSnapshot> = {}): AppSnapshot {
    return {
        spec: { kind: "naca4", naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 }, chord: 1, alphaDeg: 6, nPoints: 120 },
        reynolds: 1000,
        regime: "laminar, attached",
        bodyLabel: "NACA 2412",
        backend: "analytic live 128",
        engine: "analytic",
        gridLabel: "128x128",
        cl: 0.6543,
        cpMin: -1.2345,
        lbmStatus: "idle",
        lbmHasSnapshot: false,
        lbmStatsReady: false,
        lbmStats: null,
        variable: "speed",
        effectiveVariable: "speed",
        hasTke: false,
        hasRecirc: false,
        validation: { pass: 9, warn: 0, fail: 0, info: 0 },
        provenanceLabel: "analytic-potential, computed locally at 128",
        offline: false,
        ...over,
    };
}

describe("validator envelope awareness", () => {
    it("accepts setup_shedding on the analytic path with its own Re 100", () => {
        const out = validateAgentAction({ kind: "setup_shedding" }, ANALYTIC);
        expect(out.ok).toBe(true);
        expect(out.action).toEqual({ kind: "setup_shedding" });
    });

    it("accepts setup_shedding while the neural path serves, since Re 100 sits inside the envelope", () => {
        const out = validateAgentAction({ kind: "setup_shedding" }, NEURAL);
        expect(out.ok).toBe(true);
        expect(out.action).toEqual({ kind: "setup_shedding" });
    });

    it("rejects a neural out of band airfoil alpha with the alpha bound, never a hallucinated body", () => {
        const out = validateAgentAction({ kind: "setup_airfoil", body: "naca4412", alphaDeg: 45 }, NEURAL);
        expect(out.ok).toBe(false);
        const reason = out.reason ?? "";
        expect(reason).toContain("45");
        expect(reason).toContain("8");
        expect(reason).toContain("naca4412");
    });

    it("accepts an in envelope airfoil preset while the neural path serves", () => {
        const out = validateAgentAction({ kind: "setup_airfoil", body: "naca4412", alphaDeg: 6 }, NEURAL);
        expect(out.ok).toBe(true);
    });

    it("keeps set_engine to analytic or lbm with a pointer copy for wasm and surrogate", () => {
        expect(validateAgentAction({ kind: "set_engine", engine: "analytic" }, ANALYTIC).ok).toBe(true);
        expect(validateAgentAction({ kind: "set_engine", engine: "lbm" }, ANALYTIC).ok).toBe(true);
        const wasm = validateAgentAction({ kind: "set_engine", engine: "wasm" }, ANALYTIC);
        expect(wasm.ok).toBe(false);
        expect(wasm.reason ?? "").toContain("[analytic, lbm]");
        expect(wasm.reason ?? "").toContain("surrogate");
        const surr = validateAgentAction({ kind: "set_engine", engine: "surrogate" }, ANALYTIC);
        expect(surr.ok).toBe(false);
        expect(surr.reason ?? "").toContain("[analytic, lbm]");
    });

    it("rejects out of domain setup envelopes with zero actions, so the executor stays idle", () => {
        const onAgentAction = vi.fn();
        const raw = "Airfoil at alpha 45 please.\n```action-json\n{\"kind\": \"setup_airfoil\", \"body\": \"naca4412\", \"alphaDeg\": 45}\n```";
        const out = parseAgentEnvelope(raw, NEURAL);
        expect(out.actions).toEqual([]);
        expect(out.rejections.length).toBeGreaterThan(0);
        for (const action of out.actions) onAgentAction(action);
        expect(onAgentAction).not.toHaveBeenCalled();
    });
});

describe("local phenomenological triggers", () => {
    it("maps vortex shedding and karman talk to the shedding preset", () => {
        const out = localReply("show me vortex shedding behind the cylinder", makeCtx());
        expect(out.actions).toEqual([{ kind: "setup_shedding" }]);
        expect(out.reply).toContain("shedding case");
        const karman = localReply("karman street please", makeCtx());
        expect(karman.actions).toEqual([{ kind: "setup_shedding" }]);
    });

    it("maps stagnation talk to the retired high pressure preset with the honest reason", () => {
        const out = localReply("show the stagnation high pressure zone", makeCtx());
        expect(out.actions).toEqual([{ kind: "set_field", field: "cp" }]);
        expect(out.rejections.join(" ")).toContain("diverges at every tested gap and Re");
        expect(out.reply).toContain("high pressure case is outside the serving envelope");
    });

    it("maps airfoil plus optional alpha to the airfoil preset", () => {
        const out = localReply("set up the airfoil at alpha 8", makeCtx());
        expect(out.actions).toEqual([{ kind: "setup_airfoil", alphaDeg: 8 }]);
        const named = localReply("airfoil naca 4412 alpha 2", makeCtx());
        expect(named.actions).toContainEqual({ kind: "setup_airfoil", body: "naca4412", alphaDeg: 2 });
    });

    it("asks one clarifying question for an invalid airfoil with canvas unchanged", () => {
        const out = localReply("set up airfoil naca 0099", makeCtx());
        expect(out.actions).toEqual([]);
        expect(out.reply).toContain("not a valid 4-digit section");
        expect(out.reply).toContain("Canvas unchanged");
    });

    it("stages any valid non-canonical airfoil through set_spec", () => {
        const out = localReply("set up airfoil naca 0015", makeCtx());
        const spec = out.actions.find((a) => a.kind === "set_spec");
        expect(spec).toBeDefined();
        expect(JSON.stringify(spec)).toContain("0015");
        expect(out.reply).toContain("Applying body naca0015");
    });

    it("maps cylinder stagnation talk to the high Re wake case with a Cp tutor note", () => {
        const out = localReply("show the high pressure zone on the cylinder", makeCtx());
        expect(out.actions).toContainEqual({ kind: "setup_high_re_wake" });
        expect(out.reply).toContain("Stagnation tutor note");
        expect(out.reply).toContain("Cp nears 1");
    });

    it("answers glossary questions with definitions and zero actions", () => {
        const cl = localReply("what is Cl", makeCtx());
        expect(cl.actions).toEqual([]);
        expect(cl.rejections).toEqual([]);
        expect(cl.reply).toContain("lift coefficient");
        expect(cl.reply).toContain("Cl 0.600");
        const cp = localReply("what is CpMin", makeCtx());
        expect(cp.actions).toEqual([]);
        expect(cp.reply).toContain("suction");
        expect(cp.reply).toContain("CpMin -1.200");
        const vort = localReply("what is vorticity", makeCtx());
        expect(vort.actions).toEqual([]);
        expect(vort.reply).toContain("swirl");
    });

    it("answers ambiguous setup with one question and zero actions", () => {
        const out = localReply("propose a redesign", makeCtx());
        expect(out.actions).toEqual([]);
        expect(out.reply).toContain("Staying on NACA 2412");
        expect(out.reply).toContain("Canvas unchanged");
    });
});

describe("local honest cannot do replies", () => {
    it("declines 3D with zero actions", () => {
        const out = localReply("run this in 3d", makeCtx());
        expect(out.actions).toEqual([]);
        expect(out.reply).toContain("Cannot do 3D");
        expect(out.reply).toContain("Canvas unchanged");
    });

    it("declines supersonic and compressible flow with zero actions", () => {
        const out = localReply("run a supersonic case", makeCtx());
        expect(out.actions).toEqual([]);
        expect(out.reply).toContain("Cannot do compressible or supersonic");
        const comp = localReply("show compressible effects", makeCtx());
        expect(comp.actions).toEqual([]);
        expect(comp.reply).toContain("incompressible");
    });

    it("declines viscous separation on the analytic path with zero actions", () => {
        const out = localReply("show the flow separation bubble", makeCtx());
        expect(out.actions).toEqual([]);
        expect(out.reply).toContain("Cannot show viscous separation");
        expect(out.reply).toContain("Canvas unchanged");
    });
});

describe("local run confirm and offline caps", () => {
    it("returns run_lbm for the confirm chip and never auto runs", () => {
        const live = makeCtx({
            lbm: {
                status: "live",
                hasSnapshot: true,
                effective: true,
                statsReady: true,
                stats: { samples: 10, step: 500, recircFraction: 0.1, cdMean: 0.02, clMean: 0.6, clRms: 0.01, strouhal: 0.2 },
            },
        });
        const out = localReply("run the lbm solve", live);
        expect(out.actions).toEqual([{ kind: "run_lbm" }]);
        expect(out.reply).toContain("confirm");
    });

    it("caps combined intents at five actions with a rejection note", () => {
        const live = makeCtx({
            lbm: {
                status: "live",
                hasSnapshot: true,
                effective: true,
                statsReady: true,
                stats: { samples: 10, step: 500, recircFraction: 0.1, cdMean: 0.02, clMean: 0.6, clRms: 0.01, strouhal: 0.2 },
            },
            field: { variable: "speed", effective: "speed", hasTke: true, hasRecirc: true },
        });
        const out = localReply(
            "set up naca 2412 alpha 6 at Re 80000, switch engine to lbm, show field k, and run the lbm solve",
            live
        );
        expect(out.actions.length).toBeLessThanOrEqual(5);
        expect(out.rejections.join(" ")).toContain("beyond 5");
    });
});

describe("context neural honesty", () => {
    it("adds an honesty line when the current case sits outside the neural domain", () => {
        const inDomain = buildAgentContext(snapshot());
        expect(inDomain.neural.available).toBe(false);
        expect(inDomain.neural.envelope).toContain("provisional neural envelope");
        expect(inDomain.neural.path).toBe("analytic");
        expect(inDomain.honesty.join(" ")).not.toContain("provisional neural envelope");
        const out = buildAgentContext(snapshot({ reynolds: 500000 }));
        expect(out.honesty.join(" ")).toContain("Outside the provisional neural envelope");
        const alphaOut = buildAgentContext(snapshot({ spec: { ...snapshot().spec, alphaDeg: 45 } }));
        expect(alphaOut.honesty.join(" ")).toContain("Analytic path serves this case");
    });

    it("reports neural availability plus the displayed path from the snapshot", () => {
        const ctx = buildAgentContext(snapshot({ neuralAvailable: true, displayedPath: "neural-v2" }));
        expect(ctx.neural.available).toBe(true);
        expect(ctx.neural.path).toBe("neural-v2");
    });
});
