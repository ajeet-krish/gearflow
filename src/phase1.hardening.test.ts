// Phase 1 hardening tests: happy path, edge cases, error conditions.
// Covers task list: 2412 6deg loads and renders, bad AoA, bad sketch fallback,
// NaN/Infinity, traversal, oversize, offline pack loads, truncated flow,
// mismatched grid, missing files.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateFakeFlow, wakeProfile } from "@/flow/fakeFlow";
import { naca4Airfoil, parseNaca4, transformPoints } from "@/geometry/parametric";
import {
  validateGeometrySpec,
  validateFlowField,
  validateDemoPack,
  validatePackFlowConsistency,
  coerceFlowField,
  MAX_NX,
  MAX_NY,
  MAX_CELLS,
  MAX_NPOINTS,
} from "@/contracts/schema";
import { validateAirfoilPoints } from "@/contracts/schema";
import { loadDemoPack, resolveFixtureUrl } from "@/meta/fixtures";
import { createParticles, advectParticles, sampleBilinear, mulberry32 } from "@/render/particles";
import { createFieldTextures } from "@/render/fieldTexture";
import { sampleColormap, buildLut } from "@/flow/colormap";
import type { DemoPack, FlowField, GeometrySpec } from "@/contracts/types";

const PACK_DIR = fileURLToPath(new URL("../public/demo-pack", import.meta.url));
const loadJson = (rel: string): unknown => JSON.parse(readFileSync(`${PACK_DIR}/${rel}`, "utf8"));

const GEOM_2412_6: GeometrySpec = {
  kind: "naca4",
  naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 },
  chord: 1,
  alphaDeg: 6,
  nPoints: 120,
};
const GRID_128 = { nx: 128, ny: 128, domain: { xMin: -0.5, xMax: 2.0, yMin: -1.0, yMax: 1.0 } };

function jsonFlow(nx = 4, ny = 4, fill = 0): Parameters<typeof coerceFlowField>[0] {
  const n = nx * ny;
  const ch = () => new Array(n).fill(fill);
  return {
    nx,
    ny,
    domain: { xMin: -0.5, xMax: 2.0, yMin: -1.0, yMax: 1.0 },
    u: ch(),
    v: ch(),
    p: ch(),
    omega: ch(),
    obstacle: ch(),
  };
}

