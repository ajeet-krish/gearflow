// VerticalColorbar Phase 12b: log decade ticks for TKE, two state readout
// for recirculation, mean suffix for time mean fields, and no NaN on
// empty or constant fields.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import VerticalColorbar from "./VerticalColorbar";
import { kColorTicks, kLogScaleFor, normalizeKLogValue } from "@/flow/colormap";
import type { FlowField } from "@/contracts/types";
import { DEFAULT_DOMAIN } from "@/contracts/types";

function makeFlow(over: Partial<FlowField> = {}): FlowField {
    const nx = 8;
    const ny = 6;
    const n = nx * ny;
    const u = new Float32Array(n).fill(1);
    const v = new Float32Array(n);
    const p = new Float32Array(n);
    const omega = new Float32Array(n);
    const obstacle = new Float32Array(n);
    return { nx, ny, domain: { ...DEFAULT_DOMAIN }, u, v, p, omega, obstacle, ...over };
}

function render(flow: FlowField | null, variable: "speed" | "k" | "recirc" | "u", meanFields = false) {
    return renderToStaticMarkup(
        <VerticalColorbar
            flow={flow}
            variable={variable}
            colormap="viridis"
            visible={true}
            meanFields={meanFields}
        />,
    );
}

describe("VerticalColorbar scale awareness", () => {
    it("renders log decade ticks for TKE", () => {
        const n = 48;
        const k = new Float32Array(n);
        for (let i = 0; i < n; i++) k[i] = Math.pow(10, -5 + (4 * i) / (n - 1));
        const html = render(makeFlow({ k }), "k");
        expect(html).toContain("1e-1");
        expect(html).toContain("TKE");
    });

    it("renders a two state readout for recirculation", () => {
        const n = 48;
        const recirc = new Float32Array(n);
        for (let i = 0; i < n; i++) recirc[i] = i % 2;
        const html = render(makeFlow({ recirc }), "recirc");
        expect(html).toContain("REVERSE");
        expect(html).toContain("FLOW");
        expect(html).not.toContain("NaN");
    });

    it("shows no NaN for an empty flow", () => {
        const html = render(makeFlow(), "speed");
        expect(html).not.toContain("NaN");
    });

    it("shows no NaN for a constant nonzero field", () => {
        const n = 48;
        const flow = makeFlow({
            u: new Float32Array(n).fill(2),
            v: new Float32Array(n).fill(0),
        });
        const html = render(flow, "speed");
        expect(html).not.toContain("NaN");
    });

    it("shows no NaN for a null flow in any new mode", () => {
        for (const variable of ["k", "recirc"] as const) {
            const html = render(null, variable);
            expect(html).not.toContain("NaN");
            expect(html).not.toContain("n/a to n/a");
        }
    });

    it("shows no NaN for an all zero TKE field", () => {
        const html = render(makeFlow({ k: new Float32Array(48) }), "k");
        expect(html).not.toContain("NaN");
    });

    it("adds the mean suffix when mean fields are on", () => {
        const html = render(makeFlow({ uMean: new Float32Array(48).fill(0.5) }), "u", true);
        expect(html).toContain("(mean)");
    });

    it("omits the mean suffix for instantaneous fields", () => {
        const html = render(makeFlow({ uMean: new Float32Array(48).fill(0.5) }), "u", false);
        expect(html).not.toContain("(mean)");
    });
});

describe("VerticalColorbar endpoint accurate TKE ticks", () => {
    function kFlow(values: number[]): FlowField {
        const n = values.length;
        const k = new Float32Array(values);
        return makeFlow({ k });
    }

    it("labels a decade aligned range with exact decades at exact positions", () => {
        const n = 48;
        const values: number[] = [];
        for (let i = 0; i < n; i++) values.push(Math.pow(10, -5 + (4 * i) / (n - 1)));
        const flow = kFlow(values);
        const scale = kLogScaleFor(flow);
        expect(scale).not.toBeNull();
        const ticks = kColorTicks(scale!);
        expect(ticks.map((t) => t.label)).toEqual(["1e-1", "1e-2", "1e-3", "1e-4", "1e-5"]);
        for (const t of ticks) {
            expect(t.position).toBe(normalizeKLogValue(t.value, scale!));
        }
        expect(ticks[0].position).toBeCloseTo(1, 12);
        expect(ticks[ticks.length - 1].position).toBeCloseTo(0, 12);
        const html = render(flow, "k");
        expect(html).toContain("1e-1");
        expect(html).toContain("1e-5");
    });

    it("labels a non aligned 0.002 to 0.05 range with its actual endpoints", () => {
        const flow = kFlow([0.002, 0.05]);
        const scale = kLogScaleFor(flow);
        expect(scale).not.toBeNull();
        const ticks = kColorTicks(scale!);
        expect(ticks[0].label).toBe("5.0e-2");
        expect(ticks[ticks.length - 1].label).toBe("2.0e-3");
        for (const t of ticks) {
            expect(t.position).toBe(normalizeKLogValue(t.value, scale!));
        }
        expect(ticks[0].position).toBeCloseTo(1, 12);
        expect(ticks[ticks.length - 1].position).toBeCloseTo(0, 12);
        const html = render(flow, "k");
        expect(html).toContain("5.0e-2");
        expect(html).toContain("2.0e-3");
        expect(html).not.toContain("from 1e-2 to 1e-2");
    });

    it("labels a constant 0.25 field with its actual value, not 1e-1", () => {
        const flow = kFlow(new Array(48).fill(0.25));
        const scale = kLogScaleFor(flow);
        expect(scale).not.toBeNull();
        const ticks = kColorTicks(scale!);
        expect(ticks.length).toBeGreaterThanOrEqual(2);
        expect(ticks[0].label).toBe("2.5e-1");
        expect(ticks[ticks.length - 1].label).toBe("2.5e-1");
        expect(ticks[0].position).toBeCloseTo(1, 12);
        expect(ticks[ticks.length - 1].position).toBeCloseTo(0, 12);
        for (const t of ticks) {
            expect(t.position).toBe(normalizeKLogValue(t.value, scale!));
        }
        const html = render(flow, "k");
        expect(html).toContain("2.5e-1");
        expect(html).not.toContain("1e-1");
    });

    it("collapses an all zero TKE field to a single explicit zero tick", () => {
        const flow = kFlow(new Array(48).fill(0));
        const html = render(flow, "k");
        expect(html).toContain("from 0 to 0");
        expect((html.match(/>0</g) ?? []).length).toBe(1);
        expect(html).not.toContain("NaN");
    });
});
