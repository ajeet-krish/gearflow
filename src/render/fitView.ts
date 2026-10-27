// Fit to domain: camera framing that keeps the whole wind tunnel visible.
// Pure maths, no renderer dependency, so shell tests can assert the framing.
// The plane mesh is centered on the domain center, so the camera centers
// there too and grows the smaller axis to match the viewport aspect.

import type { Domain } from "@/contracts/types";

export interface FitView {
    left: number;
    right: number;
    top: number;
    bottom: number;
}

/** Breathing room around the domain edges, as a fraction of half extent. */
export const FIT_MARGIN = 0.04;

export function fitDomainView(domain: Domain, viewW: number, viewH: number, margin = FIT_MARGIN): FitView {
    const dw = domain.xMax - domain.xMin;
    const dh = domain.yMax - domain.yMin;
    // Degenerate domains (zero, negative, or non-finite extent) cannot frame:
    // fall back to a unit half extent on a 2 by 2 square so the camera stays
    // finite and centered instead of inverting or emitting NaN.
    const ew = Number.isFinite(dw) && dw > 0 ? dw : 2;
    const eh = Number.isFinite(dh) && dh > 0 ? dh : 2;
    const rawCx = (domain.xMin + domain.xMax) / 2;
    const rawCy = (domain.yMin + domain.yMax) / 2;
    const cx = Number.isFinite(rawCx) ? rawCx : 0;
    const cy = Number.isFinite(rawCy) ? rawCy : 0;
    const safeW = viewW > 0 ? viewW : 800;
    const safeH = viewH > 0 ? viewH : 450;
    const viewAspect = safeW / safeH;
    const domAspect = ew / eh;
    let halfW: number;
    let halfH: number;
    if (viewAspect >= domAspect) {
        halfH = (eh / 2) * (1 + margin);
        halfW = halfH * viewAspect;
    } else {
        halfW = (ew / 2) * (1 + margin);
        halfH = halfW / viewAspect;
    }
    return { left: cx - halfW, right: cx + halfW, top: cy + halfH, bottom: cy - halfH };
}
