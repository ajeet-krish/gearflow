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

/** Read one scalar quantity from a flow field at cell k. When meanFields is
 *  true and the flow carries a time mean channel, u and v resolve to the
 *  time mean instead of the instantaneous field. All other variables,
 *  including k and recirc, are unaffected by the flag. */
export function readQuantity(variable: FieldMode, flow: FlowField, k: number, meanFields = false): number {
    switch (variable) {
        case "u":
            if (meanFields && flow.uMean !== undefined && k >= 0 && k < flow.uMean.length) {
                const m = flow.uMean[k];
                return Number.isFinite(m) ? m : flow.u[k];
            }
            return flow.u[k];
        case "v":
            if (meanFields && flow.vMean !== undefined && k >= 0 && k < flow.vMean.length) {
                const m = flow.vMean[k];
                return Number.isFinite(m) ? m : flow.v[k];
            }
            return flow.v[k];
        case "cp": return flow.p[k];
        case "omega": return flow.omega[k];
        case "k": return flow.k !== undefined ? flow.k[k] : 0;
        case "recirc": return flow.recirc !== undefined ? flow.recirc[k] : 0;
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
    k: { label: "TKE", units: "Uinf2" },
    recirc: { label: "Recirculation", units: "mask" },
};

/** Data range of a field variable over the grid, with label and units.
 *  When meanFields is true and a time mean channel exists for u or v, the
 *  range covers the mean field and the label carries a mean suffix so the
 *  legend and colorbar can tell the two apart. */
export function variableRange(variable: FieldMode, flow: FlowField, meanFields = false): VariableRange {
    const n = flow.nx * flow.ny;
    let min = Infinity;
    let max = -Infinity;
    for (let k = 0; k < n; k++) {
        const q = readQuantity(variable, flow, k, meanFields);
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
    const useMean = meanFields && (variable === "u" || variable === "v")
        && ((variable === "u" ? flow.uMean : flow.vMean) !== undefined);
    return { min, max, label: useMean ? `${label} (mean)` : label, units };
}

/** Log scale descriptor for TKE. TKE spans decades, so the field maps
 *  log10(max(k, floor)) where floor is a small fraction of the field
 *  maximum, then normalises over the observed log range. Returns null
 *  when the field carries no usable positive value. */
export interface KLogScale {
    floor: number;
    max: number;
    logMin: number;
    logMax: number;
}

export function kLogScaleFor(flow: FlowField): KLogScale | null {
    const src = flow.k;
    if (src === undefined || src.length === 0) return null;
    let max = -Infinity;
    for (let k = 0; k < src.length; k++) {
        const v = src[k];
        if (!Number.isFinite(v)) continue;
        if (v > max) max = v;
    }
    if (!Number.isFinite(max) || max <= 0) return null;
    const floor = max * 1e-4;
    const logMax = Math.log10(max);
    let logMin = Infinity;
    for (let k = 0; k < src.length; k++) {
        const v = src[k];
        if (!Number.isFinite(v)) continue;
        const clamped = Math.max(v, floor);
        const lv = Math.log10(clamped);
        if (lv < logMin) logMin = lv;
    }
    if (!Number.isFinite(logMin)) return null;
    if (logMax - logMin < 1e-9) logMin = logMax - 1e-9;
    return { floor, max, logMin, logMax };
}

/** Normalise one TKE sample through a log scale into [0, 1]. Guards
 *  non-finite input by returning 0. */
export function normalizeKLogValue(q: number, scale: KLogScale): number {
    if (!Number.isFinite(q)) return 0;
    const span = scale.logMax - scale.logMin || 1;
    const lv = Math.log10(Math.max(q, scale.floor));
    const t = (lv - scale.logMin) / span;
    if (!(t >= 0)) return 0;
    if (t > 1) return 1;
    return t;
}

/** Map a recirculation mask sample to a display fraction. Values at or
 *  above 0.5 read as reverse flow (1), anything else as attached (0).
 *  Non-finite input reads as attached. */
export function normalizeRecircValue(q: number): number {
    if (!Number.isFinite(q)) return 0;
    return q >= 0.5 ? 1 : 0;
}

/** Label one TKE colorbar tick. An exact decade uses the compact 1eN
 *  form, anything else uses a two significant figure exponential so the
 *  label never claims a rounded decade the field does not show. The snap
 *  tolerance covers float32 channel rounding, which shifts an exact
 *  decade by a few parts in 1e8. */
export function formatKTick(v: number): string {
    if (!Number.isFinite(v) || v <= 0) return "0";
    const exp = Math.log10(v);
    const nearest = Math.round(exp);
    if (Math.abs(exp - nearest) < 1e-7) return `1e${nearest}`;
    const floored = Math.floor(exp);
    const mant = v / Math.pow(10, floored);
    return `${mant.toPrecision(2)}e${floored}`;
}

export interface KColorTick {
    value: number;
    label: string;
    position: number;
}

/** Endpoint accurate ticks for the TKE colorbar. The first tick is the
 *  scale maximum and the last is the scale minimum, each positioned with
 *  normalizeKLogValue exactly as the field maps them, with every interior
 *  decade boundary in between. */
export function kColorTicks(scale: KLogScale): KColorTick[] {
    const ticks: KColorTick[] = [];
    const push = (value: number): void => {
        ticks.push({ value, label: formatKTick(value), position: normalizeKLogValue(value, scale) });
    };
    push(Math.pow(10, scale.logMax));
    const lo = Math.ceil(scale.logMin + 1e-7);
    const hi = Math.floor(scale.logMax - 1e-7);
    for (let e = hi; e >= lo; e--) push(Math.pow(10, e));
    const minValue = Math.pow(10, scale.logMin);
    const last = ticks[ticks.length - 1];
    if (last === undefined || Math.abs(last.value - minValue) / Math.max(minValue, 1e-300) > 1e-9) {
        push(minValue);
    }
    return ticks;
}