describe("happy path: NACA 2412 at 6deg loads and renders", () => {
  it("manifest geometry parses and airfoil polygon is well formed", () => {
    const manifest = loadJson("manifest.json") as DemoPack;
    expect(manifest.name).toBe("naca2412-a6");
    expect(manifest.geometry.alphaDeg).toBe(6);
    expect(manifest.geometry.naca?.code).toBe("2412");
    const { m, p, t } = parseNaca4("2412");
    expect(m).toBeCloseTo(0.02, 12);
    expect(p).toBeCloseTo(0.4, 12);
    expect(t).toBeCloseTo(0.12, 12);
    const pts = naca4Airfoil(m, p, t, manifest.geometry.nPoints);
    expect(pts.length).toBe(2 * manifest.geometry.nPoints - 1);
    for (const q of pts) {
      expect(Number.isFinite(q.x)).toBe(true);
      expect(Number.isFinite(q.y)).toBe(true);
    }
    // Closed trailing edge
    const f = pts[0];
    const l = pts[pts.length - 1];
    expect(Math.hypot(f.x - l.x, f.y - l.y)).toBeLessThan(1e-9);
    // Positive alpha moves TE down (nose up, y-up)
    const [te] = transformPoints([{ x: 1, y: 0 }], 0, 0, 1, 6);
    expect(te.y).toBeLessThan(0);
    expect(te.y).toBeCloseTo(-Math.sin((6 * Math.PI) / 180), 10);
  });

  it("fixture flow generates finite field with body mask and wake deficit", () => {
    const flow = generateFakeFlow(GRID_128, GEOM_2412_6, "naca2412-a6");
    expect(flow.u.length).toBe(128 * 128);
    for (const ch of [flow.u, flow.v, flow.p, flow.omega, flow.obstacle] as const) {
      for (let k = 0; k < ch.length; k++) expect(Number.isFinite(ch[k])).toBe(true);
    }
    const blocked = flow.obstacle.reduce((s, x) => s + x, 0);
    expect(blocked).toBeGreaterThan(10);
    expect(blocked).toBeLessThan(128 * 128 * 0.2);
    // Inside body velocity is zeroed
    for (let k = 0; k < flow.u.length; k++) {
      if (flow.obstacle[k] === 1) {
        expect(flow.u[k]).toBe(0);
        expect(flow.v[k]).toBe(0);
      }
    }
    // Wake deficit downstream of body on centreline
    const at = (x: number, y: number): number => {
      const i = Math.round(((x - -0.5) / 2.5) * 127);
      const j = Math.round(((y - -1.0) / 2.0) * 127);
      return flow.u[j * 128 + i];
    };
    expect(at(1.5, 0)).toBeLessThan(at(-0.4, 0.8));
  });

  it("field is render ready: textures pack, colormap samples, particles advect in domain", () => {
    const flow = generateFakeFlow(GRID_128, GEOM_2412_6, "naca2412-a6");
    const { field, lut, speedMax } = createFieldTextures(flow);
    expect(speedMax).toBeGreaterThan(0);
    expect((field.image.data as Uint8Array).length).toBe(128 * 128 * 4);
    expect((lut.image.data as Uint8Array).length).toBe(256 * 4);
    expect(sampleColormap("viridis", 0).length).toBe(3);
    expect(buildLut("viridis", 256).length).toBe(256 * 3);
    field.dispose();
    lut.dispose();
    const ps = createParticles(64, 20261026);
    const rand = mulberry32(20261027);
    advectParticles(ps, flow, 0.016, rand);
    for (let i = 0; i < ps.count; i++) {
      expect(Number.isFinite(ps.x[i])).toBe(true);
      expect(Number.isFinite(ps.y[i])).toBe(true);
      expect(ps.x[i]).toBeGreaterThanOrEqual(flow.domain.xMin - 0.01);
      expect(ps.x[i]).toBeLessThanOrEqual(flow.domain.xMax + 0.01);
      expect(ps.y[i]).toBeGreaterThanOrEqual(flow.domain.yMin - 0.01);
      expect(ps.y[i]).toBeLessThanOrEqual(flow.domain.yMax + 0.01);
    }
  });
});

describe("edge: bad AoA handling", () => {
  it("rejects non-finite alphaDeg in geometry spec", () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(() =>
        validateGeometrySpec({ kind: "naca4", naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 }, chord: 1, alphaDeg: bad, nPoints: 60 })
      ).toThrow(/alphaDeg/);
    }
    // Missing alphaDeg is also rejected (must be finite, not undefined)
    expect(() =>
      validateGeometrySpec({ kind: "naca4", naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 }, chord: 1, nPoints: 60 } as unknown as GeometrySpec)
    ).toThrow(/alphaDeg/);
  });

  it("extreme but finite AoA still produces finite flow (no NaN blowup)", () => {
    for (const alpha of [-90, -45, 0, 45, 90]) {
      const geom: GeometrySpec = {
        kind: "naca4",
        naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 },
        chord: 1,
        alphaDeg: alpha,
        nPoints: 24,
      };
      const flow = generateFakeFlow({ nx: 16, ny: 16, domain: GRID_128.domain }, geom, `aoa-${alpha}`);
      for (let k = 0; k < flow.u.length; k++) {
        expect(Number.isFinite(flow.u[k])).toBe(true);
        expect(Number.isFinite(flow.v[k])).toBe(true);
        expect(Number.isFinite(flow.p[k])).toBe(true);
        expect(Number.isFinite(flow.omega[k])).toBe(true);
      }
    }
  });

  it("wake slope sign follows alpha sign", () => {
    const up: GeometrySpec = { ...GEOM_2412_6, alphaDeg: 10, nPoints: 24 };
    const down: GeometrySpec = { ...GEOM_2412_6, alphaDeg: -10, nPoints: 24 };
    const flat: GeometrySpec = { ...GEOM_2412_6, alphaDeg: 0, nPoints: 24 };
    expect(wakeProfile(up, null).slope).toBeLessThan(0);
    expect(wakeProfile(down, null).slope).toBeGreaterThan(0);
    expect(wakeProfile(flat, null).slope).toBeCloseTo(0, 12);
  });
});

