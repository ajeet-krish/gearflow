// Phase B2 agent App wiring assertions: behavioral executor plus engine
// URL mirror coverage. Drives the real envelope validator, the real engine
// mode parser, and the real context builders, so a dropped action kind, a
// broken gate, or a lost pending LBM flag fails here. No source reads, no
// Worker or browser needed.

import { describe, expect, it } from "vitest";
import { parseAgentEnvelope } from "./agentActions";
import { buildAgentContext } from "./agentContext";
import { readEngineMode, type EngineMode } from "@/flow/engineMode";
import { validationContextFor } from "@/ui/AgentConsole";

const LIVE = { lbmEffective: true, statsReady: true, hasTke: true, hasRecirc: true };
const GATED = { lbmEffective: false, statsReady: false, hasTke: false, hasRecirc: false };

const VALID_PARAMETRIC = {
    geometry: {
        kind: "naca4",
        naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 },
        chord: 1,
        alphaDeg: 6,
        nPoints: 100,
    },
    reynolds: 200000,
    rationale: "Behavioral wiring probe.",
};

function fence(payload: unknown): string {
    return `wiring probe\n\`\`\`action-json\n${JSON.stringify(payload)}\n\`\`\``;
}

function pendingSnapshot(): Record<string, unknown> {
    return {
        spec: { kind: "naca4", naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 }, chord: 1, alphaDeg: 6, nPoints: 120 },
        reynolds: 50000,
        regime: "laminar, attached",
        bodyLabel: "NACA 2412",
        backend: "lbm pending",
        engine: "lbm",
        gridLabel: "128x128",
        cl: Number.NaN,
        cpMin: Number.NaN,
        lbmStatus: "idle",
        lbmHasSnapshot: false,
        lbmEffective: true,
        lbmStatsReady: false,
        lbmStats: null,
        variable: "speed",
        effectiveVariable: "speed",
        hasTke: false,
        hasRecirc: false,
        validation: { pass: 0, warn: 0, fail: 0, info: 0 },
        provenanceLabel: "lbm pending placeholder",
        offline: false,
    };
}

describe("agent App wiring", () => {
    it("validates every executor action kind against the live context", () => {
        const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
            [{ kind: "set_body", body: "naca2412" }, { kind: "set_body", body: "naca2412" }],
            [{ kind: "set_alpha", alphaDeg: 6 }, { kind: "set_alpha", alphaDeg: 6 }],
            [{ kind: "set_reynolds", reynolds: 50000 }, { kind: "set_reynolds", reynolds: 50000 }],
            [{ kind: "set_engine", engine: "lbm" }, { kind: "set_engine", engine: "lbm" }],
            [{ kind: "set_field", field: "speed" }, { kind: "set_field", field: "speed" }],
            [{ kind: "run_lbm" }, { kind: "run_lbm" }],
            [{ kind: "cancel_lbm" }, { kind: "cancel_lbm" }],
            [{ kind: "set_spec", spec: VALID_PARAMETRIC }, { kind: "set_spec", spec: VALID_PARAMETRIC }],
        ];
        for (const [payload, expected] of cases) {
            const out = parseAgentEnvelope(fence(payload), LIVE);
            expect(out.actions).toEqual([expected]);
            expect(out.rejections).toEqual([]);
        }
    });

    it("gates TKE, recirc, run, and out of bounds actions on live state", () => {
        const gatedK = parseAgentEnvelope(fence({ kind: "set_field", field: "k" }), GATED);
        expect(gatedK.actions).toEqual([]);
        expect(gatedK.rejections.join(" ")).toContain("gated");
        const gatedRun = parseAgentEnvelope(fence({ kind: "run_lbm" }), GATED);
        expect(gatedRun.actions).toEqual([]);
        expect(gatedRun.rejections.join(" ")).toContain("run_lbm");
        const liveK = parseAgentEnvelope(fence({ kind: "set_field", field: "k" }), LIVE);
        expect(liveK.actions).toEqual([{ kind: "set_field", field: "k" }]);
        const liveRun = parseAgentEnvelope(fence({ kind: "run_lbm" }), LIVE);
        expect(liveRun.actions).toEqual([{ kind: "run_lbm" }]);
        const badAlpha = parseAgentEnvelope(fence({ kind: "set_alpha", alphaDeg: 20 }), LIVE);
        expect(badAlpha.actions).toEqual([]);
        expect(badAlpha.rejections.join(" ")).toContain("alphaDeg");
    });

    it("keeps the engine URL mirror mapping on the real parser", () => {
        expect(readEngineMode("?engine=lbm")).toBe("lbm");
        expect(readEngineMode("?engine=wasm")).toBe("wasm");
        expect(readEngineMode("?wasm=1")).toBe("wasm");
        expect(readEngineMode("?engine=analytic&wasm=1")).toBe("analytic");
        expect(readEngineMode("?engine=bogus")).toBe("analytic");
        expect(readEngineMode("")).toBe("analytic");
        const mirrored: Record<EngineMode, string> = {
            analytic: "/",
            wasm: "/?engine=wasm",
            lbm: "/?engine=lbm",
        };
        expect(readEngineMode(new URL(`https://demo.local${mirrored.lbm}`).search)).toBe("lbm");
        expect(readEngineMode(new URL(`https://demo.local${mirrored.wasm}`).search)).toBe("wasm");
        expect(readEngineMode(new URL(`https://demo.local${mirrored.analytic}`).search)).toBe("analytic");
    });

    it("builds the pending LBM snapshot the console confirm path consumes", () => {
        const ctx = buildAgentContext(pendingSnapshot() as never);
        expect(ctx.engine).toBe("lbm");
        expect(ctx.lbm.effective).toBe(true);
        expect(ctx.honesty.join(" ")).toContain("pending");
        const validation = validationContextFor(ctx);
        expect(validation.lbmEffective).toBe(true);
        const run = parseAgentEnvelope(fence({ kind: "run_lbm" }), validation);
        expect(run.actions).toEqual([{ kind: "run_lbm" }]);
        expect(run.rejections).toEqual([]);
    });
});
