import { describe, expect, it } from "vitest";
import { isUsableField } from "@/App";
import { DEFAULT_DOMAIN, type FlowField } from "@/contracts/types";

function cleanField(): FlowField {
    const nx = 4;
    const ny = 4;
    const n = nx * ny;
    const ones = (v: number): Float32Array => new Float32Array(n).fill(v);
    return {
        nx,
        ny,
        domain: { ...DEFAULT_DOMAIN },
        u: ones(1),
        v: ones(0),
        p: ones(-0.5),
        omega: ones(0.1),
        obstacle: ones(0),
    };
}

describe("isUsableField finite-field guard", () => {
    it("accepts a clean field", () => {
        const flow = cleanField();
        expect(isUsableField(flow, 0.8, -1.2)).toBe(true);
    });

    it("rejects a NaN in omega", () => {
        const flow = cleanField();
        flow.omega[5] = Number.NaN;
        expect(isUsableField(flow, 0.8, -1.2)).toBe(false);
    });

    it("rejects a non-finite omega entry", () => {
        const flow = cleanField();
        flow.omega[0] = Number.POSITIVE_INFINITY;
        expect(isUsableField(flow, 0.8, -1.2)).toBe(false);
    });
});