describe("edge: bad sketch fallback (unsupported geometry rejected)", () => {
  it("rejects unknown kind", () => {
    expect(() =>
      validateGeometrySpec({ kind: "sketch", chord: 1, alphaDeg: 0, nPoints: 8 } as unknown as GeometrySpec)
    ).toThrow(/kind/);
  });

  it("rejects naca4 without valid naca params", () => {
    expect(() =>
      validateGeometrySpec({ kind: "naca4", chord: 1, alphaDeg: 0, nPoints: 60 } as unknown as GeometrySpec)
    ).toThrow(/naca/);
    expect(() =>
      validateGeometrySpec({ kind: "naca4", naca: { code: "12", m: 0.02, p: 0.4, t: 0.12 }, chord: 1, alphaDeg: 0, nPoints: 60 } as unknown as GeometrySpec)
    ).toThrow(/4 character/);
  });

  it("rejects unrealistic sketch-like codes via parseNaca4", () => {
    expect(() => parseNaca4("abcd")).toThrow();
    expect(() => parseNaca4("")).toThrow();
    expect(() => parseNaca4("24120")).toThrow(/4 digits/);
  });
});

describe("edge: NaN and Infinity rejected", () => {
  it("coerceFlowField rejects NaN and Infinity in every channel", () => {
    for (const ch of ["u", "v", "p", "omega", "obstacle"] as const) {
      const badNaN = jsonFlow();
      badNaN[ch][3] = NaN;
      expect(() => coerceFlowField(badNaN)).toThrow(/finite/);
      const badInf = jsonFlow();
      badInf[ch][3] = Infinity;
      expect(() => coerceFlowField(badInf)).toThrow(/finite/);
    }
  });

  it("validateFlowField rejects NaN in Float32Array channels", () => {
    const n = 16;
    const mk = (): FlowField => ({
      nx: 4,
      ny: 4,
      domain: { ...GRID_128.domain },
      u: new Float32Array(n),
      v: new Float32Array(n).fill(NaN),
      p: new Float32Array(n),
      omega: new Float32Array(n),
      obstacle: new Float32Array(n),
    });
    expect(() => validateFlowField(mk())).toThrow(/finite/);
  });

  it("rejects NaN domain bounds and non-positive chord", () => {
    expect(() =>
      coerceFlowField({ ...jsonFlow(), domain: { xMin: NaN, xMax: 2.0, yMin: -1.0, yMax: 1.0 } })
    ).toThrow();
    expect(() =>
      validateGeometrySpec({ kind: "cylinder", chord: NaN, alphaDeg: 0, nPoints: 8, radius: 0.25 })
    ).toThrow(/chord/);
    expect(() =>
      validateAirfoilPoints([{ x: 0, y: Infinity }], { requireNonEmpty: true })
    ).toThrow(/finite/);
  });

  it("sampleBilinear returns inside:false for non-finite query and poisoned flow", () => {
    const flow = generateFakeFlow({ nx: 8, ny: 8, domain: GRID_128.domain }, GEOM_2412_6, "poison");
    expect(sampleBilinear(flow, NaN, 0).inside).toBe(false);
    expect(sampleBilinear(flow, 0, Infinity).inside).toBe(false);
    const poisoned = generateFakeFlow({ nx: 8, ny: 8, domain: GRID_128.domain }, GEOM_2412_6, "poison");
    poisoned.u[0] = NaN;
    expect(sampleBilinear(poisoned, -0.4, -0.9).inside).toBe(false);
  });
});

