// CPU particle advection with bilinear sampling. Seeded so runs are reproducible.
// 3000 particles by default, respawn at inlet when leaving domain or entering obstacle.

import type { FlowField } from "@/contracts/types";

export interface ParticleSet {
  x: Float32Array;
  y: Float32Array;
  age: Float32Array;
  count: number;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Shared deterministic fallback so advectParticles never depends on Math.random.
const defaultRand = mulberry32(0xc0ffee);

export function createParticles(count: number, seed = 1337): ParticleSet {
  const rand = mulberry32(seed);
  const x = new Float32Array(count);
  const y = new Float32Array(count);
  const age = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    x[i] = -0.5 + rand() * 2.5;
    y[i] = -1 + rand() * 2;
    age[i] = rand() * 100;
  }
  return { x, y, age, count };
}

export function sampleBilinear(flow: FlowField, px: number, py: number): { u: number; v: number; inside: boolean } {
  const { nx, ny, domain } = flow;
  if (nx < 2 || ny < 2) return { u: 0, v: 0, inside: false };
  if (!Number.isFinite(px) || !Number.isFinite(py)) return { u: 0, v: 0, inside: false };
  if (!Number.isFinite(domain.xMin) || !Number.isFinite(domain.xMax) || !Number.isFinite(domain.yMin) || !Number.isFinite(domain.yMax)) {
    return { u: 0, v: 0, inside: false };
  }
  if (domain.xMax <= domain.xMin || domain.yMax <= domain.yMin) return { u: 0, v: 0, inside: false };
  const fx = ((px - domain.xMin) / (domain.xMax - domain.xMin)) * (nx - 1);
  const fy = ((py - domain.yMin) / (domain.yMax - domain.yMin)) * (ny - 1);
  if (fx < 0 || fy < 0 || fx > nx - 1 || fy > ny - 1) return { u: 0, v: 0, inside: false };
  // Clamp to the last cell so top row and right column sample instead of zeroing.
  const i0 = Math.min(Math.floor(fx), nx - 2);
  const j0 = Math.min(Math.floor(fy), ny - 2);
  const tx = Math.min(1, Math.max(0, fx - i0));
  const ty = Math.min(1, Math.max(0, fy - j0));
  const k00 = j0 * nx + i0;
  const k10 = k00 + 1;
  const k01 = k00 + nx;
  const k11 = k01 + 1;
  const bu = (a: number, b: number, c: number, d: number) => a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
  const corners = [flow.obstacle[k00], flow.obstacle[k10], flow.obstacle[k01], flow.obstacle[k11],
    flow.u[k00], flow.u[k10], flow.u[k01], flow.u[k11],
    flow.v[k00], flow.v[k10], flow.v[k01], flow.v[k11]];
  if (!corners.every(Number.isFinite)) return { u: 0, v: 0, inside: false };
  const obs = bu(flow.obstacle[k00], flow.obstacle[k10], flow.obstacle[k01], flow.obstacle[k11]);
  if (!Number.isFinite(obs)) return { u: 0, v: 0, inside: false };
  if (obs > 0.5) return { u: 0, v: 0, inside: true };
  const uu = bu(flow.u[k00], flow.u[k10], flow.u[k01], flow.u[k11]);
  const vv = bu(flow.v[k00], flow.v[k10], flow.v[k01], flow.v[k11]);
  if (!Number.isFinite(uu) || !Number.isFinite(vv)) return { u: 0, v: 0, inside: false };
  return { u: uu, v: vv, inside: false };
}

export function advectParticles(ps: ParticleSet, flow: FlowField, dt: number, rand: () => number = defaultRand): void {
  const { domain } = flow;
  const dx = (domain.xMax - domain.xMin) / Math.max(1, flow.nx - 1);
  const dy = (domain.yMax - domain.yMin) / Math.max(1, flow.ny - 1);
  const minCell = Math.min(dx, dy);
  const maxSub = 16;
  for (let i = 0; i < ps.count; i++) {
    let s = sampleBilinear(flow, ps.x[i], ps.y[i]);
    if (s.inside) {
      ps.x[i] = domain.xMin + 0.02;
      ps.y[i] = domain.yMin + rand() * (domain.yMax - domain.yMin);
      ps.age[i] = 0;
      continue;
    }
    // Substep so no single hop exceeds half a cell (prevents TE tunneling on large dt).
    const mag = Math.sqrt(s.u * s.u + s.v * s.v);
    let nSub = 1;
    if (mag > 0 && minCell > 0) {
      nSub = Math.min(maxSub, Math.max(1, Math.ceil((mag * dt) / (0.5 * minCell))));
    }
    const h = dt / nSub;
    for (let n = 0; n < nSub; n++) {
      s = sampleBilinear(flow, ps.x[i], ps.y[i]);
      if (s.inside) break;
      ps.x[i] += s.u * h;
      ps.y[i] += s.v * h;
      ps.age[i] += h;
      if (ps.x[i] > domain.xMax || ps.x[i] < domain.xMin || ps.y[i] > domain.yMax || ps.y[i] < domain.yMin || ps.age[i] > 12) {
        ps.x[i] = domain.xMin + 0.02 + rand() * 0.1;
        ps.y[i] = domain.yMin + rand() * (domain.yMax - domain.yMin);
        ps.age[i] = 0;
        break;
      }
    }
    if (s.inside) {
      ps.x[i] = domain.xMin + 0.02;
      ps.y[i] = domain.yMin + rand() * (domain.yMax - domain.yMin);
      ps.age[i] = 0;
    }
  }
}
