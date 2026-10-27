// Streamline builder: pure, framework free, deterministic. RK4 integration
// with bilinear sampling. No solver math, no rendering, seed only.

import type { FlowField } from "@/contracts/types";
import { sampleBilinear } from "@/render/particles";
import { sampleColormap, type ColormapName } from "@/flow/colormap";

export interface StreamlineSeed {
    x: number;
    y: number;
}

export interface WakeHint {
    /** Recirculation length used for extra wake seeds. Null for now, no LBM yet. */
    recirculationLength: number;
    /** Trailing edge x used to anchor wake seeds. */
    teX: number;
    /** Wake centerline y used to anchor wake seeds. */
    centerY: number;
}

export interface BuildStreamlinesOptions {
    U?: number;
    colormap?: ColormapName;
    wakeHint?: WakeHint | null;
}

export interface StreamlineResult {
    positions: Float32Array;
    colors: Float32Array;
    lineCount: number;
    segmentCount: number;
}

const MAX_SEGMENTS = 60000;
const MAX_STEPS = 1500;
const MAX_ARC = 10;

function nearestObstacle(flow: FlowField, px: number, py: number): boolean {
    const { nx, ny, domain } = flow;
    if (nx < 1 || ny < 1) return true;
    const xRange = domain.xMax - domain.xMin;
    const yRange = domain.yMax - domain.yMin;
    if (xRange <= 0 || yRange <= 0) return true;
    const fx = ((px - domain.xMin) / xRange) * (nx - 1);
    const fy = ((py - domain.yMin) / yRange) * (ny - 1);
    const ix = Math.round(fx);
    const jy = Math.round(fy);
    if (ix < 0 || jy < 0 || ix >= nx || jy >= ny) return false;
    const k = jy * nx + ix;
    const o = flow.obstacle[k];
    return Number.isFinite(o) ? o > 0.5 : true;
}

function speedAt(flow: FlowField, px: number, py: number): number | null {
    const s = sampleBilinear(flow, px, py);
    if (!s.inside && Number.isFinite(s.u) && Number.isFinite(s.v)) {
        return Math.sqrt(s.u * s.u + s.v * s.v);
    }
    // sampleBilinear reports obstacle cells as inside, treat as blocked.
    const blocked = nearestObstacle(flow, px, py);
    if (blocked) return null;
    if (!Number.isFinite(s.u) || !Number.isFinite(s.v)) return null;
    return Math.sqrt(s.u * s.u + s.v * s.v);
}

function velocityAt(flow: FlowField, px: number, py: number): { u: number; v: number } | null {
    if (nearestObstacle(flow, px, py)) return null;
    const s = sampleBilinear(flow, px, py);
    if (s.inside) return null;
    if (!Number.isFinite(s.u) || !Number.isFinite(s.v)) return null;
    return { u: s.u, v: s.v };
}

/** One RK4 step of size h through the velocity field. Null when blocked. */
export function rk4Step(flow: FlowField, px: number, py: number, h: number): { x: number; y: number } | null {
    const k1 = velocityAt(flow, px, py);
    if (k1 === null) return null;
    const k2 = velocityAt(flow, px + (k1.u * h) / 2, py + (k1.v * h) / 2);
    if (k2 === null) return null;
    const k3 = velocityAt(flow, px + (k2.u * h) / 2, py + (k2.v * h) / 2);
    if (k3 === null) return null;
    const k4 = velocityAt(flow, px + k3.u * h, py + k3.v * h);
    if (k4 === null) return null;
    return {
        x: px + (h / 6) * (k1.u + 2 * k2.u + 2 * k3.u + k4.u),
        y: py + (h / 6) * (k1.v + 2 * k3.v + 2 * k2.v + k4.v),
    };
}

/** Integrate one streamline forward from a seed. Deterministic, no randomness. */
export function integrateStreamline(
    flow: FlowField,
    seed: StreamlineSeed,
    opts: { U?: number } = {},
): Array<{ x: number; y: number }> {
    const U = opts.U ?? 1;
    const dx = (flow.domain.xMax - flow.domain.xMin) / Math.max(1, flow.nx - 1);
    const dy = (flow.domain.yMax - flow.domain.yMin) / Math.max(1, flow.ny - 1);
    const cellDiag = Math.sqrt(dx * dx + dy * dy);
    const pts: Array<{ x: number; y: number }> = [{ x: seed.x, y: seed.y }];
    if (nearestObstacle(flow, seed.x, seed.y)) return pts;
    let arc = 0;
    let cx = seed.x;
    let cy = seed.y;
    for (let step = 0; step < MAX_STEPS; step += 1) {
        const sp = speedAt(flow, cx, cy);
        if (sp === null) break;
        if (sp < 0.01 * U) break;
        const denom = Math.max(sp, 0.25 * U);
        const h = (0.35 * cellDiag) / denom;
        const next = rk4Step(flow, cx, cy, h);
        if (next === null) break;
        if (
            next.x < flow.domain.xMin || next.x > flow.domain.xMax ||
            next.y < flow.domain.yMin || next.y > flow.domain.yMax
        ) {
            break;
        }
        if (!Number.isFinite(next.x) || !Number.isFinite(next.y)) break;
        const segLen = Math.sqrt((next.x - cx) * (next.x - cx) + (next.y - cy) * (next.y - cy));
        arc += segLen;
        if (arc > MAX_ARC) break;
        pts.push({ x: next.x, y: next.y });
        cx = next.x;
        cy = next.y;
    }
    return pts;
}

