// Preset design points. Style inspired airfoil proxies, not car models.
// No logos, no brand marks. Each preset maps to a ParametricSpec directly
// with no network call.

import type { ParametricSpec } from "@/contracts/types";

export interface Preset {
    id: string;
    label: string;
    note: string;
    spec: ParametricSpec;
}

export const PRESETS: Preset[] = [
    {
        id: "monaco-style",
        label: "Monaco style high downforce proxy",
        note: "Style inspired airfoil proxy, not a car model. High camber, high alpha.",
        spec: {
            geometry: {
                kind: "naca4",
                naca: { code: "6415", m: 0.06, p: 0.4, t: 0.15 },
                chord: 1,
                alphaDeg: 10,
                nPoints: 120,
            },
            reynolds: 200000,
            rationale: "High downforce style proxy with strong camber for slow corner study.",
        },
    },
    {
        id: "monza-style",
        label: "Monza style low drag proxy",
        note: "Style inspired airfoil proxy, not a car model. Thin section, low alpha.",
        spec: {
            geometry: {
                kind: "naca4",
                naca: { code: "1408", m: 0.01, p: 0.4, t: 0.08 },
                chord: 1,
                alphaDeg: 3,
                nPoints: 120,
            },
            reynolds: 500000,
            rationale: "Low drag style proxy with a thin section for straight line study.",
        },
    },
];
