// GearFlow Phase 2 hardening: analytic flow (Hess-Smith panels, cylinder
// analytic, SDF, wake, provider cache, sliders UI with error boundary).
// Happy path uses measured oracles from 2026-10-26 (Cl 0.974988, CpMin
// -2.487990 for 2412 at 6deg on the default 128x128 grid). Edge cases sweep
// AoA minus 4 to 12 and thickness 0.06 to 0.18. Error cases prove oversize,
// NaN, poisoned spec, and singular systems are all caught.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { generateAnalyticFlow, resolveBody } from "@/flow/analyticFlow";
import {
  buildPanels,
  solveBodies,
  solvePanels,
  panelVelocity,
  cylinderVelocity,
  MAX_PANELS,
  MAX_TOTAL_PANELS,
} from "@/flow/potential";
import { buildSdfGrid, polygonSdf } from "@/flow/sdf";
import { applyWake } from "@/flow/wake";
import { AnalyticFlowProvider } from "@/flow/frameSource";
import ErrorBoundary from "@/ui/ErrorBoundary";
import { blockPolygon, cylinderPolygon } from "@/geometry/parametric";
import { DEFAULT_GRID } from "@/contracts/types";
import type { GeometrySpec, GridSpec } from "@/contracts/types";
import {
  ALPHA_MIN,
  ALPHA_MAX,
  ALPHA_HARD_MIN,
  ALPHA_HARD_MAX,
  NACA_T_MIN,
  NACA_T_MAX_ENV,
  alphaBand,
} from "@/contracts/schema";

const SMALL: GridSpec = { nx: 64, ny: 64, domain: { ...DEFAULT_GRID.domain } };

const NACA: GeometrySpec = {
  kind: "naca4",
  naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 },
  chord: 1,
  alphaDeg: 6,
  nPoints: 60,
};

const CYL: GeometrySpec = {
  kind: "cylinder",
  chord: 1,
  alphaDeg: 0,
  nPoints: 96,
  radius: 0.25,
  center: { x: 0.5, y: 0 },
};

describe("phase2 happy path: 2412 at 6deg analytic oracle", () => {
  it("Cl sits in the lifting band and matches the recorded oracle", () => {
    const r = generateAnalyticFlow(DEFAULT_GRID, NACA);
    expect(r.cl).toBeGreaterThan(0.5);
    expect(r.cl).toBeLessThan(1.6);
    expect(r.cl).toBeCloseTo(0.975, 1);
    expect(r.panelCount).toBeGreaterThan(10);
    expect(Number.isFinite(r.solveMs)).toBe(true);
  });

  it("Cp oracle: suction peak near minus 2.5, finite everywhere", () => {
    const r = generateAnalyticFlow(DEFAULT_GRID, NACA);
    expect(r.cpMin).toBeLessThan(-1);
    expect(r.cpMin).toBeCloseTo(-2.488, 1);
    const { body } = resolveBody(NACA, 1);
    let cpMax = -Infinity;
    for (const c of body.sol.cp) {
      expect(Number.isFinite(c)).toBe(true);
      if (c > cpMax) cpMax = c;
    }
    expect(cpMax).toBeLessThanOrEqual(1);
    expect(cpMax).toBeGreaterThan(0.5);
  });

  it("cylinder panel oracle: stagnation Cp near 1, suction near minus 3", () => {
    const sol = solvePanels(buildPanels(cylinderPolygon(0.5, 0, 0.25, 128)), 1, 1, { kutta: false });
    let cpMax = -Infinity;
    let cpMin = Infinity;
    for (const c of sol.cp) {
      if (c > cpMax) cpMax = c;
      if (c < cpMin) cpMin = c;
    }
    expect(cpMax).toBeGreaterThan(0.95);
    expect(cpMax).toBeLessThanOrEqual(1);
    expect(cpMin).toBeLessThan(-2.7);
    expect(cpMin).toBeGreaterThan(-3.3);
  });

  it("cylinder field recovers stagnation pressure and suction", () => {
    const r = generateAnalyticFlow(DEFAULT_GRID, CYL, { Re: 1000 });
    let pMax = -Infinity;
    let pMin = Infinity;
    for (let k = 0; k < r.field.u.length; k++) {
      if (r.field.obstacle[k] > 0.5) continue;
      if (r.field.p[k] > pMax) pMax = r.field.p[k];
      if (r.field.p[k] < pMin) pMin = r.field.p[k];
    }
    expect(pMax).toBeGreaterThan(0.35);
    expect(pMin).toBeLessThan(-0.8);
  });

  it("deterministic: same inputs give identical fields and loads", () => {
    const a = generateAnalyticFlow(SMALL, NACA);
    const b = generateAnalyticFlow(SMALL, NACA);
    expect(a.field.u).toEqual(b.field.u);
    expect(a.field.v).toEqual(b.field.v);
    expect(a.cl).toBe(b.cl);
    expect(a.cpMin).toBe(b.cpMin);
  });
});