function bodyBBox(flow: FlowField): { xMin: number; xMax: number; yMin: number; yMax: number } | null {
    const { nx, ny, domain } = flow;
    let xMin = Infinity;
    let xMax = -Infinity;
    let yMin = Infinity;
    let yMax = -Infinity;
    for (let j = 0; j < ny; j += 1) {
        for (let i = 0; i < nx; i += 1) {
            const k = j * nx + i;
            if (flow.obstacle[k] > 0.5) {
                const x = domain.xMin + ((i / Math.max(1, nx - 1)) * (domain.xMax - domain.xMin));
                const y = domain.yMin + ((j / Math.max(1, ny - 1)) * (domain.yMax - domain.yMin));
                if (x < xMin) xMin = x;
                if (x > xMax) xMax = x;
                if (y < yMin) yMin = y;
                if (y > yMax) yMax = y;
            }
        }
    }
    if (!Number.isFinite(xMin)) return null;
    return { xMin, xMax, yMin, yMax };
}

/** Build seed rakes and integrate every line, coloring endpoints by local speed. */
export function buildStreamlines(
    flow: FlowField,
    opts: BuildStreamlinesOptions = {},
): StreamlineResult {
    const U = opts.U ?? 1;
    const colormap: ColormapName = opts.colormap ?? "viridis";
    const wakeHint = opts.wakeHint ?? null;
    const { domain, nx } = flow;
    const width = domain.xMax - domain.xMin;
    const height = domain.yMax - domain.yMin;
    const rakeCount = nx >= 256 ? 41 : 33;
    const seeds: StreamlineSeed[] = [];
    const rakeX = domain.xMin + 0.02 * width;
    for (let i = 0; i < rakeCount; i += 1) {
        const y = domain.yMin + (height * i) / (rakeCount - 1);
        seeds.push({ x: rakeX, y });
    }
    const bbox = bodyBBox(flow);
    if (bbox !== null) {
        const upstreamX = bbox.xMin - 0.05 * width;
        const cy = (bbox.yMin + bbox.yMax) / 2;
        const half = ((bbox.yMax - bbox.yMin) / 2) * 1.2;
        const n = 8;
        for (let i = 0; i < n; i += 1) {
            const y = cy - half + ((2 * half * i) / (n - 1));
            const clampedY = Math.min(domain.yMax - 1e-6, Math.max(domain.yMin + 1e-6, y));
            seeds.push({ x: Math.max(domain.xMin + 1e-6, upstreamX), y: clampedY });
        }
    }
    if (wakeHint !== null && bbox !== null) {
        const len = Math.max(0, wakeHint.recirculationLength);
        for (let i = 0; i < 3; i += 1) {
            const x = wakeHint.teX + (len * (i + 1)) / 4;
            if (x < domain.xMin || x > domain.xMax) continue;
            seeds.push({ x, y: wakeHint.centerY });
        }
    }
    const lines: Array<Array<{ x: number; y: number }>> = [];
    let projected = 0;
    for (const seed of seeds) {
        if (seed.x < domain.xMin || seed.x > domain.xMax) continue;
        if (seed.y < domain.yMin || seed.y > domain.yMax) continue;
        if (nearestObstacle(flow, seed.x, seed.y)) continue;
        const pts = integrateStreamline(flow, seed, { U });
        if (pts.length >= 2) {
            lines.push(pts);
            projected += pts.length - 1;
        }
        if (projected >= MAX_SEGMENTS) break;
    }
    let segmentCount = 0;
    for (const line of lines) segmentCount += line.length - 1;
    // Cap at 60000 segments, dropping whole lines from the end.
    while (segmentCount > MAX_SEGMENTS && lines.length > 0) {
        const last = lines.pop();
        if (last) segmentCount -= last.length - 1;
    }
    const positions = new Float32Array(segmentCount * 2 * 3);
    const colors = new Float32Array(segmentCount * 2 * 3);
    const inv255 = 1 / 255;
    let seg = 0;
    for (const line of lines) {
        for (let i = 0; i < line.length - 1; i += 1) {
            const a = line[i];
            const b = line[i + 1];
            const o = seg * 6;
            positions[o] = a.x;
            positions[o + 1] = a.y;
            positions[o + 2] = 0.05;
            positions[o + 3] = b.x;
            positions[o + 4] = b.y;
            positions[o + 5] = 0.05;
            const sa = speedAt(flow, a.x, a.y) ?? 0;
            const sb = speedAt(flow, b.x, b.y) ?? 0;
            const ta = Math.min(1, Math.max(0, sa / (1.5 * U)));
            const tb = Math.min(1, Math.max(0, sb / (1.5 * U)));
            const [ra, ga, ba] = sampleColormap(colormap, ta);
            const [rb, gb, bb] = sampleColormap(colormap, tb);
            colors[o] = ra * inv255;
            colors[o + 1] = ga * inv255;
            colors[o + 2] = ba * inv255;
            colors[o + 3] = rb * inv255;
            colors[o + 4] = gb * inv255;
            colors[o + 5] = bb * inv255;
            seg += 1;
        }
    }
    return { positions, colors, lineCount: lines.length, segmentCount: seg };
}
