// Grid change disposal: alternating grids 20 times must dispose every
// retired texture pair, leaving exactly one live pair. The canvas keeps a
// single WebGLRenderer for its lifetime (created once in effect 1), grid
// switches only rebuild plane geometry plus field textures, so no new
// WebGL context is allocated per switch.

import { describe, expect, it } from "vitest";
import {
    createFieldTextures,
    disposeFieldTextures,
    updateFieldTextures,
    type FieldTextures,
} from "./fieldTexture";
import type { FlowField } from "@/contracts/types";

function makeFlow(nx: number, ny: number): FlowField {
    const n = nx * ny;
    const u = new Float32Array(n);
    const v = new Float32Array(n);
    for (let k = 0; k < n; k++) {
        u[k] = (k % nx) / nx - 0.5;
        v[k] = Math.floor(k / nx) / ny - 0.5;
    }
    return {
        nx,
        ny,
        domain: { xMin: -0.5, xMax: 2, yMin: -1, yMax: 1 },
        u,
        v,
        p: new Float32Array(n),
        omega: new Float32Array(n),
        obstacle: new Float32Array(n),
    };
}

describe("FlowCanvas grid change disposal", () => {
    it("disposes retired textures across 20 grid switches with one live pair", () => {
        let live = 0;
        let disposed = 0;
        const track = (t: FieldTextures): FieldTextures => {
            live += 1;
            const fieldDispose = t.field.dispose.bind(t.field);
            const lutDispose = t.lut.dispose.bind(t.lut);
            let retired = false;
            const retire = (): void => {
                if (retired) return;
                retired = true;
                live -= 1;
                disposed += 1;
            };
            t.field.dispose = (): void => {
                retire();
                fieldDispose();
            };
            t.lut.dispose = (): void => {
                lutDispose();
            };
            return t;
        };

        let current: FieldTextures | null = null;
        for (let i = 0; i < 20; i += 1) {
            const wide = i % 2 === 0;
            const flow = makeFlow(wide ? 8 : 4, wide ? 6 : 4);
            if (current === null) {
                current = track(createFieldTextures(flow, "viridis", "speed"));
            } else {
                const next = updateFieldTextures(current, flow, "viridis", "speed");
                if (next !== current) track(next);
                current = next;
            }
        }
        expect(disposed).toBe(19);
        expect(live).toBe(1);
        expect(current?.nx).toBe(4);
        if (current !== null) disposeFieldTextures(current);
        expect(live).toBe(0);
        expect(disposed).toBe(20);
    });
});