describe("edge: traversal and scheme rejected", () => {
  it("resolveFixtureUrl accepts allowlisted paths and rejects escapes", () => {
    expect(resolveFixtureUrl("/demo-pack", "geometry/naca2412-a6.json")).toBe("/demo-pack/geometry/naca2412-a6.json");
    expect(resolveFixtureUrl("/demo-pack/", "flow/naca2412-a6-128x128.json")).toContain("flow/naca2412-a6-128x128.json");
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
      expect(() => resolveFixtureUrl("/demo-pack", bad)).toThrow();
    }
  });

  it("DemoPack.files traversal is rejected at manifest validation", () => {
    const manifest = loadJson("manifest.json") as unknown as Record<string, unknown>;
    ((manifest.files as Record<string, string>).flow as string) = "https://evil.example/flow.json";
    expect(() => validateDemoPack(manifest)).toThrow(/files/);
  });
});

describe("edge: oversize rejected before allocation", () => {
  it("grid caps enforced", () => {
    expect(MAX_NX).toBe(512);
    expect(MAX_NY).toBe(512);
    expect(MAX_CELLS).toBe(262144);
    expect(() => coerceFlowField({ ...jsonFlow(600, 4), nx: 600, ny: 4 })).toThrow(/512|cells/);
    expect(() => coerceFlowField({ ...jsonFlow(), nx: 512, ny: 513 })).toThrow(/512|cells/);
    // Boundary 512x512 exceeds cells cap (262144): 512*512 = 262144 exactly, allowed
    const edge = jsonFlow(4, 4);
    edge.nx = 512;
    edge.ny = 512;
    (edge as { u: number[] }).u = [];
    expect(() => coerceFlowField(edge)).toThrow(/truncated/);
  });

  it("nPoints and airfoil caps enforced", () => {
    expect(MAX_NPOINTS).toBe(4096);
    expect(() =>
      validateGeometrySpec({ kind: "naca4", naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 }, chord: 1, alphaDeg: 0, nPoints: MAX_NPOINTS + 1 })
    ).toThrow(/nPoints/);
    const many = new Array(8193).fill({ x: 0, y: 0 });
    expect(() => validateAirfoilPoints(many, {})).toThrow();
    expect(() =>
      createFieldTextures({
        nx: 2048,
        ny: 2048,
        domain: { xMin: 0, xMax: 1, yMin: 0, yMax: 1 },
        u: new Float32Array(0),
        v: new Float32Array(0),
        p: new Float32Array(0),
        omega: new Float32Array(0),
        obstacle: new Float32Array(0),
      })
    ).toThrow(/cap|exceed/);
  });

  it("generateFakeFlow rejects oversized grids", () => {
    expect(() =>
      generateFakeFlow({ nx: 1024, ny: 4, domain: GRID_128.domain }, GEOM_2412_6, "big")
    ).toThrow();
  });
});

describe("offline pack loads (mocked fetch, no network)", () => {
  const realFetch = globalThis.fetch;

  function mockOfflinePack(): void {
    const manifest = readFileSync(`${PACK_DIR}/manifest.json`, "utf8");
    const geom = readFileSync(`${PACK_DIR}/geometry/naca2412-a6.json`, "utf8");
    const flow = readFileSync(`${PACK_DIR}/flow/naca2412-a6-128x128.json`, "utf8");
    const byUrl: Record<string, string> = {
      "/demo-pack/manifest.json": manifest,
      "/demo-pack/geometry/naca2412-a6.json": geom,
      "/demo-pack/flow/naca2412-a6-128x128.json": flow,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const body = byUrl[url];
        if (body === undefined) return { ok: false, status: 404, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => JSON.parse(body) };
      })
    );
  }

  beforeEach(() => {
    mockOfflinePack();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.fetch = realFetch;
  });

  it("loads 2412 6deg pack offline with validated flow and airfoil points", async () => {
    const loaded = await loadDemoPack("/demo-pack");
    expect(loaded.pack.name).toBe("naca2412-a6");
    expect(loaded.pack.provenance.source).toBe("fake-fixture");
    expect(loaded.flow.nx).toBe(128);
    expect(loaded.flow.ny).toBe(128);
    expect(loaded.flow.u.length).toBe(128 * 128);
    expect(loaded.airfoilPoints.length).toBeGreaterThan(0);
    expect(loaded.grid.nx).toBe(loaded.flow.nx);
    // Flow validates and matches pack grid
    expect(() => validateFlowField(loaded.flow)).not.toThrow();
    expect(() => validatePackFlowConsistency(loaded.pack, loaded.flow)).not.toThrow();
  });

  it("loader rejects geometry file that diverges from manifest", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const badGeom = JSON.stringify({
      name: "naca2412-a6",
      geometry: { ...GEOM_2412_6, chord: 2 },
      points: [{ x: 0, y: 0 }],
    });
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith("manifest.json"))
        return { ok: true, json: async () => JSON.parse(readFileSync(`${PACK_DIR}/manifest.json`, "utf8")) };
      if (String(url).includes("geometry/")) return { ok: true, json: async () => JSON.parse(badGeom) };
      return { ok: true, json: async () => JSON.parse(readFileSync(`${PACK_DIR}/flow/naca2412-a6-128x128.json`, "utf8")) };
    });
    await expect(loadDemoPack("/demo-pack")).rejects.toThrow(/Failed to load/);
  });
});

