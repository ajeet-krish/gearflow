// Phase 3 code review remediation tests. Each block pins one reviewer Major
// or High/Medium so regressions fail loudly. Tiny grids only (8x8, base 1
// or 2) except where the production 128 grid contract is asserted.

import { describe, it, expect } from "vitest";
import {
  MAX_COORD_POINTS,
  MAX_PARSE_TEXT_BYTES,
  MAX_POLAR_RECORDS,
  MAX_TMR_ZONES,
  gregoryToCpRecords,
  parseAirfoilDat,
  parseAirfoilToolsCsv,
  parseAirfoilToolsTxt,
  parseTmrDat,
} from "@/validation/parsePolars";
import {
  COORDS_0012,
  GREGORY_CP,
  LADSON_DATA,
  MCCROSKEY_FIT,
  POLAR_0012_RE500K,
  clAtAlpha,
  gregoryCpRecords,
} from "@/validation/datasets";
import { bandCpMin, circulationCl } from "@/validation/metrics";
import { TIER_TABLE, evaluateTier } from "@/validation/tiers";
import {
  SURROGATE_IN_CH,
  buildSurrogateInput,
  expectedParamCount,
  syncInferenceAllowed,
  unetForward,
  validateManifest,
  SurrogateFlowProvider,
  type LoadedWeights,
  type SurrogateManifest,
} from "@/flow/surrogate";
import { DEFAULT_DOMAIN } from "@/contracts/types";
import type { FlowField, GeometrySpec } from "@/contracts/types";

function prodManifest(base: number): SurrogateManifest {
  return {
    version: "review-test",
    nx: 128,
    ny: 128,
    inCh: 3,
    outCh: 3,
    base,
    norm: {
      sdfMean: 0, sdfStd: 1, alphaScale: 12,
      uMean: 0, uStd: 1, vMean: 0, vStd: 1, cpMean: 0, cpStd: 1,
    },
    weightsFile: "weights.bin",
    weightsSha256: "cd".repeat(32),
    paramCount: expectedParamCount(base),
  };
}

function tinyWeights(base: number, bias: [number, number, number]): LoadedWeights {
  const manifest: SurrogateManifest = { ...prodManifest(base), nx: 8, ny: 8 };
  const params = new Float32Array(manifest.paramCount);
  params[params.length - 3] = bias[0];
  params[params.length - 2] = bias[1];
  params[params.length - 1] = bias[2];
  return { manifest, params };
}

describe("review #2: TMR variables with inner commas stay intact", () => {
  it("keeps quoted alpha, deg as one variable", () => {
    expect(MCCROSKEY_FIT.variables).toEqual(["alpha, deg", "cl"]);
    expect(LADSON_DATA.variables).toEqual(["alpha, deg", "cl", "cd"]);
  });

  it("parses a synthetic quoted variables line without splitting inside quotes", () => {
    const table = parseTmrDat('variables="alpha, deg","cl","cd"\nzone t="test"\n1.0 0.1 0.01\n');
    expect(table.variables).toEqual(["alpha, deg", "cl", "cd"]);
    expect(table.zones[0].rows[0]).toEqual([1.0, 0.1, 0.01]);
  });

  it("rejects rows whose width does not match the variables line", () => {
    expect(() => parseTmrDat('variables="x","y"\nzone t="a"\n1.0 2.0 3.0\n')).toThrow(/expected 2/);
    expect(() => parseTmrDat('variables="x","y","z"\nzone t="a"\n1.0 2.0\n')).toThrow(/expected 3/);
  });
});

