import { describe, it, expect } from "vitest";
import { generateFakeFlow, wakeProfile } from "./fakeFlow";
import { DEFAULT_GRID } from "@/contracts/types";
import type { GeometrySpec } from "@/contracts/types";

describe("fakeFlow", () => {
    it("finite and deterministic", () => {
        const geom = { kind: "naca4" as const, naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 }, chord: 1, alphaDeg: 6, nPoints: 60 };
        const a = generateFakeFlow(DEFAULT_GRID, geom, "naca2412-a6");
        const b = generateFakeFlow(DEFAULT_GRID, geom, "naca2412-a6");
        expect(a.u.length).toBe(128 * 128);
        for (let k = 0; k < a.u.length; k++) {
            expect(Number.isFinite(a.u[k])).toBe(true);
            expect(Number.isFinite(a.v[k])).toBe(true);
            expect(Number.isFinite(a.p[k])).toBe(true);
            expect(Number.isFinite(a.omega[k])).toBe(true);
            expect(a.u[k]).toBe(b.u[k]);
            expect(a.omega[k]).toBe(b.omega[k]);
        }
        // Obstacle marks body cells
        const blocked = a.obstacle.reduce((s, x) => s + x, 0);
        expect(blocked).toBeGreaterThan(10);
    });

    it("masks every supported kind", () => {
        const kinds: GeometrySpec[] = [
            { kind: "cylinder", chord: 1, alphaDeg: 0, nPoints: 64, radius: 0.25, center: { x: 0.5, y: 0 } },
            { kind: "block", chord: 1, alphaDeg: 0, nPoints: 64, width: 0.5, height: 0.2, center: { x: 0.5, y: 0 } },
            { kind: "orifice", chord: 1, alphaDeg: 0, nPoints: 64, width: 0.08, height: 0.4, center: { x: 0.5, y: 0 } },
        ];
        for (const geom of kinds) {
            const f = generateFakeFlow(DEFAULT_GRID, geom, `mask-${geom.kind}`);
            const blocked = f.obstacle.reduce((s, x) => s + x, 0);
            expect(blocked).toBeGreaterThan(10);
            // Orifice walls leave the gap open: centreline at x = 0.5 is clear.
            if (geom.kind === "orifice") {
                const i = Math.round(((0.5 - -0.5) / 2.5) * 127);
                const j = Math.round(((0 - -1.0) / 2.0) * 127);
                expect(f.obstacle[j * 128 + i]).toBe(0);
            }
        }
    });

    it("positive alpha deflects the wake downward", () => {
        const geom: GeometrySpec = {
            kind: "naca4",
            naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 },
            chord: 1,
            alphaDeg: 10,
            nPoints: 60,
        };
        const f = generateFakeFlow(DEFAULT_GRID, geom, "naca2412-a10");
        const at = (x: number, y: number): number => {
            const i = Math.round(((x - -0.5) / 2.5) * 127);
            const j = Math.round(((y - -1.0) / 2.0) * 127);
            return f.u[j * 128 + i];
        };
        // Wake centreline sits below y = 0, so the deficit is deeper at y = -0.3.
        expect(at(1.5, -0.3)).toBeLessThan(at(1.5, 0.3));
    });

    it("wakeProfile centres on the body with downwash slope from alpha", () => {
        const naca: GeometrySpec = {
            kind: "naca4",
            naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 },
            chord: 1,
            alphaDeg: 6,
            nPoints: 60,
        };
        const { slope } = wakeProfile(naca, null);
        expect(slope).toBeLessThan(0);
        const flat: GeometrySpec = { kind: "cylinder", chord: 1, alphaDeg: 0, nPoints: 8, radius: 0.25, center: { x: 0.5, y: 0.2 } };
        const centred = wakeProfile(flat, null);
        expect(centred.baseY).toBeCloseTo(0.2, 12);
        expect(centred.slope).toBeCloseTo(0, 12);
    });
});
