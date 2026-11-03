// Particle color options for the tunnel canvas. Every mode paints a
// fixed color; white is the default. Legacy stored "auto" values sanitize
// to white through the display store.

import type { ParticleColorMode } from "@/contracts/types";

export interface ParticleColorOption {
    id: ParticleColorMode;
    label: string;
    hex: string;
}

export const PARTICLE_COLOR_OPTIONS: ParticleColorOption[] = [
    { id: "white", label: "White", hex: "#ffffff" },
    { id: "black", label: "Black", hex: "#000000" },
    { id: "cyan", label: "Cyan", hex: "#8be9fd" },
    { id: "magenta", label: "Magenta", hex: "#ff79c6" },
    { id: "orange", label: "Orange", hex: "#ffb86c" },
];

function hexToTriple(hex: string): [number, number, number] {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    return [r, g, b];
}

// Precomputed per mode triples, frozen so the hot loop shares one object.
function frozen(triple: [number, number, number]): [number, number, number] {
    return Object.freeze(triple) as [number, number, number];
}
const RGB_BY_MODE: Record<ParticleColorMode, [number, number, number]> = {
    white: frozen(hexToTriple("#ffffff")),
    black: frozen(hexToTriple("#000000")),
    cyan: frozen(hexToTriple("#8be9fd")),
    magenta: frozen(hexToTriple("#ff79c6")),
    orange: frozen(hexToTriple("#ffb86c")),
};
Object.freeze(RGB_BY_MODE);

/** Resolve a fixed particle color to a normalized RGB triple. Unknown or
 *  legacy modes fall back to white. Never throws. */
export function particleRgb(mode: ParticleColorMode): [number, number, number] {
    return RGB_BY_MODE[mode] ?? RGB_BY_MODE.white;
}