describe("phase2 edge cases: AoA sweep, thickness sweep, wake-only Re", () => {
  it("AoA minus 4 to 12: finite, strictly rising Cl, sign flip", () => {
    const alphas = [-4, -2, 0, 2, 4, 6, 8, 10, 12];
    const cls: number[] = [];
    for (const alphaDeg of alphas) {
      const r = generateAnalyticFlow(SMALL, { ...NACA, alphaDeg });
      expect(Number.isFinite(r.cl)).toBe(true);
      expect(Number.isFinite(r.cpMin)).toBe(true);
      for (let k = 0; k < r.field.u.length; k++) {
        expect(Number.isFinite(r.field.u[k])).toBe(true);
        expect(Number.isFinite(r.field.v[k])).toBe(true);
      }
      cls.push(r.cl);
    }
    for (let i = 1; i < cls.length; i++) {
      expect(cls[i]).toBeGreaterThan(cls[i - 1]);
    }
    expect(cls[0]).toBeLessThan(0);
    expect(cls[2]).toBeGreaterThan(0);
    expect(cls[cls.length - 1]).toBeGreaterThan(1.5);
  });

  it("thickness sweep 0.06 to 0.18: finite, Cl stable, panel count stable", () => {
    const counts = new Set<number>();
    for (const t of [0.06, 0.09, 0.12, 0.15, 0.18]) {
      const code = `24${String(Math.round(t * 100)).padStart(2, "0")}`;
      const r = generateAnalyticFlow(SMALL, {
        kind: "naca4",
        naca: { code, m: 0.02, p: 0.4, t },
        chord: 1,
        alphaDeg: 6,
        nPoints: 60,
      });
      expect(Number.isFinite(r.cl)).toBe(true);
      expect(r.cl).toBeGreaterThan(0.8);
      expect(r.cl).toBeLessThan(1.15);
      counts.add(r.panelCount);
    }
    expect(counts.size).toBe(1);
  });

  it("Re is wake only: identical loads, upstream bitwise equal, wake differs", () => {
    const low = generateAnalyticFlow(SMALL, NACA, { Re: 100 });
    const high = generateAnalyticFlow(SMALL, NACA, { Re: 50000 });
    expect(low.cl).toBe(high.cl);
    expect(low.cpMin).toBe(high.cpMin);
    let downstreamDiff = 0;
    const { domain } = SMALL;
    for (let j = 0; j < SMALL.ny; j++) {
      for (let i = 0; i < SMALL.nx; i++) {
        const x = domain.xMin + ((domain.xMax - domain.xMin) * i) / (SMALL.nx - 1);
        const k = j * SMALL.nx + i;
        if (low.field.obstacle[k] > 0.5) continue;
        if (x < 0.8) {
          expect(low.field.u[k]).toBe(high.field.u[k]);
          expect(low.field.v[k]).toBe(high.field.v[k]);
        } else if (x > 1.0) {
          downstreamDiff = Math.max(downstreamDiff, Math.abs(low.field.u[k] - high.field.u[k]));
        }
      }
    }
    expect(downstreamDiff).toBeGreaterThan(1e-6);
  });

  it("orifice shows speedup in the gap", () => {
    const orifice: GeometrySpec = {
      kind: "orifice",
      chord: 1,
      alphaDeg: 0,
      nPoints: 64,
      width: 0.08,
      height: 0.4,
      center: { x: 0.5, y: 0 },
    };
    const r = generateAnalyticFlow(SMALL, orifice);
    let maxU = -Infinity;
    const { domain } = SMALL;
    for (let j = 0; j < SMALL.ny; j++) {
      const y = domain.yMin + ((domain.yMax - domain.yMin) * j) / (SMALL.ny - 1);
      if (Math.abs(y) > 0.15) continue;
      for (let i = 0; i < SMALL.nx; i++) {
        const x = domain.xMin + ((domain.xMax - domain.xMin) * i) / (SMALL.nx - 1);
        if (x < 0 || x > 1) continue;
        const k = j * SMALL.nx + i;
        if (r.field.obstacle[k] > 0.5) continue;
        if (r.field.u[k] > maxU) maxU = r.field.u[k];
      }
    }
    expect(maxU).toBeGreaterThan(1.02);
  });

  it("cylinder gamma 0: exact zero vortex, near zero Cl, symmetric field", () => {
    const { body } = resolveBody(CYL, 1);
    for (const g of body.sol.gammas) expect(g).toBe(0);
    expect(body.sol.gamma).toBe(0);
    expect(Math.abs(body.sol.cl)).toBeLessThan(0.05);
    const a = cylinderVelocity(1.0, 0.2, 0.5, 0, 0.25, 1, 0);
    const b = cylinderVelocity(1.0, -0.2, 0.5, 0, 0.25, 1, 0);
    expect(a.u).toBeCloseTo(b.u, 12);
    expect(a.v).toBeCloseTo(-b.v, 12);
    const c = cylinderVelocity(1.0, 0.2, 0.5, 0, 0.25, 1, 0.5);
    expect(Math.abs(c.u - a.u) + Math.abs(c.v - a.v)).toBeGreaterThan(1e-6);
    const inside = cylinderVelocity(0.5, 0, 0.5, 0, 0.25, 1, 0);
    expect(inside.u).toBe(0);
    expect(inside.v).toBe(0);
  });
});