describe("review #7/#8: parser allocation caps", () => {
  it("rejects text past the module byte cap", () => {
    expect(MAX_PARSE_TEXT_BYTES).toBe(8 * 1024 * 1024);
    expect(() => parseAirfoilToolsCsv("x".repeat(MAX_PARSE_TEXT_BYTES + 1))).toThrow(/exceeds cap/);
    expect(() => parseTmrDat("x".repeat(MAX_PARSE_TEXT_BYTES + 1))).toThrow(/exceeds cap/);
  });

  it("rejects polar tables past the record cap", () => {
    expect(MAX_POLAR_RECORDS).toBe(10000);
    const header = "Alpha,Cl,Cd,Cdp,Cm,Top_Xtr,Bot_Xtr";
    const big = `${header}\n${"0,0.1,0.01,0.008,0,1,1\n".repeat(MAX_POLAR_RECORDS + 1)}`;
    expect(() => parseAirfoilToolsCsv(big)).toThrow(/more than/);
  });

  it("rejects TMR past the zone cap and coord past the point cap", () => {
    expect(MAX_TMR_ZONES).toBe(256);
    let zones = 'variables="x","y"\n';
    for (let i = 0; i < MAX_TMR_ZONES + 1; i++) zones += `zone t="z${i}"\n1.0 2.0\n`;
    expect(() => parseTmrDat(zones)).toThrow(/more than/);
    expect(MAX_COORD_POINTS).toBe(10000);
    const lines = ["airfoil", "99999 99999"];
    for (let i = 0; i < MAX_COORD_POINTS + 5; i++) lines.push("0.5 0.01");
    expect(() => parseAirfoilDat(lines.join("\n"))).toThrow(/more than/);
  });
});

describe("review #9/#15: committed fixtures validated, single Gregory flattener", () => {
  it("shared flattener matches the committed Gregory records", () => {
    expect(gregoryCpRecords()).toEqual(gregoryToCpRecords(GREGORY_CP));
    expect(gregoryCpRecords().length).toBe(73);
  });

  it("clAtAlpha finite-checks its inputs", () => {
    expect(Number.isFinite(clAtAlpha(POLAR_0012_RE500K.records, 6))).toBe(true);
    expect(() => clAtAlpha(POLAR_0012_RE500K.records, Number.NaN)).toThrow(/finite/);
    expect(() => clAtAlpha([{ alpha: 0, cl: Number.NaN }], 0)).toThrow(/non-finite/);
  });

  it("coords fixtures carry finite points", () => {
    expect(COORDS_0012.upper.length).toBe(66);
    expect(COORDS_0012.upper.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
  });
});

describe("review #10: metrics edge guards", () => {
  function uniform(nx: number, ny: number): FlowField {
    const n = nx * ny;
    return {
      nx, ny, domain: { ...DEFAULT_DOMAIN },
      u: new Float32Array(n).fill(1), v: new Float32Array(n),
      p: new Float32Array(n).fill(0.5), omega: new Float32Array(n),
      obstacle: new Float32Array(n),
    };
  }

  it("circulationCl validates grid size and domain", () => {
    expect(() => circulationCl({ ...uniform(8, 6), nx: 1 } as FlowField, 1, 1)).toThrow(/>= 2|integers/);
    expect(() => circulationCl({ ...uniform(8, 6), domain: { ...DEFAULT_DOMAIN, xMax: Number.NaN } }, 1, 1)).toThrow(/finite/);
    expect(() => circulationCl({ ...uniform(8, 6), domain: { ...DEFAULT_DOMAIN, xMax: -99 } }, 1, 1)).toThrow(/xMax/);
  });

  it("bandCpMin finite-checks sdf entries", () => {
    const field = uniform(8, 6);
    const sdf = new Float32Array(8 * 6).fill(0.02);
    sdf[3] = Number.NaN;
    expect(() => bandCpMin(field, sdf, 1, 0.05)).toThrow(/sdf\[3\]/);
  });
});

describe("review #11: INFO tier never throws, even with infinite tolerances", () => {
  it("infoOnly entry evaluates to info", () => {
    expect(TIER_TABLE.infoOnly.passTol).toBe(Number.POSITIVE_INFINITY);
    expect(evaluateTier("INFO", 0, TIER_TABLE.infoOnly.passTol, TIER_TABLE.infoOnly.warnTol)).toBe("info");
    expect(evaluateTier("INFO", 99, TIER_TABLE.infoOnly.passTol, TIER_TABLE.infoOnly.warnTol)).toBe("info");
  });
});

describe("review #6: sync forward latency gate at test shape", () => {
  it("base-2 8x8 inference completes under 100ms (production 128x128 stays async-only)", () => {
    const weights = tinyWeights(2, [1, 2, 3]);
    const input = new Float32Array(8 * 8 * SURROGATE_IN_CH).fill(0.5);
    const t0 = performance.now();
    const out = unetForward(input, weights, 8, 8);
    const dt = performance.now() - t0;
    expect(out.length).toBe(8 * 8 * 3);
    expect(dt).toBeLessThan(100);
  });
});

describe("review #12: provider constructor and all-obstacle guards", () => {
  const geom = {
    kind: "naca4" as const,
    naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 },
    chord: 1,
    alphaDeg: 6,
    nPoints: 12,
  };

  it("constructor rejects bad grid, geometry, and U", () => {
    const grid = { nx: 8, ny: 8, domain: { ...DEFAULT_DOMAIN } };
    expect(() => new SurrogateFlowProvider({ grid, geom, U: -1 })).toThrow();
    expect(() => new SurrogateFlowProvider({ grid, geom: { ...geom, alphaDeg: 199 } })).toThrow();
    expect(() => new SurrogateFlowProvider({ grid: { ...grid, nx: 8192 }, geom })).toThrow();
  });

  it("getResult throws a clear error when every cell is solid", () => {
    const provider = new SurrogateFlowProvider({
      grid: { nx: 8, ny: 8, domain: { ...DEFAULT_DOMAIN } },
      geom,
      weightsOverride: tinyWeights(2, [1, 0, 0]),
    });
    const frame = provider.getFrame();
    frame.obstacle.fill(1);
    expect(() => provider.getResult()).toThrow();
    void frame;
  });

  it("production manifest pins base range and the 128 grid", () => {
    expect(() => validateManifest({ ...prodManifest(2), base: 0 })).toThrow(/base/);
    expect(() => validateManifest({ ...prodManifest(2), nx: 64, ny: 64 })).toThrow(/128/);
  });
});

