// Phase 6 overhaul pinning: colormap catalog, variable ranges, display
// prefs, theme default, shader material shape, WASM idle, offline chat.

import { describe, expect, it, beforeEach } from "vitest";
import {
    sampleColormap,
    buildLut,
    COLORMAPS,
    isDiverging,
    variableRange,
    readQuantity,
} from "@/flow/colormap";
import { loadDisplayPrefs, storeDisplayPrefs } from "@/ui/displayStore";
import { loadTheme, applyTheme } from "@/ui/theme";
import {
    FIELD_VERTEX_SHADER,
    FIELD_FRAGMENT_SHADER,
    createFieldShaderMaterial,
} from "@/render/fieldShader";
import { maybeLoadWasm } from "@/flow/wasmSpike";
import { chatReply } from "@/meta/sparkChat";
import { MetaClient } from "@/meta/client";
import { HashCache } from "@/meta/cache";
import { GRID_64, GRID_128, GRID_256, GRID_OPTIONS, DEFAULT_DISPLAY_PREFS } from "@/contracts/types";
import type { FlowField } from "@/contracts/types";

function makeFlow(): FlowField {
    const nx = 4;
    const ny = 4;
    const n = nx * ny;
    const u = new Float32Array(n);
    const v = new Float32Array(n);
    const p = new Float32Array(n);
    const omega = new Float32Array(n);
    const obstacle = new Float32Array(n);
    for (let k = 0; k < n; k++) {
        u[k] = (k % nx) - 1.5;
        v[k] = Math.floor(k / nx) - 1.5;
        p[k] = -k * 0.01;
        omega[k] = k * 0.02 - 0.1;
    }
    return { nx, ny, domain: { xMin: -0.5, xMax: 2, yMin: -1, yMax: 1 }, u, v, p, omega, obstacle };
}

describe("phase6 colormaps", () => {
    it("samples every catalog entry across the full range", () => {
        expect(COLORMAPS.length).toBeGreaterThanOrEqual(9);
        for (const meta of COLORMAPS) {
            const [r, g, b] = sampleColormap(meta.name, 0.5);
            expect(r).toBeGreaterThanOrEqual(0);
            expect(r).toBeLessThanOrEqual(255);
            expect(g).toBeGreaterThanOrEqual(0);
            expect(g).toBeLessThanOrEqual(255);
            expect(b).toBeGreaterThanOrEqual(0);
            expect(b).toBeLessThanOrEqual(255);
            expect(buildLut(meta.name, 16).length).toBe(48);
        }
    });

    it("flags diverging maps for signed fields only", () => {
        expect(isDiverging("rdbu")).toBe(true);
        expect(isDiverging("coolwarm")).toBe(true);
        expect(isDiverging("viridis")).toBe(false);
        expect(isDiverging("turbo")).toBe(false);
        expect(isDiverging("cividis")).toBe(false);
    });

    it("reports honest ranges with labels and units", () => {
        const flow = makeFlow();
        const speed = variableRange("speed", flow);
        expect(speed.max).toBeGreaterThan(speed.min);
        expect(speed.label.length).toBeGreaterThan(0);
        expect(speed.units.length).toBeGreaterThan(0);
        const u = variableRange("u", flow);
        expect(u.min).toBeCloseTo(-1.5, 6);
        expect(u.max).toBeCloseTo(1.5, 6);
        expect(readQuantity("cp", flow, 3)).toBeCloseTo(flow.p[3], 9);
        expect(readQuantity("omega", flow, 3)).toBeCloseTo(flow.omega[3], 9);
    });

    it("pins grid constants for the resolution controller", () => {
        expect(GRID_64).toBe(64);
        expect(GRID_128).toBe(128);
        expect(GRID_256).toBe(256);
        expect(GRID_OPTIONS).toEqual([64, 128, 256]);
    });
});

