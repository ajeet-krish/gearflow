// Engine mode selection plus LBM grid sizing. Pure and testable, no DOM
// access except through the passed search string. LBM needs square cells,
// so the LBM grid is derived from the requested size, not copied verbatim.

import type { Domain, GeometrySpec, GridSize } from "@/contracts/types";
import { MAX_CELLS, MAX_NX, MAX_NY } from "@/contracts/schema";
import { buildPolygons } from "@/geometry/parametric";

export type EngineMode = "analytic" | "wasm" | "lbm";

/**
 * Parse the engine mode from a URL search string. ?engine=lbm selects lbm,
 * ?engine=wasm selects wasm, ?wasm=1 is kept as an alias for wasm, and
 * anything else (including unknown ?engine= values) is analytic.
 */
export function readEngineMode(search: string): EngineMode {
    let params: URLSearchParams;
    try {
        const q = search.startsWith("?") ? search : `?${search}`;
        params = new URLSearchParams(q);
    } catch {
        return "analytic";
    }
    const engine = params.get("engine");
    if (engine === "lbm") return "lbm";
    if (engine === "wasm") return "wasm";
    if (engine !== null) return "analytic";
    try {
        if (params.get("wasm") === "1") return "wasm";
    } catch {
        return "analytic";
    }
    return "analytic";
}

export interface LbmGrid {
    nx: number;
    ny: number;
    reason: string | null;
}

function squareError(w: number, h: number, nx: number, ny: number): number {
    const dx = w / (nx - 1);
    const dy = h / (ny - 1);
    const avg = (dx + dy) / 2;
    if (!Number.isFinite(avg) || avg <= 0) return Infinity;
    return Math.abs(dx - dy) / avg;
}

/**
 * Derive a square-cell LBM grid from the requested size. Keeps ny at the
 * requested size and solves for nx from the domain aspect ratio, then
 * nudges nx to minimise the cell error. Returns a reason string when no
 * compliant grid fits instead of throwing.
 */
export function lbmGridFor(domain: Domain, baseGrid: GridSize | number): LbmGrid {
    const w = domain.xMax - domain.xMin;
    const h = domain.yMax - domain.yMin;
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
        return { nx: 0, ny: 0, reason: "LBM grid needs a finite domain with positive width and height." };
    }
    const target = Math.round(baseGrid);
    if (!Number.isInteger(target) || target < 4) {
        return { nx: 0, ny: 0, reason: "LBM grid needs a base size of at least 4." };
    }
    const aspect = w / h;
    if (!Number.isFinite(aspect) || aspect <= 0) {
        return { nx: 0, ny: 0, reason: "LBM grid needs a finite domain aspect ratio." };
    }
    // Try ny from the request down to 4 so extreme aspects still get a
    // chance at a small compliant grid before giving up.
    const startNy = Math.min(target, MAX_NY);
    for (let ny = startNy; ny >= 4; ny--) {
        let nx = Math.round(aspect * (ny - 1)) + 1;
        // Nudge to the best neighbour so rounding never leaves a avoidable
        // 1 percent miss on the grid actually used.
        let best = nx;
        let bestErr = squareError(w, h, nx, ny);
        for (const cand of [nx - 2, nx - 1, nx + 1, nx + 2]) {
            if (cand < 4 || cand > MAX_NX) continue;
            const err = squareError(w, h, cand, ny);
            if (err < bestErr) {
                bestErr = err;
                best = cand;
            }
        }
        nx = best;
        if (nx < 4 || nx > MAX_NX) continue;
        if (nx * ny > MAX_CELLS) continue;
        if (bestErr > 0.01) continue;
        return { nx, ny, reason: null };
    }
    return {
        nx: 0,
        ny: 0,
        reason: "LBM grid has no compliant square-cell grid within 512 per side and 262144 cells for this domain.",
    };
}

export interface BlockageInfo {
    ratio: number;
    percent: number;
    limitPercent: number;
    warning: string | null;
}

/** Reference blockage limit in percent. Mirrors the Rust BLOCKAGE_LIMIT_PERCENT. */
export const BLOCKAGE_LIMIT_PERCENT = 5;

function clampRatio(ratio: number): number {
    if (!Number.isFinite(ratio)) return 0;
    if (ratio < 0) return 0;
    if (ratio > 1) return 1;
    return ratio;
}

