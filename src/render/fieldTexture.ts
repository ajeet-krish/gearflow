// Field texture: packs velocity plus a selectable scalar quantity for the
// GPU shader path. R holds u, G holds v, B holds the normalized quantity
// selected by FieldMode (speed, cp, omega, u, v), A holds obstacle.
// A 256x1 RGBA LUT texture carries the active colormap. TKE packs through
// a log scale because it spans decades; recirculation packs as a mask.

import * as THREE from "three";
import type { FieldMode, FlowField } from "@/contracts/types";
import { MAX_CELLS, MAX_NX, MAX_NY } from "@/contracts/schema";
import { buildLut, kLogScaleFor, normalizeKLogValue, normalizeRecircValue, readQuantity, variableRange, type ColormapName } from "@/flow/colormap";

export interface FieldTextures {
    field: THREE.DataTexture;
    lut: THREE.DataTexture;
    speedMax: number;
    /** Data range of the packed B channel quantity. */
    qMin: number;
    qMax: number;
    variable: FieldMode;
    colormap: ColormapName;
    nx: number;
    ny: number;
}

export function createFieldTextures(
    flow: FlowField,
    cmap: ColormapName = "viridis",
    variable: FieldMode = "speed",
    meanFields = false
): FieldTextures {
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
        if (!Number.isFinite(flow.p[k]) || !Number.isFinite(flow.omega[k])) {
            throw new Error(`Field quantity element ${k} must be finite for variable ${variable}`);
        }
    }
    const { min, max } = variableRange(variable, flow, meanFields);
    const kScale = variable === "k" ? kLogScaleFor(flow) : null;
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
    const velRange = 2 * speedMax || 1;
    const qSpan = max - min || 1;
    // Pack normalized u,v into R,G. B holds the selected quantity, A holds obstacle.
    // TKE uses a log scale, recirculation packs as a binary mask.
    for (let k = 0; k < nx * ny; k++) {
        const q = readQuantity(variable, flow, k, meanFields);
        if (!Number.isFinite(q)) {
            throw new Error(`Field quantity element ${k} must be finite for variable ${variable}`);
        }
        data[k * 4] = Math.round(Math.min(1, Math.max(0, u[k] / velRange + 0.5)) * 255);
        data[k * 4 + 1] = Math.round(Math.min(1, Math.max(0, v[k] / velRange + 0.5)) * 255);
        const bt = variable === "k"
            ? (kScale === null ? 0 : normalizeKLogValue(q, kScale))
            : variable === "recirc"
                ? normalizeRecircValue(q)
                : Math.min(1, Math.max(0, (q - min) / qSpan));
        data[k * 4 + 2] = Math.round(bt * 255);
        data[k * 4 + 3] = Math.round(flow.obstacle[k] * 255);
    }
    const field = new THREE.DataTexture(data, nx, ny, THREE.RGBAFormat);
    field.needsUpdate = true;
    field.magFilter = THREE.LinearFilter;
    field.minFilter = THREE.LinearFilter;

    const lut = buildLutTexture(cmap);
    return { field, lut, speedMax, qMin: min, qMax: max, variable, colormap: cmap, nx, ny };
}

/** Standalone 256x1 RGBA LUT texture for one colormap. */
export function buildLutTexture(cmap: ColormapName): THREE.DataTexture {
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
    return lut;
}

/**
 * Refresh packed textures in place. Reuses GPU textures when the grid and
 * colormap match (B channel, LUT, and ranges are rewritten), recreates the
 * field texture on a grid change or the LUT on a colormap change.
 */
export function updateFieldTextures(
    prev: FieldTextures | null,
    flow: FlowField,
    cmap: ColormapName,
    variable: FieldMode,
    meanFields = false
): FieldTextures {
    if (prev === null || prev.nx !== flow.nx || prev.ny !== flow.ny) {
        if (prev !== null) disposeFieldTextures(prev);
        return createFieldTextures(flow, cmap, variable, meanFields);
    }
    if (prev.colormap !== cmap) {
        prev.lut.dispose();
        prev.lut = buildLutTexture(cmap);
        prev.colormap = cmap;
    }
    const { nx, ny, u, v } = flow;
    if (u.length !== nx * ny || v.length !== nx * ny || flow.obstacle.length !== nx * ny) {
        throw new Error("Field channels length does not match nx*ny");
    }
    if (flow.p.length !== nx * ny || flow.omega.length !== nx * ny) {
        throw new Error("Field quantity channels length does not match nx*ny");
    }
    const { min, max } = variableRange(variable, flow, meanFields);
    const kScale = variable === "k" ? kLogScaleFor(flow) : null;
    let speedMax = 1e-6;
    for (let k = 0; k < nx * ny; k++) {
        if (!Number.isFinite(u[k]) || !Number.isFinite(v[k]) || !Number.isFinite(flow.obstacle[k])) {
            throw new Error(`Field channel element ${k} must be finite`);
        }
        if (!Number.isFinite(flow.p[k]) || !Number.isFinite(flow.omega[k])) {
            throw new Error(`Field quantity element ${k} must be finite for variable ${variable}`);
        }
        const s = Math.sqrt(u[k] * u[k] + v[k] * v[k]);
        if (s > speedMax) speedMax = s;
    }
    const velRange = 2 * speedMax || 1;
    const qSpan = max - min || 1;
    const data = prev.field.image.data as Uint8Array;
    for (let k = 0; k < nx * ny; k++) {
        const q = readQuantity(variable, flow, k, meanFields);
        if (!Number.isFinite(q)) {
            throw new Error(`Field quantity element ${k} must be finite for variable ${variable}`);
        }
        data[k * 4] = Math.round(Math.min(1, Math.max(0, u[k] / velRange + 0.5)) * 255);
        data[k * 4 + 1] = Math.round(Math.min(1, Math.max(0, v[k] / velRange + 0.5)) * 255);
        const bt = variable === "k"
            ? (kScale === null ? 0 : normalizeKLogValue(q, kScale))
            : variable === "recirc"
                ? normalizeRecircValue(q)
                : Math.min(1, Math.max(0, (q - min) / qSpan));
        data[k * 4 + 2] = Math.round(bt * 255);
        data[k * 4 + 3] = Math.round(flow.obstacle[k] * 255);
    }
    prev.field.needsUpdate = true;
    prev.speedMax = speedMax;
    prev.qMin = min;
    prev.qMax = max;
    prev.variable = variable;
    return prev;
}

/** Decode one packed velocity component back to physical units (roundtrip helper). */
export function decodeVelocityComponent(byte: number, speedMax: number): number {
    const range = 2 * speedMax || 1;
    return (byte / 255 - 0.5) * range;
}

/** Decode one packed B channel byte back to quantity units. */
export function decodeQuantity(byte: number, qMin: number, qMax: number): number {
    const span = qMax - qMin || 1;
    return (byte / 255) * span + qMin;
}

/** Dispose helper for canvas cleanup paths that opt into GPU textures. */
export function disposeFieldTextures(t: FieldTextures): void {
    t.field.dispose();
    t.lut.dispose();
}
