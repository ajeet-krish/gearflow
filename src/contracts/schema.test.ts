import { describe, it, expect } from "vitest";
import {
    validateFlowField,
    coerceFlowField,
    validateDemoPack,
    validatePackFlowConsistency,
    validateAirfoilPoints,
    validateGeometrySpec,
    validatePackFilePath,
    validateLoadedGeometryMatchesPack,
} from "./schema";
import type { DemoPack, FlowField } from "./types";

function goodPack(): DemoPack {
    return {
        name: "naca2412-a6",
        version: 1,
        geometry: { kind: "naca4", naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 }, chord: 1, alphaDeg: 6, nPoints: 120 },
        grid: { nx: 128, ny: 128, domain: { xMin: -0.5, xMax: 2.0, yMin: -1.0, yMax: 1.0 } },
        provenance: {
            source: "fake-fixture",
            label: "Fake fixture, not physics",
            generatedAt: "2026-10-26T00:00:00.000Z",
            gridLabel: "128 x 128",
            geometryLabel: "NACA 2412",
        },
        meta: {
            spark: { prompt: "a", summary: "b", model: "c" },
            sam: { prompt: "a", summary: "b", model: "c" },
            image: { prompt: "a", summary: "b", model: "c" },
        },
        files: { geometry: "geometry/naca2412-a6.json", flow: "flow/naca2412-a6-128x128.json" },
    };
}

describe("flow validators", () => {
    it("rejects truncated array", () => {
        const bad = {
            nx: 4,
            ny: 4,
            domain: { xMin: -0.5, xMax: 2.0, yMin: -1.0, yMax: 1.0 },
            u: new Float32Array(16),
            v: new Float32Array(16),
            p: new Float32Array(16),
            omega: new Float32Array(15),
            obstacle: new Float32Array(16),
        };
        expect(() => validateFlowField(bad)).toThrow(/omega/);
    });

    it("coerceFlowField rejects JSON truncated channel", () => {
        const n = 16;
        const full = new Array(n).fill(0);
        expect(() =>
            coerceFlowField({
                nx: 4,
                ny: 4,
                domain: { xMin: -0.5, xMax: 2.0, yMin: -1.0, yMax: 1.0 },
                u: full,
                v: full,
                p: full.slice(0, 10),
                omega: full,
                obstacle: full,
            })
        ).toThrow(/truncated/);
    });
});

describe("validateDemoPack", () => {
    it("accepts a complete pack matching the JSON schemas", () => {
        expect(() => validateDemoPack(goodPack())).not.toThrow();
    });

    it("rejects bad version, meta, and files", () => {
        const badVersion = goodPack() as unknown as Record<string, unknown>;
        badVersion.version = 0;
        expect(() => validateDemoPack(badVersion)).toThrow(/version/);

        const badMeta = goodPack() as unknown as Record<string, { spark: unknown }>;
        badMeta.meta = { spark: null } as unknown as DemoPack["meta"];
        expect(() => validateDemoPack(badMeta)).toThrow(/meta/);

        const badFiles = goodPack() as unknown as Record<string, unknown>;
        badFiles.files = { geometry: "", flow: "flow/x.json" };
        expect(() => validateDemoPack(badFiles)).toThrow(/files/);
    });

    it("rejects non-positive chord and unrealistic NACA ranges", () => {
        const pack = goodPack();
        pack.geometry = { ...pack.geometry, chord: 0 };
        expect(() => validateDemoPack(pack)).toThrow(/chord/);
        const pack2 = goodPack();
        pack2.geometry = { ...pack2.geometry, naca: { code: "9999", m: 0.09, p: 0.9, t: 0.99 } };
        expect(() => validateDemoPack(pack2)).toThrow(/naca\.t/);
    });

    it("requires cylinder radius and positive duct extents", () => {
        expect(() =>
            validateGeometrySpec({ kind: "cylinder", chord: 1, alphaDeg: 0, nPoints: 8 })
        ).toThrow(/radius/);
        expect(() =>
            validateGeometrySpec({ kind: "duct", chord: 1, alphaDeg: 0, nPoints: 8, width: -1, height: 0.4 })
        ).toThrow(/width/);
    });
});

describe("validatePackFlowConsistency", () => {
    function flowFor(pack: DemoPack): FlowField {
        const n = pack.grid.nx * pack.grid.ny;
        return {
            nx: pack.grid.nx,
            ny: pack.grid.ny,
            domain: { ...pack.grid.domain },
            u: new Float32Array(n),
            v: new Float32Array(n),
            p: new Float32Array(n),
            omega: new Float32Array(n),
            obstacle: new Float32Array(n),
        };
    }

    it("accepts matching grid and rejects mismatched nx or domain", () => {
        const pack = goodPack();
        expect(() => validatePackFlowConsistency(pack, flowFor(pack))).not.toThrow();
        const wrongNx = flowFor(pack);
        wrongNx.nx = 64;
        expect(() => validatePackFlowConsistency(pack, wrongNx)).toThrow(/64.*128|128.*64|does not match/);
        const wrongDomain = flowFor(pack);
        wrongDomain.domain = { ...wrongDomain.domain, yMax: 2.0 };
        expect(() => validatePackFlowConsistency(pack, wrongDomain)).toThrow(/domain/);
    });
});

