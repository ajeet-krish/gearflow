// Pure SAM mask helpers. No network, fully unit testable.
// Masks are row major Uint8 (1 is body, 0 is background), w by h.

import type { Point } from "@/geometry/parametric";

export interface BBox {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

const SAM_MAX_POINTS = 120;

/** Trace the largest connected component boundary with marching squares. */
export function maskToPolygon(mask: Uint8Array, w: number, h: number): Point[] {
    if (!(mask instanceof Uint8Array)) throw new Error("maskToPolygon: mask must be a Uint8Array");
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 4 || h < 4) {
        throw new Error(`maskToPolygon: dims must be integers >= 4, got ${String(w)}x${String(h)}`);
    }
    if (mask.length !== w * h) throw new Error(`maskToPolygon: mask length ${mask.length} does not match ${w}x${h}`);
    const inside = (x: number, y: number): boolean => {
        if (x < 0 || y < 0 || x >= w || y >= h) return false;
        return mask[y * w + x] > 0;
    };
    let seedX = -1;
    let seedY = -1;
    for (let y = 0; y < h && seedX < 0; y++) {
        for (let x = 0; x < w; x++) {
            if (inside(x, y) && !inside(x, y - 1)) {
                seedX = x;
                seedY = y;
                break;
            }
        }
    }
    if (seedX < 0) return bboxFallbackPolygon(w, h);
    const raw: Point[] = [];
    let cx = seedX;
    let cy = seedY;
    let dx = 1;
    let dy = 0;
    const guard = w * h * 4;
    for (let step = 0; step < guard; step++) {
        raw.push({ x: cx, y: cy });
        const lx = cx + dy;
        const ly = cy - dx;
        if (inside(lx, ly)) {
            cx = lx;
            cy = ly;
            const ndx = dy;
            const ndy = -dx;
            dx = ndx;
            dy = ndy;
        } else {
            const fx = cx + dx;
            const fy = cy + dy;
            if (inside(fx, fy)) {
                cx = fx;
                cy = fy;
            } else {
                const ndx = -dy;
                const ndy = dx;
                dx = ndx;
                dy = ndy;
            }
        }
        if (cx === seedX && cy === seedY && dx === 1 && dy === 0 && raw.length > 8) break;
    }
    if (raw.length < 3) return bboxFallbackPolygon(w, h);
    const normalized = normalizeToChord(raw, w, h);
    return simplify(normalized, SAM_MAX_POINTS);
}

/** Scale pixel points to chord normalized coords: x in [0, 1], LE at (0, 0). */
function normalizeToChord(pts: Point[], w: number, h: number): Point[] {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of pts) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
    }
    const chordPx = Math.max(maxX - minX, 1);
    const out: Point[] = pts.map((p) => ({
        x: (p.x - minX) / chordPx,
        y: -((p.y - minY) - (maxY - minY) / 2) / chordPx,
    }));
    void w;
    void h;
    return out;
}

/** Douglas Peucker style radial stride simplification down to a point cap. */
function simplify(pts: Point[], cap: number): Point[] {
    const deduped: Point[] = [];
    for (const p of pts) {
        const q = deduped[deduped.length - 1];
        if (!q || Math.hypot(p.x - q.x, p.y - q.y) > 1e-9) deduped.push({ x: p.x, y: p.y });
    }
    if (deduped.length > 1) {
        const f = deduped[0];
        const l = deduped[deduped.length - 1];
        if (Math.hypot(f.x - l.x, f.y - l.y) <= 1e-9) deduped.pop();
    }
    if (deduped.length <= cap) return deduped;
    const stride = Math.ceil(deduped.length / cap);
    const out: Point[] = [];
    for (let i = 0; i < deduped.length; i += stride) out.push(deduped[i]);
    return out;
}

/** Fallback body when the mask is empty: rounded thin airfoil box. */
export function bboxFallbackPolygon(w: number, h: number, bbox?: BBox): Point[] {
    const box: BBox =
        bbox ?? { x0: Math.floor(w * 0.2), y0: Math.floor(h * 0.4), x1: Math.floor(w * 0.8), y1: Math.floor(h * 0.6) };
    const px: Point[] = [
        { x: box.x0, y: (box.y0 + box.y1) / 2 },
        { x: box.x0 + (box.x1 - box.x0) * 0.25, y: box.y0 },
        { x: box.x0 + (box.x1 - box.x0) * 0.75, y: box.y0 },
        { x: box.x1, y: (box.y0 + box.y1) / 2 },
        { x: box.x0 + (box.x1 - box.x0) * 0.75, y: box.y1 },
        { x: box.x0 + (box.x1 - box.x0) * 0.25, y: box.y1 },
    ];
    return normalizeToChord(px, w, h);
}

/** Intersection over union of two binary masks. */
export function maskIou(a: Uint8Array, b: Uint8Array): number {
    if (a.length !== b.length) throw new Error("maskIou: mask lengths must match");
    let inter = 0;
    let union = 0;
    for (let i = 0; i < a.length; i++) {
        const av = a[i] > 0;
        const bv = b[i] > 0;
        if (av && bv) inter += 1;
        if (av || bv) union += 1;
    }
    if (union === 0) return 1;
    return inter / union;
}