describe("phase2 error conditions: oversize, NaN, poisoned spec, singular", () => {
  it("oversize panels rejected before allocation", () => {
    const panels = buildPanels(cylinderPolygon(0.5, 0, 0.25, 96));
    const oversize = [...panels];
    while (oversize.length <= MAX_PANELS) oversize.push({ ...oversize[0] });
    expect(() => solvePanels(oversize, 1)).toThrow(/cap/);
    expect(() => solveBodies([oversize], 1)).toThrow(/per-body cap/);
    const a = buildPanels(cylinderPolygon(0.5, 0, 0.25, 128));
    const b = buildPanels(blockPolygon(0.5, 0, 0.5, 0.5, 128));
    const c = buildPanels(cylinderPolygon(-0.5, 0.5, 0.2, 128));
    expect(a.length + b.length + c.length).toBeGreaterThan(MAX_TOTAL_PANELS);
    expect(() => solveBodies([a, b, c], 1, 1, [false, false, false])).toThrow(/exceed cap/);
    expect(() =>
      generateAnalyticFlow(SMALL, { ...NACA, nPoints: 5000 })
    ).toThrow(/nPoints/);
  });

  it("oversize SDF grids rejected before allocation", () => {
    const polys = Array.from({ length: 9 }, () => cylinderPolygon(0.5, 0, 0.25, 8));
    expect(() => buildSdfGrid(polys, SMALL)).toThrow(/bodies exceed cap/);
    const ring = (cx: number): { x: number; y: number }[] =>
      Array.from({ length: 1200 }, (_, k) => {
        const ang = (k / 1200) * 2 * Math.PI;
        return { x: cx + 0.1 * Math.cos(ang), y: 0.1 * Math.sin(ang) };
      });
    expect(() => buildSdfGrid([ring(0.5), ring(1.0)], SMALL)).toThrow(/total points exceed cap/);
  });

  it("NaN and non-finite inputs throw with a clear message", () => {
    expect(() => generateAnalyticFlow(SMALL, NACA, { U: NaN })).toThrow(/U/);
    expect(() => generateAnalyticFlow(SMALL, NACA, { Re: NaN })).toThrow(/Re/);
    expect(() => generateAnalyticFlow(SMALL, NACA, { Re: Infinity })).toThrow(/Re/);
    expect(() => resolveBody(NACA, 0)).toThrow(/U/);
    expect(() => resolveBody(NACA, NaN)).toThrow(/U/);
    expect(() => panelVelocity(NaN, 0, resolveBody(NACA, 1).body.sol, 1)).toThrow(/finite/);
    expect(() => cylinderVelocity(1, 0, 0.5, 0, 0.25, 1, NaN)).toThrow(/gamma/);
    expect(() => cylinderVelocity(1, 0, 0.5, 0, -1, 1)).toThrow(/radius/);
    const n = SMALL.nx * SMALL.ny;
    expect(() =>
      applyWake(new Float32Array(n), new Float32Array(n), SMALL.nx, SMALL.ny, SMALL.domain, new Float32Array(n), {
        U: 1,
        Re: NaN,
        baseY: 0,
        slope: 0,
      })
    ).toThrow(/Re/);
    expect(() => polygonSdf(NaN, 0, cylinderPolygon(0.5, 0, 0.25, 16))).toThrow(/finite/);
    expect(() => buildPanels([{ x: 0, y: 0 }, { x: NaN, y: 0 }, { x: 1, y: 1 }])).toThrow(/finite/);
    expect(() => buildSdfGrid([[{ x: 0, y: 0 }, { x: 1, y: Infinity }, { x: 1, y: 1 }]], SMALL)).toThrow(/finite/);
  });

  it("poisoned spec keeps last good: provider rejects without mutating state", () => {
    const p = new AnalyticFlowProvider(SMALL, NACA, { Re: 1000 });
    const good = p.getFrame();
    const goodU = good.u.slice();
    expect(p.solveCount).toBe(1);
    expect(() => p.setGeometry({ ...NACA, alphaDeg: 200 })).toThrow(/alphaDeg/);
    expect(() => p.setGeometry({ ...NACA, naca: { code: "2912", m: 0.02, p: 0.9, t: 0.12 } })).toThrow(/naca/);
    expect(() => p.setAlpha(200)).toThrow(/alphaDeg/);
    expect(() => p.setAlpha(-200)).toThrow(/alphaDeg/);
    expect(() => p.setRe(NaN)).toThrow(/Re/);
    const after = p.getFrame();
    expect(p.solveCount).toBe(1);
    expect(after.u).toEqual(goodU);
    expect(after).toBe(good);
  });

  it("singular system is caught, not returned as NaN loads", () => {
    const dup = { x1: 0, y1: 0, x2: 1, y2: 0, xc: 0.5, yc: 0, tx: 1, ty: 0, nx: 0, ny: -1, len: 1 };
    expect(() => solveBodies([[dup, { ...dup }, { ...dup }]], 1, 1, [false])).toThrow(/singular/);
    expect(() => solvePanels([], 1)).toThrow(/at least 3/);
    expect(() => solveBodies([[{ ...dup }]], 1)).toThrow(/at least 3/);
  });
});

