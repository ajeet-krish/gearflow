// Generates Rust/WASM parity golden fixtures from the TS analytic solver.
// Run: node --import tsx/esm scripts/gen-wasm-golden.mjs
// (npm run gen:wasm-golden). Requires the tsx --import flag because tsx no
// longer supports programmatic loader registration on modern Node.
//
// SINGLE SOURCE OF TRUTH: the canonical flow logic lives in TypeScript
// (src/flow/analyticFlow.ts). This script imports that module through the
// tsx ESM loader (no .mjs math mirrors) and bakes small-grid golden
// fixtures under src/flow/__golden__/wasm/. The parity guard runs:
// npm test -- wasmParity

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// @ts-ignore TS module imported through the tsx ESM loader at runtime.
const { generateAnalyticFlow } = await import("../src/flow/analyticFlow.ts");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outBase = join(root, "src", "flow", "__golden__", "wasm");

const domain = { xMin: -0.5, xMax: 2.0, yMin: -1.0, yMax: 1.0 };
const grid = { nx: 48, ny: 32, domain };

const cases = [
    {
        name: "naca2412-a6-re1000",
        geom: {
            kind: "naca4",
            naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 },
            chord: 1,
            alphaDeg: 6,
            nPoints: 100,
        },
        params: { U: 1, Re: 1000 },
    },
    {
        name: "naca2412-a6-re50000",
        geom: {
            kind: "naca4",
            naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 },
            chord: 1,
            alphaDeg: 6,
            nPoints: 100,
        },
        params: { U: 1, Re: 50000 },
    },
    {
        name: "naca0012-a0-re1000",
        geom: {
            kind: "naca4",
            naca: { code: "0012", m: 0, p: 0.4, t: 0.12 },
            chord: 1,
            alphaDeg: 0,
            nPoints: 100,
        },
        params: { U: 1, Re: 1000 },
    },
    {
        name: "cylinder-r025-re1000",
        geom: {
            kind: "cylinder",
            chord: 1,
            alphaDeg: 0,
            nPoints: 64,
            radius: 0.25,
            center: { x: 0.5, y: 0 },
        },
        params: { U: 1, Re: 1000 },
    },
    {
        name: "block-re1000",
        geom: {
            kind: "block",
            chord: 1,
            alphaDeg: 4,
            nPoints: 64,
            width: 0.5,
            height: 0.2,
            center: { x: 0.5, y: 0 },
        },
        params: { U: 1, Re: 1000 },
    },
    {
        name: "orifice-re1000",
        geom: {
            kind: "orifice",
            chord: 1,
            alphaDeg: 0,
            nPoints: 64,
            width: 0.08,
            height: 0.4,
            center: { x: 0.5, y: 0 },
        },
        params: { U: 1, Re: 1000 },
    },
];

mkdirSync(outBase, { recursive: true });

for (const c of cases) {
    const result = generateAnalyticFlow(grid, c.geom, c.params);
    const golden = {
        name: c.name,
        grid,
        geom: c.geom,
        params: c.params,
        cl: result.cl,
        cpMin: result.cpMin,
        panelCount: result.panelCount,
        field: {
            nx: result.field.nx,
            ny: result.field.ny,
            domain: result.field.domain,
            u: Array.from(result.field.u),
            v: Array.from(result.field.v),
            p: Array.from(result.field.p),
            omega: Array.from(result.field.omega),
            obstacle: Array.from(result.field.obstacle),
        },
    };
    writeFileSync(join(outBase, `${c.name}.json`), JSON.stringify(golden));
    console.log(`Wrote ${c.name}: cl=${result.cl.toFixed(5)} cpMin=${result.cpMin.toFixed(4)} panels=${result.panelCount}`);
}
console.log(`Golden fixtures in ${outBase}`);