describe("validateAirfoilPoints", () => {
    it("requires non-empty finite points for airfoils", () => {
        expect(() => validateAirfoilPoints([], { requireNonEmpty: true })).toThrow(/non-empty/);
        expect(() => validateAirfoilPoints([{ x: 0, y: NaN }], { requireNonEmpty: true })).toThrow(/finite/);
        expect(() => validateAirfoilPoints([{ x: 0, y: 0 }], { requireNonEmpty: true })).not.toThrow();
        expect(() => validateAirfoilPoints([], {})).not.toThrow();
    });

    it("caps airfoil point count", () => {
        const many = new Array(8193).fill({ x: 0, y: 0 });
        expect(() => validateAirfoilPoints(many, {})).toThrow(/<=[ ]?8192|length/);
    });
});

describe("pack file paths (traversal)", () => {
    it("accepts allowlisted fixture paths", () => {
        expect(() => validatePackFilePath("geometry/naca2412-a6.json")).not.toThrow();
        expect(() => validatePackFilePath("flow/naca2412-a6-128x128.json")).not.toThrow();
    });

    it("rejects traversal, absolute, backslash, and scheme paths", () => {
        for (const bad of [
            "../secret.json",
            "geometry/../../etc/passwd.json",
            "/demo-pack/flow/x.json",
            "flow\\x.json",
            "https://evil.example/flow.json",
            "flow/x.txt",
            "other/x.json",
            "",
        ]) {
            expect(() => validatePackFilePath(bad)).toThrow();
        }
    });

    it("rejects traversal paths in DemoPack.files", () => {
        const pack = goodPack() as unknown as Record<string, unknown>;
        (pack.files as Record<string, string>).flow = "../evil.json";
        expect(() => validateDemoPack(pack)).toThrow(/files/);
    });
});

describe("allocation caps", () => {
    it("rejects oversized grids in validateDemoPack", () => {
        const pack = goodPack();
        pack.grid = { ...pack.grid, nx: 1024 };
        expect(() => validateDemoPack(pack)).toThrow(/512|cells/);
        const pack2 = goodPack();
        pack2.grid = { ...pack2.grid, nx: 512, ny: 513 };
        expect(() => validateDemoPack(pack2)).toThrow(/512|cells/);
        const pack3 = goodPack();
        pack3.grid = { ...pack3.grid, nx: 512, ny: 512 };
        expect(() => validateDemoPack(pack3)).not.toThrow();
    });

    it("rejects oversized nPoints", () => {
        expect(() =>
            validateGeometrySpec({ kind: "naca4", naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 }, chord: 1, alphaDeg: 0, nPoints: 8192 })
        ).toThrow(/nPoints/);
    });

    it("coerceFlowField enforces caps before allocation", () => {
        expect(() =>
            coerceFlowField({
                nx: 4096,
                ny: 4096,
                domain: { xMin: -0.5, xMax: 2.0, yMin: -1.0, yMax: 1.0 },
                u: [],
                v: [],
                p: [],
                omega: [],
                obstacle: [],
            })
        ).toThrow(/512|cells/);
    });
});

describe("channel finiteness", () => {
    function jsonFlowWith(u0: number): Parameters<typeof coerceFlowField>[0] {
        const n = 16;
        const full = new Array(n).fill(0);
        const u = [...full];
        u[3] = u0;
        return {
            nx: 4,
            ny: 4,
            domain: { xMin: -0.5, xMax: 2.0, yMin: -1.0, yMax: 1.0 },
            u,
            v: full,
            p: full,
            omega: full,
            obstacle: full,
        };
    }

    it("coerceFlowField rejects NaN and Infinity elements", () => {
        expect(() => coerceFlowField(jsonFlowWith(NaN))).toThrow(/finite/);
        expect(() => coerceFlowField(jsonFlowWith(Infinity))).toThrow(/finite/);
        expect(() => coerceFlowField(jsonFlowWith(1e999))).toThrow(/finite/);
    });

    it("validateFlowField rejects non-finite Float32Array elements", () => {
        const n = 16;
        const bad = {
            nx: 4,
            ny: 4,
            domain: { xMin: -0.5, xMax: 2.0, yMin: -1.0, yMax: 1.0 },
            u: new Float32Array(n),
            v: new Float32Array(n),
            p: new Float32Array(n),
            omega: new Float32Array(n).fill(Infinity),
            obstacle: new Float32Array(n),
        };
        expect(() => validateFlowField(bad)).toThrow(/finite/);
    });
});

describe("validateLoadedGeometryMatchesPack", () => {
    it("accepts identical geometry and rejects divergence", () => {
        const pack = goodPack();
        expect(() => validateLoadedGeometryMatchesPack(pack.geometry, { ...pack.geometry })).not.toThrow();
        expect(() =>
            validateLoadedGeometryMatchesPack(pack.geometry, { ...pack.geometry, chord: 2 })
        ).toThrow(/match/);
    });
});
