// Phase 3 hardening: validation parsers, metrics, tiers, datasets, surrogate
// TS U-Net, ValidationPanel logic, App wiring. Complements the existing
// parsePolars, metrics, tiers, and surrogate suites with edge and error
// coverage the orchestrator requires: Fortran D exponents, Lednicer vs Selig,
// header not on line 11, bubble corrupted Re 100k WARN, NaN polar data,
// oversize fixtures, corrupt weights fallback, non-finite surrogate output.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parseAirfoilToolsCsv,
  parseAirfoilToolsTxt,
  parsePolarAuto,
  parseTmrDat,
  parseAirfoilDat,
  fortranToFloat,
  gregoryToCpRecords,
} from "@/validation/parsePolars";
import {
  fitSlope,
  alphaZero,
  cpStagnation,
  cpShoulder,
  circulationCl,
  bandCpMin,
} from "@/validation/metrics";
import { TIER_TABLE, evaluateTier, isBlocking } from "@/validation/tiers";
import {
  POLAR_0012_RE100K,
  POLAR_0012_RE500K,
  POLAR_2412_RE100K,
  POLAR_2412_RE500K,
  MCCROSKEY_FIT,
  LADSON_DATA,
  GREGORY_CP,
  COORDS_0012,
  COORDS_2412,
  clAtAlpha,
  gregoryCpRecords,
} from "@/validation/datasets";
import {
  expectedParamCount,
  validateManifest,
  unetForward,
  buildSurrogateInput,
  decodeSurrogateOutput,
  SurrogateFlowProvider,
  SURROGATE_IN_CH,
  SURROGATE_OUT_CH,
  type LoadedWeights,
  type SurrogateManifest,
} from "@/flow/surrogate";
import { generateAnalyticFlow } from "@/flow/analyticFlow";
import { coerceFlowField, validateGeometrySpec } from "@/contracts/schema";
import { DEFAULT_DOMAIN, type PolarRecord } from "@/contracts/types";

const VAL_DIR = fileURLToPath(new URL("../fixtures/validation", import.meta.url));
const readRaw = (name: string): string => readFileSync(`${VAL_DIR}/${name}`, "utf8");

function polarLine(alpha: number, cl: number): PolarRecord {
  return { alpha, cl, cd: 0.01, cdp: 0.008, cm: 0, topXtr: 1, botXtr: 1 };
}

function tinyManifest(base: number, nx: number, ny: number): SurrogateManifest {
  return {
    version: "phase3-test",
    nx,
    ny,
    inCh: SURROGATE_IN_CH,
    outCh: SURROGATE_OUT_CH,
    base,
    norm: {
      sdfMean: 0, sdfStd: 1, alphaScale: 12,
      uMean: 0, uStd: 1, vMean: 0, vStd: 1, cpMean: 0, cpStd: 1,
    },
    weightsFile: "weights.bin",
    weightsSha256: "ab".repeat(32),
    paramCount: expectedParamCount(base),
  };
}

function zeroWeights(base: number, nx: number, ny: number, bias: [number, number, number]): LoadedWeights {
  const manifest = tinyManifest(base, nx, ny);
  const params = new Float32Array(manifest.paramCount);
  params[params.length - 3] = bias[0];
  params[params.length - 2] = bias[1];
  params[params.length - 1] = bias[2];
  return { manifest, params };
}

const TINY_GEOM = {
  kind: "naca4" as const,
  naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 },
  chord: 1,
  alphaDeg: 6,
  nPoints: 12,
};

