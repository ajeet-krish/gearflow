// Extreme NACA envelope: thick and aft-peak sections stay finite through
// the analytic path. The non-finite guard in analyticFlow is the backstop,
// this pins NACA 2385 (85% thick) plus 2985 (85% thick, 90% peak) as finite.
import { describe, expect, it } from "vitest";
import { generateAnalyticFlow } from "@/flow/analyticFlow";
import { isSchemaValidCode } from "@/agent/nacaParse";
import type { GridSpec } from "@/contracts/types";

const SMALL_GRID: GridSpec = { nx: 48, ny: 32, domain: { xMin: -0.5, xMax: 2, yMin: -1, yMax: 1 } };

function frameFor(code: string, m: number, p: number, t: number) {
    return generateAnalyticFlow(
        SMALL_GRID,
        { kind: "naca4", naca: { code, m, p, t }, chord: 1, alphaDeg: 6, nPoints: 120 },
        { U: 1, Re: 50000 }
    );
}

describe("extreme NACA envelope stays finite", () => {
    it("validates NACA 2385 in the widened envelope", () => {
        const check = isSchemaValidCode("2385");
        expect(check.ok).toBe(true);
        expect(check.t).toBeCloseTo(0.85, 10);
        expect(check.p).toBeCloseTo(0.3, 10);
    });

    it("generates a finite analytic frame for NACA 2385", () => {
        const res = frameFor("2385", 0.02, 0.3, 0.85);
        expect(Number.isFinite(res.cl)).toBe(true);
        expect(Number.isFinite(res.cpMin)).toBe(true);
        const { field } = res;
        const n = field.nx * field.ny;
        expect(field.u.length).toBe(n);
        let bad = 0;
        for (let k = 0; k < n; k++) {
            if (!Number.isFinite(field.u[k]) || !Number.isFinite(field.v[k]) || !Number.isFinite(field.p[k]) || !Number.isFinite(field.omega[k])) {
                bad += 1;
            }
        }
        expect(bad).toBe(0);
    });

    it("generates a finite analytic frame for aft peak p=0.9 (NACA 2985)", () => {
        const check = isSchemaValidCode("2985");
        expect(check.ok).toBe(true);
        expect(check.p).toBeCloseTo(0.9, 10);
        const res = frameFor("2985", 0.02, 0.9, 0.85);
        expect(Number.isFinite(res.cl)).toBe(true);
        expect(Number.isFinite(res.cpMin)).toBe(true);
    });
});
