import { describe, it, expect } from "vitest";
import { applyWake } from "./wake";
import { DEFAULT_GRID } from "@/contracts/types";

describe("applyWake guards", () => {
    function channels(nx: number, ny: number): { u: Float32Array; v: Float32Array; obstacle: Float32Array } {
        const n = nx * ny;
        return { u: new Float32Array(n).fill(1), v: new Float32Array(n), obstacle: new Float32Array(n) };
    }

    it("requires nx and ny >= 4 to match GridSpec", () => {
        const { u, v, obstacle } = channels(4, 4);
        expect(() => applyWake(u, v, 3, 4, DEFAULT_GRID.domain, obstacle, { U: 1, Re: 1000, baseY: 0, slope: 0 })).toThrow(/integers >= 4/);
        expect(() => applyWake(u, v, 4, 2, DEFAULT_GRID.domain, obstacle, { U: 1, Re: 1000, baseY: 0, slope: 0 })).toThrow(/integers >= 4/);
        expect(() => applyWake(u, v, 4, 4, DEFAULT_GRID.domain, obstacle, { U: 1, Re: 1000, baseY: 0, slope: 0 })).not.toThrow();
    });

    it("leaves upstream cells untouched", () => {
        const nx = 8;
        const ny = 8;
        const { u, v, obstacle } = channels(nx, ny);
        const before = u.slice();
        applyWake(u, v, nx, ny, DEFAULT_GRID.domain, obstacle, { U: 1, Re: 1000, baseY: 0, slope: 0 });
        const { domain } = DEFAULT_GRID;
        for (let j = 0; j < ny; j++) {
            for (let i = 0; i < nx; i++) {
                const x = domain.xMin + ((domain.xMax - domain.xMin) * i) / (nx - 1);
                const k = j * nx + i;
                if (x <= 0.8) expect(u[k]).toBe(before[k]);
            }
        }
    });
});
