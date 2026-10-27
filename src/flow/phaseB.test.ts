// Phase B backend pins: orifice geometry, full rotation alpha, grid
// presets plus custom, non-blocking Reynolds parser, migration.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    migrateDuctToOrifice,
    orificePolygons,
} from "@/geometry/parametric";
import { applyBodyPreset } from "@/geometry/bodyPresets";
import { alphaBand, alphaOutOfBandNote } from "@/contracts/schema";
import {
    CUSTOM_GRID_MAX,
    CUSTOM_GRID_MIN,
    ORIFICE_GAP_DEFAULT,
    ORIFICE_THICKNESS_DEFAULT,
} from "@/contracts/types";
import { blockageForGeometry } from "@/flow/engineMode";
import { DEFAULT_DOMAIN } from "@/contracts/types";
import { initialResolution, parseCustomGrid, setGridMode } from "@/flow/gridController";
import { commitReynoldsValue, parseReynoldsField } from "@/flow/reynoldsField";
import { wakeSlopeForAlpha } from "@/flow/wake";

describe("orifice geometry", () => {
    it("returns two segments via the rectangle sampler with an open gap", () => {
        const walls = orificePolygons(0.5, 0, ORIFICE_THICKNESS_DEFAULT, ORIFICE_GAP_DEFAULT, 64);
        expect(walls).toHaveLength(2);
        const upperMinY = Math.min(...walls[0].map((p) => p.y));
        const lowerMaxY = Math.max(...walls[1].map((p) => p.y));
        expect(upperMinY).toBeCloseTo(ORIFICE_GAP_DEFAULT / 2, 12);
        expect(lowerMaxY).toBeCloseTo(-ORIFICE_GAP_DEFAULT / 2, 12);
    });

    it("rejects gap and thickness outside the envelope", () => {
        expect(() => orificePolygons(0.5, 0, 0.005, 0.4, 64)).toThrow(/thickness/);
        expect(() => orificePolygons(0.5, 0, 0.08, 0.01, 64)).toThrow(/gap/);
        expect(() => orificePolygons(0.5, 0, 0.08, 2.5, 64)).toThrow(/gap/);
    });

    it("migrates a legacy duct spec to the orifice plate", () => {
        const next = migrateDuctToOrifice({
            kind: "duct",
            chord: 1,
            alphaDeg: 0,
            nPoints: 64,
            width: 1.0,
            height: 0.9,
            center: { x: 0.5, y: 0 },
        } as unknown as Parameters<typeof migrateDuctToOrifice>[0]);
        expect(next.kind).toBe("orifice");
        expect(next.width).toBe(ORIFICE_THICKNESS_DEFAULT);
        expect(next.height).toBe(0.9);
        const passthrough = applyBodyPreset(
            { kind: "block", chord: 1, alphaDeg: 0, nPoints: 8, width: 0.5, height: 0.5 },
            "block"
        );
        expect(passthrough.kind).toBe("block");
    });
});

describe("alpha band", () => {
    it("accepts full rotation with an honest out-of-band note", () => {
        expect(alphaBand(6)).toBe("characterized");
        expect(alphaBand(45)).toBe("out-of-band");
        expect(alphaOutOfBandNote(6)).toBeNull();
        expect(alphaOutOfBandNote(45)).toContain("outside the characterized band");
    });

    it("clamps the wake slope to the characterized band", () => {
        expect(wakeSlopeForAlpha(6)).toBeLessThan(0);
        expect(wakeSlopeForAlpha(90)).toBe(wakeSlopeForAlpha(12));
        expect(wakeSlopeForAlpha(-90)).toBe(wakeSlopeForAlpha(-4));
        expect(wakeSlopeForAlpha(Number.NaN)).toBe(0);
    });

    it("reports orifice blockage from the gap opening", () => {
        const out = blockageForGeometry(
            { kind: "orifice", chord: 1, alphaDeg: 0, nPoints: 64, width: 0.08, height: 0.4, center: { x: 0.5, y: 0 } },
            DEFAULT_DOMAIN
        );
        expect(out.ratio).toBeCloseTo(0.2, 12);
    });

    it("pins the orifice by design copy with no generic Cd warning", () => {
        const out = blockageForGeometry(
            { kind: "orifice", chord: 1, alphaDeg: 0, nPoints: 64, width: 0.08, height: 0.4, center: { x: 0.5, y: 0 } },
            DEFAULT_DOMAIN
        );
        expect(out.warning).not.toBeNull();
        expect(out.warning as string).toContain("by design");
        expect(out.warning as string).toContain("open gap 20.0 percent");
        expect(out.warning as string).not.toContain("exceeds 5 percent");
    });
});

describe("grid presets plus custom", () => {
    it("parses the 64 preset and square custom sides from 32 to 512", () => {
        expect(CUSTOM_GRID_MIN).toBe(32);
        expect(CUSTOM_GRID_MAX).toBe(512);
        expect(parseCustomGrid(64).ok).toBe(true);
        expect(parseCustomGrid("128").ok).toBe(true);
        expect(parseCustomGrid(31).ok).toBe(false);
        expect(parseCustomGrid(513).ok).toBe(false);
        expect(parseCustomGrid("abc").ok).toBe(false);
        expect(parseCustomGrid("").ok).toBe(false);
        const pinned = setGridMode(initialResolution("auto"), "64");
        expect(pinned.active).toBe(64);
        const custom = setGridMode(initialResolution("auto"), "custom", 96);
        expect(custom.active).toBe(96);
        const badCustom = setGridMode(initialResolution("auto"), "custom", 7);
        expect(badCustom.notice).toContain("32");
    });
});

describe("reynolds field funnel", () => {
    it("covers empty, non-numeric, below-min, above-max, and the LBM cap", () => {
        expect(parseReynoldsField("", false).kind).toBe("empty");
        expect(parseReynoldsField("abc", false).kind).toBe("non-numeric");
        expect(parseReynoldsField(50, false).kind).toBe("below-min");
        expect(parseReynoldsField(50, false).value).toBe(100);
        expect(parseReynoldsField(2000000, false).kind).toBe("above-max");
        expect(parseReynoldsField(2000000, false).value).toBe(1000000);
        expect(parseReynoldsField(50000, true).kind).toBe("lbm-cap");
        expect(parseReynoldsField(50000, true).value).toBe(2000);
        expect(parseReynoldsField(1500, true).lbmBandWarning).toContain("LES auto");
        expect(parseReynoldsField(400, true).lbmBandWarning).toBeNull();
    });

    it("commits without clobbering the canvas on empty input", () => {
        const kept = commitReynoldsValue("", false, 50000);
        expect(kept.reynolds).toBe(50000);
        expect(kept.capped).toBe(false);
        const capped = commitReynoldsValue(90000, true, 90000);
        expect(capped.reynolds).toBe(2000);
        expect(capped.capped).toBe(true);
    });
});

describe("bake intake", () => {
    it("allows the orifice plate and drops the retired duct kind", () => {
        const here = dirname(fileURLToPath(import.meta.url));
        const text = readFileSync(resolve(here, "../../scripts/bake-offline-pack.mjs"), "utf8");
        expect(text).toContain('"orifice"');
        expect(text).not.toContain('"duct"');
    });
});