describe("phase6 display prefs and theme", () => {
    beforeEach(() => {
        const store = new Map<string, string>();
        (globalThis as Record<string, unknown>).localStorage = {
            getItem: (k: string): string | null => (store.has(k) ? (store.get(k) as string) : null),
            setItem: (k: string, v: string): void => {
                store.set(k, String(v));
            },
            removeItem: (k: string): void => {
                store.delete(k);
            },
            clear: (): void => {
                store.clear();
            },
            key: (i: number): string | null => [...store.keys()][i] ?? null,
            get length(): number {
                return store.size;
            },
        };
    });

    it("defaults to viridis, speed, dark, legend on", () => {
        expect(DEFAULT_DISPLAY_PREFS).toEqual({ colormap: "viridis", variable: "speed", theme: "dark", showLegend: true, fieldVisible: true, contours: false, particleCount: 3000, particleColor: "auto", showStreamlines: false, meanFields: false });
        expect(loadDisplayPrefs()).toEqual(DEFAULT_DISPLAY_PREFS);
    });

    it("round trips prefs and sanitizes bad values", () => {
        storeDisplayPrefs({ ...DEFAULT_DISPLAY_PREFS, colormap: "turbo", variable: "cp", theme: "light", showLegend: false });
        expect(loadDisplayPrefs().colormap).toBe("turbo");
        localStorage.setItem("gearflow:display:v1", JSON.stringify({ version: 1, prefs: { colormap: "nope", variable: "nope", theme: "nope" } }));
        const prefs = loadDisplayPrefs();
        expect(prefs.colormap).toBe("viridis");
        expect(prefs.variable).toBe("speed");
        expect(prefs.theme).toBe("dark");
    });

    it("loads dark by default and applies without a DOM", () => {
        expect(loadTheme()).toBe("dark");
        expect(() => applyTheme("dark")).not.toThrow();
        expect(() => applyTheme("light")).not.toThrow();
    });
});

describe("phase6 shader path", () => {
    it("exposes UV pass through vertex and packed field fragment shaders", () => {
        expect(FIELD_VERTEX_SHADER).toContain("vUv");
        expect(FIELD_FRAGMENT_SHADER).toContain("tField");
        expect(FIELD_FRAGMENT_SHADER).toContain("tLut");
        expect(FIELD_FRAGMENT_SHADER).toContain("vMin");
        expect(FIELD_FRAGMENT_SHADER).toContain("vMax");
    });

    it("builds a shader material with the expected uniforms", async () => {
        const THREE = await import("three");
        const field = new THREE.DataTexture(new Uint8Array(4 * 4 * 4), 4, 4, THREE.RGBAFormat);
        const lut = new THREE.DataTexture(new Uint8Array(256 * 4), 256, 1, THREE.RGBAFormat);
        const mat = createFieldShaderMaterial({ field, lut, vMin: 0, vMax: 1 });
        expect(mat.uniforms.tField.value).toBe(field);
        expect(mat.uniforms.tLut.value).toBe(lut);
        expect(mat.uniforms.vMin.value).toBe(0);
        expect(mat.uniforms.vMax.value).toBe(1);
        mat.dispose();
        field.dispose();
        lut.dispose();
    });
});

describe("phase6 wasm spike and offline chat", () => {
    it("stays idle without the query flag and never serves frames", async () => {
        const result = await maybeLoadWasm();
        expect(result.loaded).toBe(false);
        expect(result.ms).toBe(0);
    });

    it("answers offline chat with a template and no network", async () => {
        const client = new MetaClient({ offline: true });
        const cache = new HashCache(false);
        const reply = await chatReply(client, cache, ["user: explain this run"], {
            spec: {
                geometry: { kind: "naca4", naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 }, chord: 1, alphaDeg: 6, nPoints: 100 },
                reynolds: 50000,
                rationale: "Test run.",
            },
            cl: 0.8,
            cpMin: -1.2,
        });
        expect(reply.reply.length).toBeGreaterThan(0);
        expect(reply.cached).toBe(false);
    });
});
