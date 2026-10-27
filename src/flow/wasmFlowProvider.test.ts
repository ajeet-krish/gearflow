// WasmFlowProvider unit tests with a fake solver handle (no WASM, no window).
// Covers frame mapping, real solveMs telemetry, panel caching across Re
// changes and the App setGeometry(same spec) plus setRe order, field
// validation (finite channels, grid and domain match, panelCount), and
// failover latching on corrupt payloads.

import { describe, expect, it } from "vitest";
import { WasmFlowProvider, type WasmSolverHandle } from "./wasmFlowProvider";
import { DEFAULT_DOMAIN } from "@/contracts/types";
import type { GeometrySpec, GridSpec } from "@/contracts/types";

const GRID: GridSpec = { nx: 4, ny: 4, domain: { ...DEFAULT_DOMAIN } };

const GEOM: GeometrySpec = {
    kind: "naca4",
    naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 },
    chord: 1,
    alphaDeg: 6,
    nPoints: 48,
};

const N = GRID.nx * GRID.ny;

function channel(base: number): Float32Array {
    const arr = new Float32Array(N);
    for (let i = 0; i < N; i++) {
        arr[i] = base + i * 0.25;
    }
    return arr;
}

function makePayload() {
    const obstacle = new Float32Array(N);
    for (let i = 0; i < N; i++) {
        obstacle[i] = i % 5 === 0 ? 1 : 0;
    }
    const domain = { ...GRID.domain };
    return {
        domain,
        payload: {
            nx: GRID.nx,
            ny: GRID.ny,
            domain,
            u: channel(1),
            v: channel(2),
            p: channel(3),
            omega: channel(4),
            obstacle,
        },
    };
}

class FakeSolver implements WasmSolverHandle {
    resolveCalls = 0;
    fieldCalls = 0;
    summary = { cl: 0.5, cpMin: -1.2, panelCount: 8 };
    payload = makePayload();

    resolve(_geomJson: string, _uInf: number): unknown {
        this.resolveCalls += 1;
        return { ...this.summary };
    }

    field(_uInf: number, _re: number): unknown {
        this.fieldCalls += 1;
        return this.payload.payload;
    }
}

describe("WasmFlowProvider with a fake solver", () => {
    it("maps the 4x4 field payload into a FlowField", () => {
        const solver = new FakeSolver();
        const provider = new WasmFlowProvider(GRID, GEOM, {}, solver);
        const frame = provider.getFrame();
        expect(frame.nx).toBe(4);
        expect(frame.ny).toBe(4);
        expect(frame.domain).toEqual(GRID.domain);
        expect(frame.domain).not.toBe(solver.payload.domain);
        for (const key of ["u", "v", "p", "omega", "obstacle"] as const) {
            expect(frame[key].length).toBe(16);
            expect(Array.from(frame[key])).toEqual(
                Array.from(solver.payload.payload[key])
            );
        }
    });

    it("reports the resolve summary with a measured solveMs", () => {
        const solver = new FakeSolver();
        const provider = new WasmFlowProvider(GRID, GEOM, {}, solver);
        const result = provider.getResult();
        expect(result.cl).toBe(0.5);
        expect(result.cpMin).toBe(-1.2);
        expect(result.panelCount).toBe(8);
        expect(Number.isFinite(result.solveMs)).toBe(true);
        expect(result.solveMs).toBeGreaterThanOrEqual(0);
    });

    it("caches panels when getFrame is called twice with no changes", () => {
        const solver = new FakeSolver();
        const provider = new WasmFlowProvider(GRID, GEOM, {}, solver);
        const first = provider.getFrame();
        const second = provider.getFrame();
        expect(second).toBe(first);
        expect(solver.resolveCalls).toBe(1);
        expect(solver.fieldCalls).toBe(1);
        expect(provider.solveCount).toBe(1);
    });

    it("setRe rebuilds the field without re-resolving panels", () => {
        const solver = new FakeSolver();
        const provider = new WasmFlowProvider(GRID, GEOM, { Re: 1000 }, solver);
        provider.getFrame();
        expect(solver.resolveCalls).toBe(1);
        expect(solver.fieldCalls).toBe(1);
        provider.setRe(2000);
        provider.getFrame();
        expect(solver.resolveCalls).toBe(1);
        expect(solver.fieldCalls).toBe(2);
        expect(provider.solveCount).toBe(1);
    });

    it("latches to the analytic fallback on a NaN resolve payload", () => {
        const solver = new FakeSolver();
        solver.summary = { cl: NaN, cpMin: -1.2, panelCount: 8 };
        const provider = new WasmFlowProvider(GRID, GEOM, {}, solver);
        expect(provider.wasmFailed).toBe(false);
        provider.getFrame();
        expect(provider.wasmFailed).toBe(true);
        const result = provider.getResult();
        expect(Number.isFinite(result.cl)).toBe(true);
        expect(Number.isFinite(result.cpMin)).toBe(true);
        expect(provider.wasmFailed).toBe(true);
    });

    it("skips the panel re-resolve on the App call order: setGeometry(same spec) then setRe(new value)", () => {
        const solver = new FakeSolver();
        const provider = new WasmFlowProvider(GRID, GEOM, { Re: 1000 }, solver);
        provider.getFrame();
        expect(solver.resolveCalls).toBe(1);
        expect(solver.fieldCalls).toBe(1);
        provider.setGeometry({ ...GEOM, naca: { ...GEOM.naca as { code: string; m: number; p: number; t: number } } });
        provider.setRe(2000);
        provider.getFrame();
        expect(solver.resolveCalls).toBe(1);
        expect(solver.fieldCalls).toBe(2);
        expect(provider.solveCount).toBe(1);
        expect(provider.wasmFailed).toBe(false);
    });

    it("latches to analytic when omega has a NaN and serves the analytic frame", () => {
        const solver = new FakeSolver();
        solver.payload.payload.omega[3] = NaN;
        const provider = new WasmFlowProvider(GRID, GEOM, {}, solver);
        const frame = provider.getFrame();
        expect(provider.wasmFailed).toBe(true);
        expect(frame.nx).toBe(GRID.nx);
        expect(frame.ny).toBe(GRID.ny);
        for (const key of ["u", "v", "p", "omega", "obstacle"] as const) {
            for (const value of frame[key]) {
                expect(Number.isFinite(value)).toBe(true);
            }
        }
        const result = provider.getResult();
        expect(Number.isFinite(result.cl)).toBe(true);
        expect(Number.isFinite(result.cpMin)).toBe(true);
    });

    it("latches to analytic when the payload domain does not match the grid", () => {
        const solver = new FakeSolver();
        solver.payload.payload.domain = { xMin: 0, xMax: 1, yMin: 0, yMax: 1 };
        const provider = new WasmFlowProvider(GRID, GEOM, {}, solver);
        const frame = provider.getFrame();
        expect(provider.wasmFailed).toBe(true);
        expect(frame.domain).toEqual(GRID.domain);
    });

    it("latches to analytic when panelCount is NaN", () => {
        const solver = new FakeSolver();
        solver.summary = { cl: 0.5, cpMin: -1.2, panelCount: NaN };
        const provider = new WasmFlowProvider(GRID, GEOM, {}, solver);
        const frame = provider.getFrame();
        expect(provider.wasmFailed).toBe(true);
        expect(frame.nx).toBe(GRID.nx);
        const result = provider.getResult();
        expect(Number.isFinite(result.cl)).toBe(true);
    });
});
