// Sketch to spec via SAM 3.1. Uploads the sketch bytes, converts the mask to
// a chord normalized polygon, and falls back to a bbox proxy when the mask
// is missing or empty. Returns a custom kind GeometrySpec. Sketch bytes are
// capped at 5 MiB with PNG/JPEG only; fallback results are never cached.

import { validateSamPolygon } from "@/contracts/schema";
import type { GeometrySpec, SamResult } from "@/contracts/types";
import { META_DEFAULT_SAM_MODEL, type MetaClient } from "./client";
import { TTL_SAM_MS, hashBytes, type HashCache } from "./cache";
import { bboxFallbackPolygon, maskToPolygon } from "./samMask";

export const SAM_MAX_SKETCH_BYTES = 5 * 1024 * 1024;
export const SAM_ALLOWED_MIME = ["image/png", "image/jpeg"] as const;
export const SAM_MAX_DIM = 2048;
export const SAM_MAX_MASK_CELLS = 4 * 1024 * 1024;

export interface SketchSpec {
    spec: GeometrySpec;
    sam: SamResult;
}

interface SamPayload {
    mask?: number[];
    width?: number;
    height?: number;
    iou?: number;
    confidence?: number;
    bbox?: { x0: number; y0: number; x1: number; y1: number };
}

function finite01(v: unknown, fallback: number): number {
    return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : fallback;
}

function validDims(w: unknown, h: unknown): w is number {
    void h;
    return Number.isInteger(w) && (w as number) >= 4 && (w as number) <= SAM_MAX_DIM;
}

function validBbox(bbox: unknown): bbox is { x0: number; y0: number; x1: number; y1: number } {
    if (typeof bbox !== "object" || bbox === null) return false;
    const b = bbox as Record<string, unknown>;
    for (const k of ["x0", "y0", "x1", "y1"] as const) {
        if (typeof b[k] !== "number" || !Number.isFinite(b[k] as number)) return false;
    }
    return (b.x1 as number) > (b.x0 as number) && (b.y1 as number) > (b.y0 as number);
}

function fallbackResult(w: number, h: number, bbox: SamPayload["bbox"], iou: number, confidence: number): SketchSpec {
    const safeW = Number.isInteger(w) && w >= 4 && w <= SAM_MAX_DIM ? w : 256;
    const safeH = Number.isInteger(h) && h >= 4 && h <= SAM_MAX_DIM ? h : 256;
    const safeBbox = validBbox(bbox) ? bbox : undefined;
    const polygon = bboxFallbackPolygon(safeW, safeH, safeBbox);
    validateSamPolygon(polygon);
    return {
        spec: { kind: "custom", chord: 1, alphaDeg: 4, nPoints: polygon.length, polygon },
        sam: { polygon, maskIou: finite01(iou, 0), usedFallback: true, confidence: finite01(confidence, 0.2) },
    };
}

export async function sketchToSpec(client: MetaClient, cache: HashCache, file: Blob): Promise<SketchSpec> {
    if (file.size > SAM_MAX_SKETCH_BYTES) {
        throw new Error(`sketchToSpec: sketch is ${(file.size / 1048576).toFixed(1)} MiB, cap is 5 MiB`);
    }
    if (file.type !== "" && !(SAM_ALLOWED_MIME as readonly string[]).includes(file.type)) {
        throw new Error(`sketchToSpec: sketch MIME ${file.type} is not PNG or JPEG`);
    }
    const bytes = await file.arrayBuffer();
    if (bytes.byteLength === 0 || bytes.byteLength > SAM_MAX_SKETCH_BYTES) {
        throw new Error(`sketchToSpec: sketch bytes ${bytes.byteLength} exceed the 5 MiB cap`);
    }
    const key = `sam:${await hashBytes(new Uint8Array(bytes))}`;
    const hit = cache.get<SketchSpec>(key, { allowStale: true });
    if (hit !== null && !hit.stale) {
        client.reportCacheHit("sam", META_DEFAULT_SAM_MODEL, key);
        return hit.value;
    }
    let payload: SamPayload | null = null;
    try {
        const raw = await client.segment(bytes.slice(0));
        payload = raw as SamPayload;
    } catch {
        payload = null;
    }
    const w = payload?.width;
    const h = payload?.height;
    if (
        payload?.mask !== undefined &&
        validDims(w, h) &&
        validDims(h, w) &&
        Array.isArray(payload.mask) &&
        payload.mask.length <= SAM_MAX_MASK_CELLS &&
        payload.mask.length === (w as number) * (h as number)
    ) {
        try {
            const mask = Uint8Array.from(payload.mask);
            const polygon = maskToPolygon(mask, w as number, h as number);
            validateSamPolygon(polygon);
            const result: SketchSpec = {
                spec: { kind: "custom", chord: 1, alphaDeg: 4, nPoints: polygon.length, polygon },
                sam: {
                    polygon,
                    maskIou: finite01(payload.iou, 0.9),
                    usedFallback: false,
                    confidence: finite01(payload.confidence, 0.8),
                },
            };
            cache.set(key, result, TTL_SAM_MS);
            return result;
        } catch {
            // Fall through to the bbox fallback below, which is not cached.
        }
    }
    return fallbackResult(
        typeof w === "number" ? w : 256,
        typeof h === "number" ? h : 256,
        payload?.bbox,
        payload?.iou ?? 0,
        payload?.confidence ?? 0.2
    );
}