describe("phase3 happy path: parsers on real fixtures", () => {
  it("CSV polars parse 90 plus rows with finite Cl and Cd", () => {
    for (const name of ["xf-n0012-il-100000", "xf-n0012-il-500000", "xf-naca2412-il-100000", "xf-naca2412-il-500000"]) {
      const table = parseAirfoilToolsCsv(readRaw(`${name}.csv`));
      expect(table.records.length).toBeGreaterThan(90);
      expect(table.records.every((r) => Number.isFinite(r.cl) && Number.isFinite(r.cd))).toBe(true);
    }
  });

  it("baked JSON matches raw CSV parse row for row", () => {
    const table = parseAirfoilToolsCsv(readRaw("xf-naca2412-il-500000.csv"));
    expect(POLAR_2412_RE500K.records.length).toBe(table.records.length);
    expect(POLAR_2412_RE500K.records[0].alpha).toBeCloseTo(table.records[0].alpha, 9);
    expect(POLAR_2412_RE500K.records[0].cl).toBeCloseTo(table.records[0].cl, 9);
    expect(POLAR_2412_RE500K.meta["Reynolds number"]).toBe("500000");
  });

  it("TXT fallback matches CSV within tolerance", () => {
    const csv = parseAirfoilToolsCsv(readRaw("xf-n0012-il-500000.csv"));
    const txt = parseAirfoilToolsTxt(readRaw("xf-n0012-il-500000.txt"));
    expect(txt.records.length).toBe(csv.records.length);
    for (let i = 0; i < csv.records.length; i += 17) {
      expect(Math.abs(txt.records[i].cl - csv.records[i].cl)).toBeLessThan(1e-9);
    }
  });

  it("TMR fixtures parse: Gregory 3 zones, Ladson 3 plus zones, McCroskey 1 zone", () => {
    expect(GREGORY_CP.zones.length).toBe(3);
    expect(LADSON_DATA.zones.length).toBeGreaterThanOrEqual(3);
    expect(MCCROSKEY_FIT.zones.length).toBe(1);
    expect(gregoryCpRecords().length).toBe(73);
    expect(gregoryToCpRecords(parseTmrDat(readRaw("CP_Gregory_expdata.dat"))).length).toBe(73);
  });
});

describe("phase3 happy path: metrics on known values", () => {
  it("fitSlope recovers 2 pi per rad and alphaZero", () => {
    const perDeg = (2 * Math.PI) / 180;
    const recs = [-4, -2, 0, 2, 4, 6].map((a) => polarLine(a, perDeg * (a + 2)));
    const fit = fitSlope(recs, -4, 6);
    expect(fit.slope).toBeCloseTo(perDeg, 9);
    expect(alphaZero(fit)).toBeCloseTo(-2, 9);
  });

  it("cpStagnation and cpShoulder pin the cylinder oracle", () => {
    const cp = new Float64Array([0.2, 1.0, -0.5, -3.0, 0.1]);
    expect(cpStagnation(cp)).toBe(1.0);
    expect(cpShoulder(cp)).toBe(-3.0);
  });

  it("circulationCl is zero for uniform flow, bandCpMin reads near wall cells", () => {
    const n = 8 * 6;
    const field = {
      nx: 8, ny: 6, domain: { ...DEFAULT_DOMAIN },
      u: new Float32Array(n).fill(1), v: new Float32Array(n),
      p: new Float32Array(n).fill(0.5), omega: new Float32Array(n),
      obstacle: new Float32Array(n),
    };
    expect(circulationCl(field, 1, 1)).toBeCloseTo(0, 6);
    const sdf = new Float32Array(n).fill(1.0);
    field.p[10] = -2.0;
    sdf[10] = 0.02;
    expect(bandCpMin(field, sdf, 1, 0.05)).toBeCloseTo(-4.0, 9);
  });

  it("tier evaluation pins PASS, WARN, INFO boundaries", () => {
    expect(evaluateTier("PASS", 0.03, 0.05, 0.1)).toBe("pass");
    expect(evaluateTier("PASS", 0.08, 0.05, 0.1)).toBe("warn");
    expect(evaluateTier("PASS", 0.2, 0.05, 0.1)).toBe("fail");
    expect(evaluateTier("INFO", 99, 0.05, 0.1)).toBe("info");
    expect(isBlocking("PASS", "fail")).toBe(true);
    expect(isBlocking("WARN", "fail")).toBe(false);
    expect(TIER_TABLE.clAbsolute.passTol).toBe(0.05);
    expect(TIER_TABLE.alphaZero.passTol).toBe(0.25);
  });
});

describe("phase3 edge: Fortran D exponents", () => {
  it("converts upper and lower D plus E forms", () => {
    expect(fortranToFloat("0.1000000E+02")).toBeCloseTo(10, 9);
    expect(fortranToFloat("-0.1074902E+01")).toBeCloseTo(-1.074902, 6);
    expect(fortranToFloat("1.2D+03")).toBeCloseTo(1200, 9);
    expect(fortranToFloat("1.2d-03")).toBeCloseTo(0.0012, 12);
    expect(() => fortranToFloat("not-a-float")).toThrow(/finite/);
  });

  it("McCroskey fit line parses to the 0.1075 per deg slope anchor", () => {
    const table = parseTmrDat(readRaw("0012.mccroskeydata.cl.dat"));
    expect(table.zones[0].rows.length).toBe(2);
    const [a, b] = table.zones[0].rows;
    expect(a[0]).toBeCloseTo(-10, 6);
    expect(b[0]).toBeCloseTo(10, 6);
    const slope = (b[1] - a[1]) / (b[0] - a[0]);
    expect(slope).toBeCloseTo(0.1075, 3);
  });
});

