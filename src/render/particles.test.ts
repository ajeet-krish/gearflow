import { describe, expect, it } from "vitest";
import { advectParticles, createParticles, mulberry32, sampleBilinear } from "./particles";
import type { FlowField } from "@/contracts/types";

function uniformFlow(nx = 8, ny = 6, u0 = 1, v0 = 0.2): FlowField {
  const n = nx * ny;
  const u = new Float32Array(n).fill(u0);
  const v = new Float32Array(n).fill(v0);
  return {
    nx,
    ny,
    domain: { xMin: -0.5, xMax: 2.0, yMin: -1.0, yMax: 1.0 },
    u,
    v,
    p: new Float32Array(n),
    omega: new Float32Array(n),
    obstacle: new Float32Array(n),
  };
}

describe("particles", () => {
  it("samples last row and column instead of zeroing", () => {
    const flow = uniformFlow();
    const { domain } = flow;
    const edge = sampleBilinear(flow, domain.xMax, domain.yMax);
    expect(edge.u).toBeCloseTo(1, 5);
    expect(edge.v).toBeCloseTo(0.2, 5);
    const rightEdge = sampleBilinear(flow, domain.xMax, 0);
    expect(rightEdge.u).toBeCloseTo(1, 5);
    const topEdge = sampleBilinear(flow, 0.5, domain.yMax);
    expect(topEdge.u).toBeCloseTo(1, 5);
  });

  it("advect is deterministic with seeded rand", () => {
    const flow = uniformFlow();
    const a = createParticles(16, 42);
    const b = createParticles(16, 42);
    const ra = mulberry32(7);
    const rb = mulberry32(7);
    advectParticles(a, flow, 0.05, ra);
    advectParticles(b, flow, 0.05, rb);
    expect(Array.from(a.x)).toEqual(Array.from(b.x));
    expect(Array.from(a.y)).toEqual(Array.from(b.y));
  });

  it("substeps large dt without tunneling past trailing edge", () => {
    const flow = uniformFlow(8, 6, 5, 0);
    const ps = createParticles(1, 1);
    ps.x[0] = 0.9;
    ps.y[0] = 0.5;
    ps.age[0] = 0;
    const rand = mulberry32(9);
    // dt large enough that single Euler hop (5 * 0.07 = 0.35) would jump a full chord;
    // substepping keeps motion bounded by half-cell hops per sub-sample.
    advectParticles(ps, flow, 0.07, rand);
    // Particle moved forward but did not teleport across the domain in one hop
    expect(ps.x[0]).toBeGreaterThan(0.9);
    expect(ps.x[0]).toBeLessThanOrEqual(flow.domain.xMax + 0.001);
  });

  it("returns inside:false for non-finite inputs and poisoned channels", () => {
    const flow = uniformFlow();
    expect(sampleBilinear(flow, NaN, 0).inside).toBe(false);
    expect(sampleBilinear(flow, 0, Infinity).inside).toBe(false);
    const poisoned = uniformFlow();
    poisoned.u[0] = NaN;
    expect(sampleBilinear(poisoned, -0.4, -0.9).inside).toBe(false);
    const infObs = uniformFlow();
    infObs.obstacle.fill(Infinity);
    expect(sampleBilinear(infObs, 0.5, 0).inside).toBe(false);
  });
});