describe("review Major: production-shape sync gate with analytic fallback", () => {
  const prodGeom: GeometrySpec = {
    kind: "naca4",
    naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 },
    chord: 1,
    alphaDeg: 6,
    nPoints: 12,
  };

  it("sync budget allows test shapes but blocks production 128x128 base 32", () => {
    expect(syncInferenceAllowed(8, 8, 2)).toBe(true);
    expect(syncInferenceAllowed(128, 128, 2)).toBe(true);
    expect(syncInferenceAllowed(128, 128, 32)).toBe(false);
    expect(syncInferenceAllowed(0, 128, 32)).toBe(false);
  });

  it("production-shape base-32 weights serve analytic fallback under 500ms", () => {
    const manifest = prodManifest(32);
    const provider = new SurrogateFlowProvider({
      grid: { nx: 128, ny: 128, domain: { ...DEFAULT_DOMAIN } },
      geom: prodGeom,
      weightsOverride: { manifest, params: new Float32Array(manifest.paramCount) },
    });
    const t0 = performance.now();
    const frame = provider.getFrame();
    const dt = performance.now() - t0;
    expect(provider.meta.backend).toBe("analytic-fallback");
    expect(dt).toBeLessThan(500);
    expect(frame.nx).toBe(128);
    expect(frame.u.length).toBe(128 * 128);
  });

  it("deep clones geometry and keys the cache on the full spec plus Re", () => {
    const geom: GeometrySpec = {
      kind: "naca4",
      naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 },
      chord: 1,
      alphaDeg: 6,
      nPoints: 12,
    };
    const provider = new SurrogateFlowProvider({
      grid: { nx: 8, ny: 8, domain: { ...DEFAULT_DOMAIN } },
      geom,
      weightsOverride: tinyWeights(2, [1, 0, 0]),
    });
    provider.getFrame();
    expect(provider.getFrame().nx).toBe(8);
    expect(provider.meta.cached).toBe(true);
    if (geom.naca) geom.naca.t = 0.99;
    provider.getFrame();
    expect(provider.meta.cached).toBe(true);
    provider.setGeometry({
      kind: "naca4",
      naca: { code: "2412", m: 0.02, p: 0.4, t: 0.15 },
      chord: 1,
      alphaDeg: 6,
      nPoints: 12,
    });
    provider.getFrame();
    expect(provider.meta.cached).toBe(false);
    expect(provider.meta.backend).toBe("surrogate");
    provider.getFrame();
    expect(provider.meta.cached).toBe(true);
    provider.setRe(2000);
    provider.getFrame();
    expect(provider.meta.cached).toBe(false);
  });
});

describe("review: parser TXT parity and coord ingest", () => {
  it("TXT rejects oversize input before scanning", () => {
    expect(() => parseAirfoilToolsTxt("y".repeat(MAX_PARSE_TEXT_BYTES + 1))).toThrow(/exceeds cap/);
  });

  it("baked Gregory variables match the fixed parser", () => {
    expect(GREGORY_CP.variables).toEqual(["x/c", "cp"]);
  });
});