function reportForHeight(bodyHeight: number, domainHeight: number): BlockageInfo {
    const raw = domainHeight > 0 && Number.isFinite(domainHeight) ? bodyHeight / domainHeight : 0;
    const ratio = clampRatio(raw);
    const percent = ratio * 100;
    const warning =
        ratio > BLOCKAGE_LIMIT_PERCENT / 100
            ? `blockage ${percent.toFixed(1)} percent exceeds 5 percent reference limit, Cd will read high`
            : null;
    return { ratio, percent, limitPercent: BLOCKAGE_LIMIT_PERCENT, warning };
}

/**
 * Gap opening report for the orifice plate. The ratio stays the gap over
 * the domain height for tau and reference length parity with the Rust
 * core, while the warning is by design copy: the plate deliberately blocks
 * most of the section, so the generic Cd blockage warning is suppressed.
 */
function reportForOrificeGap(gap: number, domainHeight: number): BlockageInfo {
    const raw = domainHeight > 0 && Number.isFinite(domainHeight) ? gap / domainHeight : 0;
    const ratio = clampRatio(raw);
    const percent = ratio * 100;
    return {
        ratio,
        percent,
        limitPercent: BLOCKAGE_LIMIT_PERCENT,
        warning: `orifice plate by design, open gap ${percent.toFixed(1)} percent of tunnel height, jet Cd reads high by design`,
    };
}

/**
 * Blockage ratio for a geometry over a domain. Body height is normal to the
 * freestream over the domain height. Cylinder uses 2r, block uses the
 * rotated projected height height * cos(alpha) + width * sin(alpha),
 * orifice reports the gap opening ratio with by design copy (the plate
 * deliberately blocks most of the section, so no generic Cd warning),
 * airfoil and custom use the rotated polygon
 * y extent. Mirrors the Rust body_height_phys plus blockage_report formulas.
 */
export function blockageForGeometry(geom: GeometrySpec, domain: Domain): BlockageInfo {
    const h = domain.yMax - domain.yMin;
    if (!Number.isFinite(h) || h <= 0) {
        return { ratio: 0, percent: 0, limitPercent: BLOCKAGE_LIMIT_PERCENT, warning: null };
    }
    if (geom.kind === "cylinder") {
        const r = geom.radius ?? 0.25;
        if (!Number.isFinite(r) || r <= 0) {
            return { ratio: 0, percent: 0, limitPercent: BLOCKAGE_LIMIT_PERCENT, warning: null };
        }
        return reportForHeight(2 * r, h);
    }
    if (geom.kind === "block") {
        const bw = geom.width ?? 0.5;
        const bh = geom.height ?? 0.5;
        if (!Number.isFinite(bw) || bw <= 0 || !Number.isFinite(bh) || bh <= 0) {
            return { ratio: 0, percent: 0, limitPercent: BLOCKAGE_LIMIT_PERCENT, warning: null };
        }
        const alphaRad = ((geom.alphaDeg ?? 0) * Math.PI) / 180;
        const projected = bh * Math.abs(Math.cos(alphaRad)) + bw * Math.abs(Math.sin(alphaRad));
        return reportForHeight(projected, h);
    }
    if (geom.kind === "orifice") {
        const gap = geom.height ?? 0.4;
        if (!Number.isFinite(gap) || gap <= 0) {
            return { ratio: 0, percent: 0, limitPercent: BLOCKAGE_LIMIT_PERCENT, warning: null };
        }
        return reportForOrificeGap(gap, h);
    }
    try {
        const polys = buildPolygons(geom);
        let lo = Infinity;
        let hi = -Infinity;
        for (const poly of polys) {
            for (const p of poly) {
                if (Number.isFinite(p.y)) {
                    if (p.y < lo) lo = p.y;
                    if (p.y > hi) hi = p.y;
                }
            }
        }
        if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) {
            return { ratio: 0, percent: 0, limitPercent: BLOCKAGE_LIMIT_PERCENT, warning: null };
        }
        return reportForHeight(hi - lo, h);
    } catch {
        return { ratio: 0, percent: 0, limitPercent: BLOCKAGE_LIMIT_PERCENT, warning: null };
    }
}