describe("error conditions: truncated flow, mismatched grid, missing files", () => {
  it("truncated flow channel rejected with clear message", () => {
    const bad = jsonFlow();
    bad.p = bad.p.slice(0, 10);
    expect(() => coerceFlowField(bad)).toThrow(/truncated/);
    const badField = {
      nx: 4,
      ny: 4,
      domain: { ...GRID_128.domain },
      u: new Float32Array(16),
      v: new Float32Array(16),
      p: new Float32Array(16),
      omega: new Float32Array(15),
      obstacle: new Float32Array(16),
    };
    expect(() => validateFlowField(badField)).toThrow(/omega/);
  });

  it("mismatched grid rejected (nx and domain)", () => {
    const pack = loadJson("manifest.json") as DemoPack;
    const flowJson = loadJson("flow/naca2412-a6-128x128.json") as Parameters<typeof coerceFlowField>[0];
    const flow = coerceFlowField(flowJson);
    const wrongNx: FlowField = { ...flow, nx: 64, u: flow.u.slice(0, 64 * 128), v: flow.v, p: flow.p, omega: flow.omega, obstacle: flow.obstacle };
    expect(() => validatePackFlowConsistency(pack, wrongNx)).toThrow(/does not match/);
    const wrongDomain: FlowField = { ...flow, domain: { ...flow.domain, yMax: 2.0 } };
    expect(() => validatePackFlowConsistency(pack, wrongDomain)).toThrow(/domain/);
  });

  it("missing files surface friendly load error", async () => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
    try {
      await expect(loadDemoPack("/demo-pack")).rejects.toThrow(/Failed to load/);
    } finally {
      vi.unstubAllGlobals();
      globalThis.fetch = realFetch;
    }
  });

  it("missing flow file after valid manifest surfaces friendly load error", async () => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("manifest.json"))
          return { ok: true, json: async () => JSON.parse(readFileSync(`${PACK_DIR}/manifest.json`, "utf8")) };
        if (String(url).includes("geometry/"))
          return { ok: true, json: async () => JSON.parse(readFileSync(`${PACK_DIR}/geometry/naca2412-a6.json`, "utf8")) };
        return { ok: false, status: 404, json: async () => ({}) };
      })
    );
    try {
      await expect(loadDemoPack("/demo-pack")).rejects.toThrow(/Failed to load/);
    } finally {
      vi.unstubAllGlobals();
      globalThis.fetch = realFetch;
    }
  });

  it("missing geometry file after valid manifest surfaces friendly load error", async () => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("manifest.json"))
          return { ok: true, json: async () => JSON.parse(readFileSync(`${PACK_DIR}/manifest.json`, "utf8")) };
        if (String(url).includes("flow/"))
          return { ok: true, json: async () => JSON.parse(readFileSync(`${PACK_DIR}/flow/naca2412-a6-128x128.json`, "utf8")) };
        return { ok: false, status: 404, json: async () => ({}) };
      })
    );
    try {
      await expect(loadDemoPack("/demo-pack")).rejects.toThrow(/Failed to load/);
    } finally {
      vi.unstubAllGlobals();
      globalThis.fetch = realFetch;
    }
  });
});
