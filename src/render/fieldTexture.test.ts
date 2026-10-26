import { describe, expect, it } from "vitest";
import { createFieldTextures, decodeVelocityComponent } from "./fieldTexture";
import type { FlowField } from "@/contracts/types";

function makeFlow(): FlowField {
  const nx = 4;
  const ny = 3;
  const n = nx * ny;
  const u = new Float32Array(n);
  const v = new Float32Array(n);
  const p = new Float32Array(n);
  const omega = new Float32Array(n);
  const obstacle = new Float32Array(n);
  const vals = [0, 0.5, -1.2, 2.0, -0.3, 1.0, 0.1, -2.0, 0.7, 1.5, -0.9, 0.25];
  for (let k = 0; k < n; k++) {
    u[k] = vals[k];
    v[k] = -vals[k] * 0.5;
  }
  return { nx, ny, domain: { xMin: -0.5, xMax: 2.0, yMin: -1.0, yMax: 1.0 }, u, v, p, omega, obstacle };
}

describe("fieldTexture packing", () => {
  it("maps full velocity range to 0..255 (no 0.25..0.75 compression)", () => {
    const flow = makeFlow();
    const { field, speedMax } = createFieldTextures(flow);
    const data = field.image.data as Uint8Array;
    // speedMax must be max magnitude
    let expect_max = 1e-6;
    for (let k = 0; k < flow.nx * flow.ny; k++) {
      const s = Math.hypot(flow.u[k], flow.v[k]);
      if (s > expect_max) expect_max = s;
    }
    expect(speedMax).toBeCloseTo(expect_max, 6);
    // u = +speedMax magnitude component should encode near 255 when v = 0
    void data;
    // Roundtrip: decode(encoded(u)) approximates u within one quantum
    const range = 2 * speedMax;
    const quantum = range / 255;
    for (let k = 0; k < flow.nx * flow.ny; k++) {
      const r = data[k * 4];
      const g = data[k * 4 + 1];
      const du = Math.abs(decodeVelocityComponent(r, speedMax) - flow.u[k]);
      const dv = Math.abs(decodeVelocityComponent(g, speedMax) - flow.v[k]);
      expect(du).toBeLessThanOrEqual(quantum / 2 + 1e-6);
      expect(dv).toBeLessThanOrEqual(quantum / 2 + 1e-6);
    }
  });

  it("encodes extremes to byte 0 and 255", () => {
    const n = 2;
    const mk = (u0: number): FlowField => ({
      nx: n,
      ny: 1,
      domain: { xMin: 0, xMax: 1, yMin: 0, yMax: 1 },
      u: new Float32Array([u0, -u0]),
      v: new Float32Array([0, 0]),
      p: new Float32Array(n),
      omega: new Float32Array(n),
      obstacle: new Float32Array(n),
    });
    const flow = mk(3);
    const { field } = createFieldTextures(flow);
    const data = field.image.data as Uint8Array;
    // u = +3 with speedMax 3 -> 3/6 + 0.5 = 1.0 -> 255; u = -3 -> 0
    expect(data[0]).toBe(255);
    expect(data[4]).toBe(0);
  });

  it("rejects oversized grids before allocating textures", () => {
    const big = {
      nx: 2048,
      ny: 2048,
      domain: { xMin: 0, xMax: 1, yMin: 0, yMax: 1 },
      u: new Float32Array(0),
      v: new Float32Array(0),
      p: new Float32Array(0),
      omega: new Float32Array(0),
      obstacle: new Float32Array(0),
    };
    expect(() => createFieldTextures(big)).toThrow(/cap|exceed/);
  });

  it("rejects non-finite channel elements", () => {
    const n = 4;
    const u = new Float32Array(n);
    u[2] = Infinity;
    const bad: FlowField = {
      nx: 2,
      ny: 2,
      domain: { xMin: 0, xMax: 1, yMin: 0, yMax: 1 },
      u,
      v: new Float32Array(n),
      p: new Float32Array(n),
      omega: new Float32Array(n),
      obstacle: new Float32Array(n),
    };
    expect(() => createFieldTextures(bad)).toThrow(/finite/);
  });
});