describe("phase3 edge: Lednicer vs Selig auto-detect", () => {
  it("detects Lednicer for n0012 with 66 plus 66 points", () => {
    const coords = parseAirfoilDat(readRaw("n0012.dat"));
    expect(coords.upper.length).toBe(66);
    expect(coords.lower.length).toBe(66);
    expect(COORDS_0012.upper.length).toBe(66);
  });

  it("detects Selig for naca2412 as a TE to TE loop split at the LE", () => {
    const coords = parseAirfoilDat(readRaw("naca2412.dat"));
    expect(coords.upper.length).toBe(18);
    expect(coords.lower.length).toBe(18);
    expect(coords.upper[0].x).toBeCloseTo(0, 3);
    expect(coords.upper[coords.upper.length - 1].x).toBeCloseTo(1, 6);
    expect(COORDS_2412.format).toBe("selig");
  });
});

describe("phase3 edge: header not on line 11", () => {
  it("finds the CSV Alpha header after shifted metadata", () => {
    const raw = readRaw("xf-n0012-il-500000.csv");
    const padded = "Comment line one\nComment line two\n\n" + raw;
    const table = parseAirfoilToolsCsv(padded);
    expect(table.records.length).toBeGreaterThan(100);
    expect(table.records[0].alpha).toBeLessThan(-5);
  });

  it("skips the TXT dashes separator and routes auto CSV versus TXT", () => {
    const csv = parsePolarAuto(readRaw("xf-n0012-il-100000.csv"));
    const txt = parsePolarAuto(readRaw("xf-n0012-il-100000.txt"));
    expect(csv.records.length).toBe(txt.records.length);
    expect(csv.records.length).toBeGreaterThan(90);
  });
});

describe("phase3 edge: bubble corrupted Re 100k is WARN only", () => {
  it("Re 100k and Re 500k differ at 6 deg, viscous effect is real", () => {
    expect(Math.abs(clAtAlpha(POLAR_0012_RE100K.records, 6) - clAtAlpha(POLAR_0012_RE500K.records, 6))).toBeGreaterThan(0);
    const checkErrs = (got: typeof POLAR_0012_RE500K.records, ref: typeof POLAR_0012_RE500K.records): { alpha: number; err: number }[] =>
      [4, 6, 8].map((alpha) => ({ alpha, err: Math.abs(clAtAlpha(got, alpha) - clAtAlpha(ref, alpha)) }));
    expect(checkErrs(POLAR_0012_RE500K.records, POLAR_0012_RE500K.records).every((r) => r.err === 0)).toBe(true);
    const errs = checkErrs(POLAR_0012_RE100K.records, POLAR_0012_RE500K.records);
    expect(errs.map((r) => r.alpha)).toEqual([4, 6, 8]);
    expect(errs.every((r) => Number.isFinite(r.err))).toBe(true);
  });

  it("WARN tier never passes and never blocks, even at zero error", () => {
    expect(evaluateTier("WARN", 0.0, TIER_TABLE.re100kDisplay.passTol, TIER_TABLE.re100kDisplay.warnTol)).toBe("warn");
    expect(evaluateTier("WARN", 0.15, TIER_TABLE.re100kDisplay.passTol, TIER_TABLE.re100kDisplay.warnTol)).toBe("warn");
    expect(evaluateTier("WARN", 0.5, TIER_TABLE.re100kDisplay.passTol, TIER_TABLE.re100kDisplay.warnTol)).toBe("fail");
    expect(isBlocking("WARN", "fail")).toBe(false);
    expect(TIER_TABLE.re100kDisplay.warnTol).toBeGreaterThan(TIER_TABLE.clAbsolute.warnTol);
  });
});

