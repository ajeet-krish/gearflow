// BODY preset mapping for the solver bar select. Pure functions so the
// mapping is testable outside React. Mirrors the object rules used by
// FlowControls.setKind: NACA presets set exact m, p, t triples, other
// kinds keep existing size and center when present.

import type { GeometrySpec } from "@/contracts/types";
import {
    ORIFICE_GAP_DEFAULT,
    ORIFICE_GAP_MAX,
    ORIFICE_GAP_MIN,
    ORIFICE_THICKNESS_DEFAULT,
    ORIFICE_THICKNESS_MAX,
    ORIFICE_THICKNESS_MIN,
} from "@/contracts/types";
import { EXTENT_MAX } from "@/contracts/schema";
import { migrateDuctToOrifice } from "@/geometry/parametric";

/** Token shown by the BODY select for a spec. Unknown NACA codes fall back to the 2412 slot. */
export function bodySelectValue(spec: GeometrySpec): string {
    if (spec.kind === "naca4") {
        const code = spec.naca?.code;
        if (code === "0012" || code === "2412" || code === "4412") {
            return `naca${code}`;
        }
        return "naca2412";
    }
    return spec.kind;
}

/** Block dims keep any schema valid extent, out of envelope values reset. */
const BLOCK_EXTENT_MIN = 0.1;

/** Orifice plate thickness keeps the thickness envelope, else the default. */
function clampOrificeThickness(v: unknown): number {
    if (typeof v !== "number" || !Number.isFinite(v)) return ORIFICE_THICKNESS_DEFAULT;
    if (v < ORIFICE_THICKNESS_MIN || v > ORIFICE_THICKNESS_MAX) return ORIFICE_THICKNESS_DEFAULT;
    return v;
}

/** Orifice gap keeps the gap envelope, else the default. */
function clampOrificeGap(v: unknown): number {
    if (typeof v !== "number" || !Number.isFinite(v)) return ORIFICE_GAP_DEFAULT;
    if (v < ORIFICE_GAP_MIN || v > ORIFICE_GAP_MAX) return ORIFICE_GAP_DEFAULT;
    return v;
}

/** Block extents keep any finite positive value within the schema cap, else the fallback. */
function keepBlockExtent(v: unknown, fallback: number): number {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > EXTENT_MAX) return fallback;
    if (v < BLOCK_EXTENT_MIN) return BLOCK_EXTENT_MIN;
    return v;
}
/** Return the next spec for a BODY select token. Unknown tokens return the same object.
 *  Width and height reset per target kind: orifice clamps to its thickness
 *  and gap envelopes, block keeps schema valid extents. A block to orifice
 *  hop therefore never carries a 0.5 plate thickness into buildPolygons. */
export function applyBodyPreset(spec: GeometrySpec, value: string): GeometrySpec {
    if (value === "naca0012") {
        return { ...spec, kind: "naca4", naca: { code: "0012", m: 0, p: 0.4, t: 0.12 } };
    }
    if (value === "naca2412") {
        return { ...spec, kind: "naca4", naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 } };
    }
    if (value === "naca4412") {
        return { ...spec, kind: "naca4", naca: { code: "4412", m: 0.04, p: 0.4, t: 0.12 } };
    }
    if (value === "cylinder") {
        return { ...spec, kind: "cylinder", radius: spec.radius ?? 0.25, center: spec.center ?? { x: 0.5, y: 0 } };
    }
    if (value === "orifice" || value === "block") {
        if (value === "orifice") {
            return {
                ...spec,
                kind: value,
                center: spec.center ?? { x: 0.5, y: 0 },
                width: clampOrificeThickness(spec.width),
                height: clampOrificeGap(spec.height),
            };
        }
        return {
            ...spec,
            kind: value,
            center: spec.center ?? { x: 0.5, y: 0 },
            width: keepBlockExtent(spec.width, 0.5),
            height: keepBlockExtent(spec.height, 0.5),
        };
    }
    if (value === "duct") {
        return migrateDuctToOrifice({ ...spec, kind: value as unknown as GeometrySpec["kind"] });
    }
    return spec;
}