describe("phase2 provider cache and UI contract", () => {
  it("alpha re-resolves, Re reuses panels, equal geometry skips solve", () => {
    const p = new AnalyticFlowProvider(SMALL, NACA, { Re: 100 });
    p.getFrame();
    expect(p.solveCount).toBe(1);
    p.setRe(2000);
    p.getFrame();
    expect(p.solveCount).toBe(1);
    p.setGeometry({ ...NACA, naca: { ...NACA.naca! } });
    p.getFrame();
    expect(p.solveCount).toBe(1);
    p.setAlpha(10);
    p.getFrame();
    expect(p.solveCount).toBe(2);
    const res = p.getResult();
    expect(res.cl).toBeGreaterThan(0.5);
    expect(res.cpMin).toBeLessThan(-1);
    expect(res.panelCount).toBeGreaterThan(10);
  });

  it("slider band matches the characterized band while full rotation solves", () => {
    expect(ALPHA_MIN).toBe(-4);
    expect(ALPHA_MAX).toBe(12);
    expect(ALPHA_HARD_MIN).toBe(-180);
    expect(ALPHA_HARD_MAX).toBe(180);
    expect(NACA_T_MIN).toBe(0.06);
    expect(NACA_T_MAX_ENV).toBe(0.4);
    const src = fs.readFileSync(path.join(process.cwd(), "src/ui/FlowControls.tsx"), "utf8");
    expect(src).toMatch(/min=\{-4\}/);
    expect(src).toMatch(/max=\{12\}/);
    expect(src).toMatch(/min=\{0\.06\}/);
    expect(src).toMatch(/max=\{0\.18\}/);
    expect(src).toMatch(/min=\{LOG_RE_MIN\}/);
    expect(src).toMatch(/max=\{LOG_RE_MAX\}/);
    for (const edge of [-4, 12]) {
      expect(() => generateAnalyticFlow(SMALL, { ...NACA, alphaDeg: edge })).not.toThrow();
    }
    for (const outOfBand of [-90, 45]) {
      expect(() => generateAnalyticFlow(SMALL, { ...NACA, alphaDeg: outOfBand })).not.toThrow();
      expect(alphaBand(outOfBand)).toBe("out-of-band");
    }
    for (const bad of [-181, 200]) {
      expect(() => generateAnalyticFlow(SMALL, { ...NACA, alphaDeg: bad })).toThrow(/alphaDeg/);
    }
  });

  it("error boundary converts crashes to renderable state and offers retry", () => {
    const fromError = ErrorBoundary.getDerivedStateFromError(new Error("panel blowup"));
    expect(fromError).toEqual({ error: "panel blowup" });
    const fromString = ErrorBoundary.getDerivedStateFromError("plain failure");
    expect(fromString).toEqual({ error: "plain failure" });
    const src = fs.readFileSync(path.join(process.cwd(), "src/ui/ErrorBoundary.tsx"), "utf8");
    expect(src).toMatch(/role="alert"/);
    expect(src).toMatch(/Retry render/);
    expect(src).toMatch(/resetKey/);
  });
});
