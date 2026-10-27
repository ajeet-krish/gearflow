import { describe, expect, it } from "vitest";
import type { GeometrySpec } from "@/contracts/types";
import { ORIFICE_THICKNESS_DEFAULT } from "@/contracts/types";
import { buildPolygons } from "./parametric";
import { applyBodyPreset, bodySelectValue } from "./bodyPresets";

const BASE: GeometrySpec = {
    kind: "naca4",
    naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 },
    chord: 1,
    alphaDeg: 6,
    nPoints: 120,
};

describe("bodySelectValue", () => {
    it("returns the right token for each known NACA code", () => {
        expect(bodySelectValue({ ...BASE, naca: { code: "0012", m: 0, p: 0.4, t: 0.12 } })).toBe("naca0012");
        expect(bodySelectValue({ ...BASE, naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 } })).toBe("naca2412");
        expect(bodySelectValue({ ...BASE, naca: { code: "4412", m: 0.04, p: 0.4, t: 0.12 } })).toBe("naca4412");
    });

    it("falls back to the 2412 slot for tuned NACA shapes", () => {
        expect(bodySelectValue({ ...BASE, naca: { code: "2418", m: 0.02, p: 0.4, t: 0.18 } })).toBe("naca2412");
    });

    it("returns the kind for non-NACA bodies", () => {
        expect(bodySelectValue({ ...BASE, kind: "cylinder" })).toBe("cylinder");
        expect(bodySelectValue({ ...BASE, kind: "orifice" })).toBe("orifice");
        expect(bodySelectValue({ ...BASE, kind: "block" })).toBe("block");
    });
});

describe("applyBodyPreset", () => {
    it("sets exact NACA triples", () => {
        expect(applyBodyPreset(BASE, "naca0012").naca).toEqual({ code: "0012", m: 0, p: 0.4, t: 0.12 });
        expect(applyBodyPreset(BASE, "naca2412").naca).toEqual({ code: "2412", m: 0.02, p: 0.4, t: 0.12 });
        expect(applyBodyPreset(BASE, "naca4412").naca).toEqual({ code: "4412", m: 0.04, p: 0.4, t: 0.12 });
        expect(applyBodyPreset(BASE, "naca0012").kind).toBe("naca4");
    });

    it("sets cylinder radius and center", () => {
        const next = applyBodyPreset(BASE, "cylinder");
        expect(next.kind).toBe("cylinder");
        expect(next.radius).toBe(0.25);
        expect(next.center).toEqual({ x: 0.5, y: 0 });
    });

    it("sets orifice and block sizes", () => {
        const orifice = applyBodyPreset(BASE, "orifice");
        expect(orifice.width).toBe(0.08);
        expect(orifice.height).toBe(0.4);
        const block = applyBodyPreset(BASE, "block");
        expect(block.width).toBe(0.5);
        expect(block.height).toBe(0.5);
    });

    it("migrates a legacy duct token to the orifice plate", () => {
        const next = applyBodyPreset(
            { ...BASE, kind: "block", width: 1.0, height: 0.9, center: { x: 0.5, y: 0 } },
            "duct"
        );
        expect(next.kind).toBe("orifice");
        expect(next.width).toBe(0.08);
        expect(next.height).toBe(0.9);
    });

    it("returns the same spec object for unknown values", () => {
        expect(applyBodyPreset(BASE, "nope")).toBe(BASE);
    });

    it("resets a block width carried into the orifice preset", () => {
        const block = applyBodyPreset({ ...BASE, kind: "block", width: 0.5, height: 0.5 }, "block");
        const orifice = applyBodyPreset(block, "orifice");
        expect(orifice.kind).toBe("orifice");
        expect(orifice.width).toBe(ORIFICE_THICKNESS_DEFAULT);
        expect(orifice.height).toBe(0.5);
        expect(() => buildPolygons(orifice)).not.toThrow();
    });

    it("pins a block to orifice to block round trip without throwing", () => {
        const block = applyBodyPreset({ ...BASE, kind: "block", width: 0.5, height: 0.5 }, "block");
        const orifice = applyBodyPreset(block, "orifice");
        const back = applyBodyPreset(orifice, "block");
        expect(back.kind).toBe("block");
        expect(() => buildPolygons(block)).not.toThrow();
        expect(() => buildPolygons(orifice)).not.toThrow();
        expect(() => buildPolygons(back)).not.toThrow();
    });

    it("clamps out of envelope dims instead of throwing on preset hops", () => {
        const wide = applyBodyPreset({ ...BASE, kind: "block", width: 5, height: 5 }, "orifice");
        expect(wide.width).toBe(ORIFICE_THICKNESS_DEFAULT);
        expect(() => buildPolygons(wide)).not.toThrow();
    });
});
