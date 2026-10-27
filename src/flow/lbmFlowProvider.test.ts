// LbmFlowProvider: placeholder contract, blockage note, forces gating.
// No Worker or wasm involved.

import { describe, expect, it } from "vitest";
import { LbmFlowProvider, PROVENANCE_LBM_PLACEHOLDER } from "./lbmFlowProvider";
import { DEFAULT_DOMAIN } from "@/contracts/types";

function grid() {
    return { nx: 8, ny: 8, domain: { ...DEFAULT_DOMAIN } };
}

function geom() {
    return { kind: "cylinder" as const, chord: 1, alphaDeg: 0, nPoints: 32, radius: 0.25, center: { x: 0.5, y: 0 } };
}

function frame() {
    const n = 64;
    return {
        nx: 8, ny: 8, domain: { ...DEFAULT_DOMAIN },
        u: new Float32Array(n).fill(1),
        v: new Float32Array(n),
        p: new Float32Array(n),
        omega: new Float32Array(n),
        obstacle: new Float32Array(n),
    };
}

describe("LbmFlowProvider", () => {
    it("placeholder forces are null and the label says pending", () => {
        const p = new LbmFlowProvider(grid(), geom(), { Re: 1000 });
        p.setProgress(512, 8000, 1.5, 0.2);
        const f = p.forces();
        expect(f.cd).toBeNull();
        expect(f.cl).toBeNull();
        expect(p.hasSnapshot()).toBe(false);
        expect(p.getProvenanceLabel()).toBe(PROVENANCE_LBM_PLACEHOLDER);
        expect(p.getProvenanceLabel()).toContain("pending");
        // Placeholder frame is a uniform grid, never blank.
        const g = p.getFrame();
        expect(g.nx).toBe(8);
        expect(g.u[0]).toBe(1);
    });

    it("carries the blockage note in the provenance label after a snapshot", () => {
        const p = new LbmFlowProvider(grid(), geom(), { Re: 100 });
        p.setSnapshot(frame(), 100, 1.4, 0.3);
        expect(p.hasSnapshot()).toBe(true);
        const note = "blockage 25.0 percent exceeds 5 percent reference limit, Cd will read high";
        p.setBlockageNote(note);
        expect(p.getProvenanceLabel()).toContain(note);
        expect(p.getProvenanceLabel()).toContain("at Re 100");
        const f = p.forces();
        expect(f.cd).toBe(1.4);
        expect(f.cl).toBe(0.3);
    });

    it("clearSnapshot restores the pending placeholder", () => {
        const p = new LbmFlowProvider(grid(), geom(), { Re: 100 });
        p.setSnapshot(frame(), 100, 1.4, 0.3);
        expect(p.hasSnapshot()).toBe(true);
        p.clearSnapshot();
        expect(p.hasSnapshot()).toBe(false);
        expect(p.forces().cd).toBeNull();
        expect(p.getProvenanceLabel()).toBe(PROVENANCE_LBM_PLACEHOLDER);
    });

    it("placeholder carries no stats and reports not ready", () => {
        const p = new LbmFlowProvider(grid(), geom(), { Re: 100 });
        expect(p.stats()).toBeNull();
        expect(p.statsReady()).toBe(false);
        expect(p.getFrame().lbmStats).toBeUndefined();
    });

    it("returns the real stats after a snapshot", () => {
        const p = new LbmFlowProvider(grid(), geom(), { Re: 100 });
        const stats = {
            samples: 120, startStep: 8000, step: 20000, recircFraction: 0.1,
            cdMean: 1.4, clMean: 0.3, clRms: 0.05, strouhal: null as number | null,
        };
        const f = { ...frame(), uMean: new Float32Array(64).fill(0.5), lbmStats: stats };
        p.setSnapshot(f, 20000, 1.4, 0.3);
        expect(p.stats()).toBe(stats);
        expect(p.statsReady()).toBe(true);
        expect(p.getFrame().lbmStats).toBe(stats);
        expect(p.getFrame().uMean).toBe(f.uMean);
    });

    it("a snapshot with zero samples reports not ready", () => {
        const p = new LbmFlowProvider(grid(), geom(), { Re: 100 });
        const stats = {
            samples: 0, startStep: 8000, step: 100, recircFraction: 0,
            cdMean: 0, clMean: 0, clRms: 0, strouhal: null as number | null,
        };
        p.setSnapshot({ ...frame(), lbmStats: stats }, 100, 1.4, 0.3);
        expect(p.stats()).toBe(stats);
        expect(p.statsReady()).toBe(false);
    });
});