describe("phase3 error: NaN in polar data", () => {
  it("CSV and TXT reject NaN and Infinity cells", () => {
    const csv = readRaw("xf-n0012-il-500000.csv").replace("-1.0298", "NaN");
    expect(() => parseAirfoilToolsCsv(csv)).toThrow(/finite/);
    const txt = readRaw("xf-n0012-il-500000.txt").replace("-1.0298", "Infinity");
    expect(() => parseAirfoilToolsTxt(txt)).toThrow(/finite/);
    expect(() => parseAirfoilToolsCsv("no header\n1,2,3")).toThrow();
    expect(() => parsePolarAuto("")).toThrow();
  });

  it("metrics reject NaN records and empty input", () => {
    const bad = [polarLine(0, 0), polarLine(2, Number.NaN)];
    expect(() => fitSlope(bad, 0, 2)).toThrow();
    expect(() => cpStagnation(new Float64Array([Number.NaN]))).toThrow();
    expect(() => cpShoulder(new Float64Array(0))).toThrow();
    expect(() => alphaZero({ slope: 0, intercept: 0.1, n: 2 })).toThrow();
    expect(() => clAtAlpha(POLAR_0012_RE500K.records, 12345)).toThrow();
  });
});

describe("phase3 error: oversize fixtures rejected before allocation", () => {
  it("schema caps reject huge grids and nPoints", () => {
    expect(() => validateGeometrySpec({ ...TINY_GEOM, nPoints: 8192 })).toThrow(/nPoints/);
    expect(() =>
      coerceFlowField({ nx: 4096, ny: 4096, domain: { ...DEFAULT_DOMAIN }, u: [], v: [], p: [], omega: [], obstacle: [] })
    ).toThrow(/512|cells/);
  });

  it("surrogate guards reject shape mismatches and bad manifests", () => {
    const weights = zeroWeights(2, 8, 8, [0, 0, 0]);
    expect(() => unetForward(new Float32Array(10), weights, 8, 8)).toThrow();
    expect(() => unetForward(new Float32Array(8 * 8 * 3), weights, 4, 4)).toThrow(/target/);
    expect(() => buildSurrogateInput(new Float32Array(4), new Float32Array(64), 6, 8, 8, weights.manifest.norm)).toThrow();
    expect(() => decodeSurrogateOutput(new Float32Array(3), new Float32Array(64), 8, 8, DEFAULT_DOMAIN, weights.manifest.norm, 1)).toThrow();
    expect(() => validateManifest({ ...tinyManifest(2, 128, 128), paramCount: 7 })).toThrow(/paramCount/);
    expect(() => validateManifest(null)).toThrow();
    expect(() => validateManifest({ ...tinyManifest(2, 8, 8) })).toThrow(/128/);
    expect(() => validateManifest({ ...tinyManifest(65, 128, 128) })).toThrow(/base/);
    expect(() => validateManifest({ ...tinyManifest(2, 128, 128), weightsFile: "../evil.bin" })).toThrow();
    expect(() => parseTmrDat("alpha 1.0\n2.0 3.0")).toThrow(/variables/);
    expect(() => new SurrogateFlowProvider({ grid: { nx: 8, ny: 8, domain: { ...DEFAULT_DOMAIN } }, geom: { ...TINY_GEOM, alphaDeg: 99 } })).toThrow();
  });
});

describe("phase3 error: corrupt weights fall back to analytic", () => {
  it("corrupt manifest keeps the analytic fallback finite", async () => {
    const fetchFn = (async (url: string) => {
      if (url.endsWith("model.json")) {
        return { ok: true, status: 200, json: async () => ({ ...tinyManifest(2, 8, 8), paramCount: 7 }), arrayBuffer: async () => new ArrayBuffer(0) };
      }
      return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
    }) as unknown as typeof fetch;
    const provider = new SurrogateFlowProvider({
      grid: { nx: 8, ny: 8, domain: { ...DEFAULT_DOMAIN } },
      geom: { ...TINY_GEOM },
      fetchFn,
    });
    expect(await provider.ensureLoaded()).toBe(false);
    const frame = provider.getFrame();
    expect(provider.meta.backend).toBe("analytic-fallback");
    expect(frame.nx).toBe(8);
    expect(frame.u.every((v) => Number.isFinite(v))).toBe(true);
  });

  it("grid mismatched manifest refuses to activate", async () => {
    const weights = zeroWeights(2, 8, 8, [1, 0, 0]);
    const fetchFn = (async (url: string) => {
      if (url.endsWith("model.json")) {
        return { ok: true, status: 200, json: async () => ({ ...weights.manifest, nx: 16, ny: 16 }), arrayBuffer: async () => new ArrayBuffer(0) };
      }
      return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => weights.params.buffer as ArrayBuffer };
    }) as unknown as typeof fetch;
    const provider = new SurrogateFlowProvider({
      grid: { nx: 8, ny: 8, domain: { ...DEFAULT_DOMAIN } },
      geom: { ...TINY_GEOM },
      fetchFn,
    });
    expect(await provider.ensureLoaded()).toBe(false);
    expect(provider.meta.backend).toBe("analytic-fallback");
  });
});

