// Colormaps for GearFlow. Viridis is default. Jet for velocity, diverging
// maps for signed fields. Phase 6 adds turbo, plasma, inferno, magma, and
// cividis plus metadata, divergence flags, and per variable range helpers.

import type { FieldMode, FlowField } from "@/contracts/types";

export type RGB = [number, number, number];
export type ColormapName =
    | "viridis"
    | "jet"
    | "rdbu"
    | "coolwarm"
    | "turbo"
    | "plasma"
    | "inferno"
    | "magma"
    | "cividis"
    | "grayscale";

/** Viridis approx via sampled stops. t in [0,1]. */
export function viridisColormap(t: number): RGB {
    const tt = Math.max(0, Math.min(1, t));
    const stops: RGB[] = [
        [68, 1, 84],
        [59, 82, 139],
        [33, 145, 140],
        [94, 201, 98],
        [253, 231, 37],
    ];
    const pos = tt * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(pos));
    const f = pos - i;
    const a = stops[i];
    const b = stops[i + 1];
    return [
        Math.round(a[0] + (b[0] - a[0]) * f),
        Math.round(a[1] + (b[1] - a[1]) * f),
        Math.round(a[2] + (b[2] - a[2]) * f),
    ];
}

export function jetColormap(t: number): RGB {
    const tt = Math.max(0, Math.min(1, t));
    let r: number, g: number, b: number;
    if (tt < 0.125) { r = 0; g = 0; b = 0.5 + tt * 4; }
    else if (tt < 0.375) { r = 0; g = (tt - 0.125) * 4; b = 1; }
    else if (tt < 0.625) { r = (tt - 0.375) * 4; g = 1; b = 1 - (tt - 0.375) * 4; }
    else if (tt < 0.875) { r = 1; g = 1 - (tt - 0.625) * 4; b = 0; }
    else { r = 1 - (tt - 0.875) * 4; g = 0; b = 0; }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

export function rdbuColormap(t: number): RGB {
    const tt = Math.max(0, Math.min(1, t));
    let r: number, g: number, b: number;
    if (tt < 0.5) {
        const s = tt / 0.5;
        r = 0.3 + s * 0.7; g = 0.3 + s * 0.7; b = 1;
    } else {
        const s = (tt - 0.5) / 0.5;
        r = 1; g = 1 - s * 0.7; b = 1 - s * 0.7;
    }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

export function coolwarmColormap(t: number): RGB {
    const tt = Math.max(0, Math.min(1, t));
    const r = Math.round(59 + tt * (180 - 59));
    const g = Math.round(76 + Math.sin(tt * Math.PI) * 120);
    const b = Math.round(192 - tt * (192 - 110));
    return [r, Math.max(0, Math.min(255, g)), b];
}

/** Sampled stop helper shared by the perceptually uniform maps. */
function stopsColormap(t: number, stops: RGB[]): RGB {
    const tt = Math.max(0, Math.min(1, t));
    const pos = tt * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(pos));
    const f = pos - i;
    const a = stops[i];
    const b = stops[i + 1];
    return [
        Math.round(a[0] + (b[0] - a[0]) * f),
        Math.round(a[1] + (b[1] - a[1]) * f),
        Math.round(a[2] + (b[2] - a[2]) * f),
    ];
}

const TURBO_STOPS: RGB[] = [
    [48, 18, 59], [70, 107, 227], [55, 185, 197], [141, 214, 72], [253, 231, 37], [251, 165, 19], [214, 69, 15], [122, 4, 3],
];

const PLASMA_STOPS: RGB[] = [
    [13, 8, 135], [75, 3, 161], [125, 3, 168], [168, 34, 150], [203, 70, 121], [229, 107, 93], [248, 148, 65], [240, 249, 33],
];

const INFERNO_STOPS: RGB[] = [
    [0, 0, 4], [40, 11, 84], [101, 21, 110], [159, 42, 99], [212, 72, 66], [245, 125, 21], [250, 193, 39], [252, 255, 164],
];

const MAGMA_STOPS: RGB[] = [
    [0, 0, 4], [28, 16, 68], [79, 18, 123], [129, 37, 129], [181, 54, 122], [229, 80, 100], [251, 135, 97], [252, 253, 191],
];

const CIVIDIS_STOPS: RGB[] = [
    [0, 32, 76], [0, 56, 91], [51, 85, 105], [93, 113, 114], [128, 142, 123], [165, 172, 132], [206, 203, 150], [253, 234, 169],
];

export function turboColormap(t: number): RGB {
    return stopsColormap(t, TURBO_STOPS);
}

export function plasmaColormap(t: number): RGB {
    return stopsColormap(t, PLASMA_STOPS);
}

export function infernoColormap(t: number): RGB {
    return stopsColormap(t, INFERNO_STOPS);
}

export function magmaColormap(t: number): RGB {
    return stopsColormap(t, MAGMA_STOPS);
}

export function cividisColormap(t: number): RGB {
    return stopsColormap(t, CIVIDIS_STOPS);
}

/** Plain luminance ramp for print safe figures. */
export function grayscaleColormap(t: number): RGB {
    const v = Math.round(Math.max(0, Math.min(1, t)) * 255);
    return [v, v, v];
}

export function sampleColormap(name: ColormapName, t: number): RGB {
    switch (name) {
        case "jet": return jetColormap(t);
        case "rdbu": return rdbuColormap(t);
        case "coolwarm": return coolwarmColormap(t);
        case "turbo": return turboColormap(t);
        case "plasma": return plasmaColormap(t);
        case "inferno": return infernoColormap(t);
        case "magma": return magmaColormap(t);
        case "cividis": return cividisColormap(t);
        case "grayscale": return grayscaleColormap(t);
        case "viridis":
        default: return viridisColormap(t);
    }
}

/** Build a 256 entry LUT for fast texture or particle coloring. */
export function buildLut(name: ColormapName, size = 256): Uint8Array {
    const lut = new Uint8Array(size * 3);
    for (let i = 0; i < size; i++) {
        const [r, g, b] = sampleColormap(name, i / (size - 1));
        lut[i * 3] = r;
        lut[i * 3 + 1] = g;
        lut[i * 3 + 2] = b;
    }
    return lut;
}

export interface ColormapMeta {
    name: ColormapName;
    label: string;
    diverging: boolean;
    colorblindNote: string;
}

export const COLORMAPS: ColormapMeta[] = [
    { name: "viridis", label: "Viridis", diverging: false, colorblindNote: "Perceptually uniform, colorblind safe." },
    { name: "turbo", label: "Turbo", diverging: false, colorblindNote: "High contrast rainbow, not colorblind safe." },
    { name: "plasma", label: "Plasma", diverging: false, colorblindNote: "Perceptually uniform, colorblind safe." },
    { name: "inferno", label: "Inferno", diverging: false, colorblindNote: "Perceptually uniform, colorblind safe." },
    { name: "magma", label: "Magma", diverging: false, colorblindNote: "Perceptually uniform, colorblind safe." },
    { name: "cividis", label: "Cividis", diverging: false, colorblindNote: "Optimized for color vision deficiency." },
    { name: "jet", label: "Jet", diverging: false, colorblindNote: "Legacy rainbow, not colorblind safe." },
    { name: "rdbu", label: "RdBu", diverging: true, colorblindNote: "Diverging, use for signed fields." },
    { name: "coolwarm", label: "Coolwarm", diverging: true, colorblindNote: "Diverging, use for signed fields." },
    { name: "grayscale", label: "Grayscale", diverging: false, colorblindNote: "Print safe luminance ramp." },
];

/** True for diverging maps suited to signed quantities (u, v, cp, omega). */
export function isDiverging(name: ColormapName): boolean {
    const meta = COLORMAPS.find((c) => c.name === name);
    return meta?.diverging === true;
}

export interface VariableRange {
    min: number;
    max: number;
    label: string;
    units: string;
}

/** Read one scalar quantity from a flow field at cell k. */
export function readQuantity(variable: FieldMode, flow: FlowField, k: number): number {
    switch (variable) {
        case "u": return flow.u[k];
        case "v": return flow.v[k];
        case "cp": return flow.p[k];
        case "omega": return flow.omega[k];
        case "speed":
        default: return Math.sqrt(flow.u[k] * flow.u[k] + flow.v[k] * flow.v[k]);
    }
}

const VARIABLE_LABELS: Record<FieldMode, { label: string; units: string }> = {
    speed: { label: "Speed", units: "U/Uinf" },
    cp: { label: "Cp", units: "coef" },
    omega: { label: "Vorticity", units: "1/s (nondim)" },
    u: { label: "u velocity", units: "U/Uinf" },
    v: { label: "v velocity", units: "U/Uinf" },
};

/** Data range of a field variable over the grid, with label and units. */
export function variableRange(variable: FieldMode, flow: FlowField): VariableRange {
    const n = flow.nx * flow.ny;
    let min = Infinity;
    let max = -Infinity;
    for (let k = 0; k < n; k++) {
        const q = readQuantity(variable, flow, k);
        if (!Number.isFinite(q)) continue;
        if (q < min) min = q;
        if (q > max) max = q;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
        min = 0;
        max = 1;
    }
    if (max - min < 1e-9) {
        max = min + 1e-9;
    }
    const { label, units } = VARIABLE_LABELS[variable];
    return { min, max, label, units };
}
