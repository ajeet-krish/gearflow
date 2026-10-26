// Field texture: packs velocity into RG channels and applies a LUT on the GPU via shader.
// Phase 1 keeps it simple: DataTexture with u,v in R,G plus a small LUT texture.

import * as THREE from "three";
import type { FlowField } from "@/contracts/types";
import { MAX_CELLS, MAX_NX, MAX_NY } from "@/contracts/schema";
import { buildLut, type ColormapName } from "@/flow/colormap";

export interface FieldTextures {
  field: THREE.DataTexture;
  lut: THREE.DataTexture;
  speedMax: number;
}

export function createFieldTextures(flow: FlowField, cmap: ColormapName = "viridis"): FieldTextures {
  const { nx, ny, u, v } = flow;
  if (!Number.isInteger(nx) || !Number.isInteger(ny) || nx < 1 || ny < 1) {
    throw new Error(`Field grid must be positive integers, got ${nx}x${ny}`);
  }
  if (nx > MAX_NX || ny > MAX_NY || nx * ny > MAX_CELLS) {
    throw new Error(`Field grid ${nx}x${ny} exceeds cap ${MAX_NX}x${MAX_NY} / ${MAX_CELLS} cells`);
  }
  if (u.length !== nx * ny || v.length !== nx * ny || flow.obstacle.length !== nx * ny) {
    throw new Error("Field channels length does not match nx*ny");
  }
  for (let k = 0; k < nx * ny; k++) {
    if (!Number.isFinite(u[k]) || !Number.isFinite(v[k]) || !Number.isFinite(flow.obstacle[k])) {
      throw new Error(`Field channel element ${k} must be finite`);
    }
  }
  const data = new Uint8Array(nx * ny * 4);
  let speedMax = 1e-6;
  const speeds = new Float32Array(nx * ny);
  for (let k = 0; k < nx * ny; k++) {
    const s = Math.sqrt(u[k] * u[k] + v[k] * v[k]);
    speeds[k] = s;
    if (s > speedMax) speedMax = s;
  }
  // Hoisted once: full velocity range spans [-speedMax, +speedMax],
  // so normalized packing is u / range + 0.5 with range = 2 * speedMax.
  const range = 2 * speedMax || 1;
  // Pack normalized u,v into R,G. B holds speed magnitude, A holds obstacle.
  for (let k = 0; k < nx * ny; k++) {
    data[k * 4] = Math.round(Math.min(1, Math.max(0, u[k] / range + 0.5)) * 255);
    data[k * 4 + 1] = Math.round(Math.min(1, Math.max(0, v[k] / range + 0.5)) * 255);
    data[k * 4 + 2] = Math.round((speeds[k] / speedMax) * 255);
    data[k * 4 + 3] = Math.round(flow.obstacle[k] * 255);
  }
  const field = new THREE.DataTexture(data, nx, ny, THREE.RGBAFormat);
  field.needsUpdate = true;
  field.magFilter = THREE.LinearFilter;
  field.minFilter = THREE.LinearFilter;

  const lutBytes = buildLut(cmap, 256);
  const lutData = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    lutData[i * 4] = lutBytes[i * 3];
    lutData[i * 4 + 1] = lutBytes[i * 3 + 1];
    lutData[i * 4 + 2] = lutBytes[i * 3 + 2];
    lutData[i * 4 + 3] = 255;
  }
  const lut = new THREE.DataTexture(lutData, 256, 1, THREE.RGBAFormat);
  lut.needsUpdate = true;
  lut.magFilter = THREE.LinearFilter;
  lut.minFilter = THREE.LinearFilter;
  return { field, lut, speedMax };
}

/** Decode one packed velocity component back to physical units (roundtrip helper). */
export function decodeVelocityComponent(byte: number, speedMax: number): number {
  const range = 2 * speedMax || 1;
  return (byte / 255 - 0.5) * range;
}

/** Dispose helper for canvas cleanup paths that opt into GPU textures. */
export function disposeFieldTextures(t: FieldTextures): void {
  t.field.dispose();
  t.lut.dispose();
}