describe("phase3 error: non-finite surrogate output", () => {
  it("unetForward throws on non-finite network output", () => {
    const weights = zeroWeights(2, 8, 8, [Number.POSITIVE_INFINITY, 0, 0]);
    const input = new Float32Array(8 * 8 * SURROGATE_IN_CH).fill(0.5);
    expect(() => unetForward(input, weights, 8, 8)).toThrow(/non-finite/);
  });

  it("decode and input builders reject non-finite values", () => {
    const weights = zeroWeights(2, 8, 8, [0, 0, 0]);
    const obstacle = new Float32Array(64);
    const raw = new Float32Array(64 * 3).fill(1);
    raw[5] = Number.NaN;
    expect(() => decodeSurrogateOutput(raw, obstacle, 8, 8, DEFAULT_DOMAIN, weights.manifest.norm, 1)).toThrow(/non-finite/);
    const sdf = new Float32Array(64).fill(0.5);
    expect(() => buildSurrogateInput(sdf, obstacle, Number.NaN, 8, 8, weights.manifest.norm)).toThrow(/finite/);
  });
});

describe("phase3 wiring: ValidationPanel anchors and App backends", () => {
  it("clAtAlpha covers 4, 6, 8 deg in all four polars", () => {
    for (const polar of [POLAR_0012_RE100K, POLAR_0012_RE500K, POLAR_2412_RE100K, POLAR_2412_RE500K]) {
      for (const alpha of [4, 6, 8]) {
        expect(Number.isFinite(clAtAlpha(polar.records, alpha))).toBe(true);
      }
    }
  });

  it("coarse analytic solves stay finite for the panel alpha sweep", () => {
    const grid = { nx: 32, ny: 32, domain: { ...DEFAULT_DOMAIN } };
    for (const code of ["0012", "2412"] as const) {
      for (const alpha of [4, 6, 8]) {
        const geom = code === "0012"
          ? { kind: "naca4" as const, naca: { code: "0012", m: 0, p: 0.4, t: 0.12 }, chord: 1, alphaDeg: alpha, nPoints: 60 }
          : { kind: "naca4" as const, naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 }, chord: 1, alphaDeg: alpha, nPoints: 60 };
        const res = generateAnalyticFlow(grid, geom);
        expect(Number.isFinite(res.cl)).toBe(true);
        expect(Number.isFinite(res.cpMin)).toBe(true);
      }
    }
  });

  it("panel row contract: PASS rows evaluated, INFO never fails, only PASS fail blocks", () => {
    const rows = [
      { tier: "PASS" as const, err: 0.03, pass: TIER_TABLE.clAbsolute.passTol, warn: TIER_TABLE.clAbsolute.warnTol },
      { tier: "WARN" as const, err: 0.15, pass: TIER_TABLE.re100kDisplay.passTol, warn: TIER_TABLE.re100kDisplay.warnTol },
      { tier: "INFO" as const, err: 99, pass: 0.05, warn: 0.1 },
    ].map((r) => evaluateTier(r.tier, r.err, r.pass, r.warn));
    expect(rows).toEqual(["pass", "warn", "info"]);
    expect(isBlocking("PASS", rows[0] as "pass")).toBe(false);
    expect(isBlocking("PASS", "fail")).toBe(true);
    expect(isBlocking("INFO", "info")).toBe(false);
  });

  it("App backend states: injected weights serve surrogate, offline fetch holds fallback", async () => {
    const grid = { nx: 8, ny: 8, domain: { ...DEFAULT_DOMAIN } };
    const live = new SurrogateFlowProvider({ grid, geom: { ...TINY_GEOM }, weightsOverride: zeroWeights(2, 8, 8, [1, 0, 0]) });
    expect(live.getFrame().nx).toBe(8);
    expect(live.meta.backend).toBe("surrogate");
    const res = live.getResult();
    expect(Number.isFinite(res.cl)).toBe(true);
    const offline = new SurrogateFlowProvider({
      grid, geom: { ...TINY_GEOM },
      fetchFn: (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch,
    });
    expect(await offline.ensureLoaded()).toBe(false);
    expect(offline.getFrame().nx).toBe(8);
    expect(offline.meta.backend).toBe("analytic-fallback");
    expect(() => offline.setRe(-5)).toThrow();
  });
});
