// BODY preset mapping for the solver bar select. Pure functions so the
// mapping is testable outside React. Mirrors the object rules used by
// FlowControls.setKind: NACA presets set exact m, p, t triples, other
// kinds keep existing size and center when present.

import type { GeometrySpec } from "@/contracts/types";

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

/** Return the next spec for a BODY select token. Unknown tokens return the same object. */
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
    if (value === "duct" || value === "block") {
        return {
            ...spec,
            kind: value,
            center: spec.center ?? { x: 0.5, y: 0 },
            width: spec.width ?? (value === "duct" ? 1.0 : 0.5),
            height: spec.height ?? (value === "duct" ? 0.4 : 0.5),
        };
    }
    return spec;
}
