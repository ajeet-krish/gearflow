// Phase B3 local assistant tests. Pure, deterministic, zero live calls.

import { describe, expect, it } from "vitest";
import type { AgentContext } from "./agentContext";
import { localReply } from "./localAssistant";

function makeCtx(over: Partial<AgentContext> = {}): AgentContext {
    return {
        spec: { kind: "naca4", alphaDeg: 6, reynolds: 50000 },
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
        ...over,
    };
}

function liveLbmCtx(): AgentContext {
    return makeCtx({
        lbm: {
            status: "live",
            hasSnapshot: true,
            effective: true,
            statsReady: true,
            stats: {
                samples: 100,
                step: 1000,
                recircFraction: 0.1,
                cdMean: 0.02,
                clMean: 0.6,
                clRms: 0.01,
                strouhal: 0.2,
            },
        },
        field: { variable: "speed", effective: "speed", hasTke: true, hasRecirc: true },
    });
}

describe("localReply explain", () => {
    it("cites Cl, CpMin, Re, and regime with one suggested change plus a caveat", () => {
        const out = localReply("please explain this run", makeCtx());
        expect(out.actions).toEqual([]);
        expect(out.reply).toContain("Cl 0.600");
        expect(out.reply).toContain("CpMin -1.200");
        expect(out.reply).toContain("50000");
        expect(out.reply).toContain("attached laminar");
        expect(out.reply).toContain("Suggested change");
        expect(out.reply).toContain("Caveat");
        expect(out.reply).toContain("Canvas unchanged");
    });

    it("names pending metrics instead of quoting poisoned numbers", () => {
        const out = localReply("explain", makeCtx({ cl: null, cpMin: null, reynolds: null }));
        expect(out.reply).toContain("pending a clean solve");
        expect(out.reply).not.toContain("NaN");
    });
});

describe("localReply tool help", () => {
    it("names the solver, field, and telemetry bars plus geometry and display windows", () => {
        const out = localReply("How do I change Re", makeCtx());
        expect(out.actions).toEqual([]);
        expect(out.reply).toContain("solver bar");
        expect(out.reply).toContain("SOLVER");
        expect(out.reply).toContain("FIELD");
        expect(out.reply).toContain("TELEMETRY");
        expect(out.reply).toContain("GEOMETRY");
        expect(out.reply).toContain("DISPLAY");
        expect(out.reply).toContain("Canvas unchanged");
    });
});

describe("localReply setup parsing", () => {
    it("parses NACA plus alpha into set actions", () => {
        const out = localReply("Set up NACA 2412 alpha 6", makeCtx());
        expect(out.actions).toContainEqual({ kind: "set_body", body: "naca2412" });
        expect(out.actions).toContainEqual({ kind: "set_alpha", alphaDeg: 6 });
        expect(out.rejections).toEqual([]);
        expect(out.reply).toContain("Canvas unchanged");
    });

    it("parses Re and body tokens for cylinder, block, and orifice", () => {
        const cyl = localReply("set up cylinder at Re 80000", makeCtx());
        expect(cyl.actions).toContainEqual({ kind: "set_body", body: "cylinder" });
        expect(cyl.actions).toContainEqual({ kind: "set_reynolds", reynolds: 80000 });
        const block = localReply("switch to block", makeCtx());
        expect(block.actions).toContainEqual({ kind: "set_body", body: "block" });
        const orifice = localReply("switch to orifice", makeCtx());
        expect(orifice.actions).toContainEqual({ kind: "set_body", body: "orifice" });
    });

    it("clamps alpha and Re to the schema envelopes with a notice", () => {
        const alpha = localReply("set alpha 200", makeCtx());
        expect(alpha.actions).toContainEqual({ kind: "set_alpha", alphaDeg: 180 });
        expect(alpha.reply).toContain("clamped");
        const re = localReply("set reynolds to 5", makeCtx());
        expect(re.actions).toContainEqual({ kind: "set_reynolds", reynolds: 1000 });
        expect(re.reply).toContain("clamped");
    });

    it("rejects unknown NACA codes while keeping the parsed alpha", () => {
        const out = localReply("set up naca 0015 alpha 6", makeCtx());
        expect(out.actions).toContainEqual({ kind: "set_alpha", alphaDeg: 6 });
        expect(out.actions.some((a) => a.kind === "set_body")).toBe(false);
        expect(out.rejections.join(" ")).toContain("0015");
    });

    it("defaults an ambiguous setup to the current body with one clarifying line", () => {
        const out = localReply("set up alpha 6", makeCtx());
        expect(out.actions.some((a) => a.kind === "set_body")).toBe(false);
        expect(out.actions).toContainEqual({ kind: "set_alpha", alphaDeg: 6 });
        expect(out.reply).toContain("Staying on NACA 2412");
        const bare = localReply("propose a redesign", makeCtx());
        expect(bare.actions).toEqual([]);
        expect(bare.reply).toContain("Staying on NACA 2412");
    });
});

describe("localReply engine, field, and run", () => {
    it("switches the engine on request", () => {
        const out = localReply("switch engine to lbm", makeCtx());
        expect(out.actions).toContainEqual({ kind: "set_engine", engine: "lbm" });
    });

    it("gates k and recirc until the first stats sample", () => {
        const gated = localReply("show field k", makeCtx());
        expect(gated.actions).toEqual([]);
        expect(gated.rejections.join(" ")).toContain("gated");
        const live = localReply("show field k", liveLbmCtx());
        expect(live.actions).toContainEqual({ kind: "set_field", field: "k" });
        const recircLive = localReply("switch field to recirc", liveLbmCtx());
        expect(recircLive.actions).toContainEqual({ kind: "set_field", field: "recirc" });
    });

    it("returns run_lbm for the confirm chip and never auto runs", () => {
        const out = localReply("run the lbm solve", liveLbmCtx());
        expect(out.actions).toEqual([{ kind: "run_lbm" }]);
        expect(out.reply).toContain("confirm");
        expect(out.reply).toContain("Canvas unchanged until confirm");
    });

    it("rejects run_lbm without a live LBM engine like the Baseten path", () => {
        const out = localReply("run the lbm solve", makeCtx());
        expect(out.actions).toEqual([]);
        expect(out.rejections.join(" ")).toContain("LBM");
    });
});

describe("localReply safety", () => {
    it("never throws on empty, blank, or non string input", () => {
        for (const bad of ["", "   ", null, undefined, 42, {}]) {
            const out = localReply(bad, makeCtx());
            expect(typeof out.reply).toBe("string");
            expect(out.reply.length).toBeGreaterThan(0);
            expect(out.actions).toEqual([]);
        }
    });

    it("never throws on a null context", () => {
        const out = localReply("explain this run", null);
        expect(out.reply).toContain("Canvas unchanged");
        const setup = localReply("set alpha 6", null);
        expect(setup.actions).toContainEqual({ kind: "set_alpha", alphaDeg: 6 });
    });

    it("falls back to a plain note for unrecognized chat", () => {
        const out = localReply("hello there", makeCtx());
        expect(out.actions).toEqual([]);
        expect(out.reply).toContain("Canvas unchanged");
    });
});
