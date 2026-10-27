// Rust/WASM parity guard. Each golden fixture under __golden__/wasm was
// baked from the TS analytic solver by scripts/gen-wasm-golden.mjs. This
// suite checks the fixtures still match the TS solver (self-consistency),
// and when the built wasm-pack package is present it instantiates the Rust
// solver and checks Rust vs TS parity: exact obstacle equality, tight
// cl/cpMin agreement, and max abs diff <= 1e-6 on u, v, p, omega.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateAnalyticFlow } from "./analyticFlow";
import type { FlowField } from "@/contracts/types";

const goldenDir = join(dirname(fileURLToPath(import.meta.url)), "__golden__", "wasm");
const goldenFiles = readdirSync(goldenDir).filter((f) => f.endsWith(".json")).sort();

interface Golden {
    name: string;
    grid: { nx: number; ny: number; domain: { xMin: number; xMax: number; yMin: number; yMax: number } };
    geom: any;
    params: { U: number; Re: number };
    cl: number;
    cpMin: number;
    panelCount: number;
    field: { nx: number; ny: number; u: number[]; v: number[]; p: number[]; omega: number[]; obstacle: number[] };
}

function loadGolden(name: string): Golden {
    return JSON.parse(readFileSync(join(goldenDir, name), "utf8")) as Golden;
}

function maxAbsDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
    let m = 0;
    for (let i = 0; i < a.length; i++) {
        const d = Math.abs(a[i] - b[i]);
        if (d > m) m = d;
    }
    return m;
}

async function tryInitWasm(): Promise<any | null> {
    try {
        const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..", "wasm", "pkg");
        const mod = (await import(`../wasm/pkg/gearflow_wasm.js`)) as any;
        const bytes = readFileSync(join(pkgDir, "gearflow_wasm_bg.wasm"));
        await mod.default(bytes);
        return mod;
    } catch {
        return null;
    }
}

describe("wasm golden self-consistency (TS vs baked fixtures)", () => {
    for (const file of goldenFiles) {
        it(`matches TS solver for ${file}`, () => {
            const g = loadGolden(file);
            const result = generateAnalyticFlow(g.grid, g.geom, g.params);
            expect(result.cl).toBe(g.cl);
            expect(result.cpMin).toBe(g.cpMin);
            expect(result.panelCount).toBe(g.panelCount);
            const f = result.field;
            expect(maxAbsDiff(f.u, g.field.u)).toBeLessThanOrEqual(1e-6);
            expect(maxAbsDiff(f.v, g.field.v)).toBeLessThanOrEqual(1e-6);
            expect(maxAbsDiff(f.p, g.field.p)).toBeLessThanOrEqual(1e-6);
            expect(maxAbsDiff(f.omega, g.field.omega)).toBeLessThanOrEqual(1e-6);
            expect(Array.from(f.obstacle)).toEqual(g.field.obstacle);
        });
    }
});

describe("wasm parity (Rust vs TS)", () => {
    it("instantiates the Rust solver and matches the TS field", async () => {
        const mod = await tryInitWasm();
        if (!mod) {
            console.log("wasm package not usable in this environment, skipping Rust parity assertions");
            return;
        }
        for (const file of goldenFiles) {
            const g = loadGolden(file);
            const solver = new mod.WasmSolver(
                g.grid.nx,
                g.grid.ny,
                g.grid.domain.xMin,
                g.grid.domain.xMax,
                g.grid.domain.yMin,
                g.grid.domain.yMax
            );
            const summary = solver.resolve(JSON.stringify(g.geom), g.params.U) as {
                cl: number;
                cpMin: number;
                panelCount: number;
            };
            expect(summary.panelCount).toBe(g.panelCount);
            expect(Math.abs(summary.cl - g.cl)).toBeLessThanOrEqual(1e-9);
            expect(Math.abs(summary.cpMin - g.cpMin)).toBeLessThanOrEqual(1e-9);
            const raw = solver.field(g.params.U, g.params.Re) as {
                nx: number;
                ny: number;
                u: Float32Array;
                v: Float32Array;
                p: Float32Array;
                omega: Float32Array;
                obstacle: Float32Array;
            };
            const ts: FlowField = generateAnalyticFlow(g.grid, g.geom, g.params).field;
            expect(Array.from(raw.obstacle)).toEqual(Array.from(ts.obstacle));
            expect(maxAbsDiff(raw.u, ts.u)).toBeLessThanOrEqual(1e-6);
            expect(maxAbsDiff(raw.v, ts.v)).toBeLessThanOrEqual(1e-6);
            expect(maxAbsDiff(raw.p, ts.p)).toBeLessThanOrEqual(1e-6);
            expect(maxAbsDiff(raw.omega, ts.omega)).toBeLessThanOrEqual(1e-6);
        }
    });
});
