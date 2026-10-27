// Streamline builder: deterministic, terminates at obstacles, capped.

import { describe, expect, it } from "vitest";
import { buildStreamlines, integrateStreamline } from "@/render/streamlines";
import type { FlowField } from "@/contracts/types";

function uniformFlow(nx: number, ny: number, u = 1, v = 0): FlowField {
    const n = nx * ny;
    return {
        nx,
        ny,
        domain: { xMin: -0.5, xMax: 2, yMin: -1, yMax: 1 },
        u: new Float32Array(n).fill(u),
        v: new Float32Array(n).fill(v),
        p: new Float32Array(n),
        omega: new Float32Array(n),
        obstacle: new Float32Array(n),
    };
}

function flowWithBlock(nx: number, ny: number): FlowField {
    const flow = uniformFlow(nx, ny);
    const cx = Math.floor(nx / 2);
    const cy = Math.floor(ny / 2);
    for (let j = cy - 4; j <= cy + 4; j += 1) {
        for (let i = cx - 2; i <= cx + 2; i += 1) {
            flow.obstacle[j * nx + i] = 1;
        }
    }
    return flow;
}

describe("streamlines", () => {
    it("builds byte identical output twice", () => {
        const flow = uniformFlow(32, 32);
        const a = buildStreamlines(flow);
        const b = buildStreamlines(flow);
        expect(a.segmentCount).toBe(b.segmentCount);
        expect(a.lineCount).toBe(b.lineCount);
        expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
        expect(Array.from(a.colors)).toEqual(Array.from(b.colors));
    });

    it("produces a straight constant-y line in a uniform field", () => {
        const flow = uniformFlow(32, 32);
        const pts = integrateStreamline(flow, { x: -0.4, y: 0.3 });
        expect(pts.length).toBeGreaterThan(10);
        for (const p of pts) {
            expect(p.y).toBeCloseTo(0.3, 6);
            expect(p.x).toBeGreaterThanOrEqual(-0.5);
        }
        for (let i = 1; i < pts.length; i += 1) {
            expect(pts[i].x).toBeGreaterThan(pts[i - 1].x);
        }
    });

    it("terminates a line at an obstacle", () => {
        const flow = flowWithBlock(64, 64);
        const y = 0;
        const pts = integrateStreamline(flow, { x: -0.4, y });
        expect(pts.length).toBeGreaterThan(1);
        const last = pts[pts.length - 1];
        // Block center maps near x 0.75. The line must stop before crossing it.
        expect(last.x).toBeLessThan(0.75);
    });

    it("stays under the segment cap at 256", () => {
        const flow = uniformFlow(256, 256);
        const built = buildStreamlines(flow);
        expect(built.segmentCount).toBeLessThanOrEqual(60000);
        expect(built.positions.length).toBe(built.segmentCount * 6);
        expect(built.colors.length).toBe(built.segmentCount * 6);
    });

    it("keeps the running segment accounting capped on a mid size field", () => {
        const flow = uniformFlow(64, 64);
        const built = buildStreamlines(flow);
        expect(built.segmentCount).toBeLessThanOrEqual(60000);
        expect(built.lineCount).toBeGreaterThan(0);
        expect(built.positions.length).toBe(built.segmentCount * 6);
        expect(built.colors.length).toBe(built.segmentCount * 6);
    });
});
