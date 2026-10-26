// Parity guard: committed fixtures in public/demo-pack must match the live
// TypeScript modules. Regenerate with `npm run gen:fixtures` after changing
// src/flow/fakeFlow.ts, src/geometry/parametric.ts, or the fixture list.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateFakeFlow } from "./fakeFlow";
import { naca4Airfoil, transformPoints } from "@/geometry/parametric";
import { coerceFlowField, validateDemoPack, validatePackFlowConsistency, validateAirfoilPoints } from "@/contracts/schema";
import type { GeometrySpec } from "@/contracts/types";

const PACK_DIR = fileURLToPath(new URL("../../public/demo-pack", import.meta.url));

const CASES = [
    "naca2412-a6",
    "naca0012-a0",
    "cylinder-r025",
    "duct-h040",
    "block-w050-h020",
];

function loadJson(rel: string): unknown {
    return JSON.parse(readFileSync(`${PACK_DIR}/${rel}`, "utf8"));
}

function maxAbsDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
    expect(a.length).toBe(b.length);
    let max = 0;
    for (let k = 0; k < a.length; k++) {
        const d = Math.abs(a[k] - b[k]);
        if (d > max) max = d;
    }
    return max;
}

describe("fixture parity (script output vs TS modules)", () => {
    it("manifest validates and flow matches pack grid", () => {
        const manifest = loadJson("manifest.json");
        validateDemoPack(manifest);
        const pack = manifest as Parameters<typeof validatePackFlowConsistency>[0];
        const flowJson = loadJson((pack.files as { flow: string }).flow) as Parameters<typeof coerceFlowField>[0];
        const flow = coerceFlowField(flowJson);
        validatePackFlowConsistency(pack, flow);
    });

    it.each(CASES)("flow %s matches generateFakeFlow within rounding", (name) => {
        const geomJson = loadJson(`geometry/${name}.json`) as { geometry: GeometrySpec };
        const flowJson = loadJson(`flow/${name}-128x128.json`) as Parameters<typeof coerceFlowField>[0];
        const live = generateFakeFlow({ nx: 128, ny: 128, domain: flowJson.domain }, geomJson.geometry, name);
        const baked = coerceFlowField(flowJson);
        // Script rounds channels to 4 decimals; TS keeps Float32 precision.
        for (const ch of ["u", "v", "p", "omega"] as const) {
            expect(maxAbsDiff(live[ch], baked[ch])).toBeLessThanOrEqual(1e-4);
        }
        // Obstacle mask is exact 0/1 in both.
        expect(maxAbsDiff(live.obstacle, baked.obstacle)).toBe(0);
    });

    it.each(["naca2412-a6", "naca0012-a0"])("geometry %s matches naca4Airfoil plus transformPoints", (name) => {
        const geomJson = loadJson(`geometry/${name}.json`) as {
            geometry: GeometrySpec;
            points: { x: number; y: number }[];
        };
        const geom = geomJson.geometry;
        if (!geom.naca) throw new Error(`${name} fixture missing naca params`);
        validateAirfoilPoints(geomJson.points, { requireNonEmpty: true });
        const live = transformPoints(
            naca4Airfoil(geom.naca.m, geom.naca.p, geom.naca.t, geom.nPoints),
            0,
            0,
            geom.chord,
            geom.alphaDeg
        );
        expect(live.length).toBe(geomJson.points.length);
        for (let k = 0; k < live.length; k++) {
            expect(Math.abs(live[k].x - geomJson.points[k].x)).toBeLessThanOrEqual(1e-12);
            expect(Math.abs(live[k].y - geomJson.points[k].y)).toBeLessThanOrEqual(1e-12);
        }
    });
});
