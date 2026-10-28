// Display preferences store. Persisted to localStorage, version guarded,
// try/catch throughout so private mode never throws. Dark theme default.

import { useCallback, useState } from "react";
import { DEFAULT_DISPLAY_PREFS, PARTICLE_SIZE_DEFAULT, PARTICLE_SIZE_MAX, PARTICLE_SIZE_MIN, type DisplayPrefs, type ParticleColorMode } from "@/contracts/types";
import type { ColormapName } from "@/flow/colormap";
import type { FieldMode } from "@/contracts/types";

// Renaming this key would orphan deployed payloads, so the v1 string stays
// even though DISPLAY_VERSION is now 4.
export const DISPLAY_STORAGE_KEY = "gearflow:display:v1";
export const DISPLAY_VERSION = 4;

const COLORMAPS: ColormapName[] = [
    "viridis", "turbo", "plasma", "inferno", "magma", "cividis", "jet", "rdbu", "coolwarm", "grayscale",
];
const VARIABLES: FieldMode[] = ["speed", "cp", "omega", "u", "v", "k", "recirc"];
const PARTICLE_COUNTS = [0, 1200, 2000, 3000];
const PARTICLE_COLORS: ParticleColorMode[] = ["auto", "white", "black", "cyan", "magenta", "orange"];

function sanitize(raw: unknown): DisplayPrefs {
    const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const colormap: DisplayPrefs["colormap"] = COLORMAPS.includes(r.colormap as ColormapName)
        ? (r.colormap as ColormapName)
        : DEFAULT_DISPLAY_PREFS.colormap;
    const variable: FieldMode = VARIABLES.includes(r.variable as FieldMode)
        ? (r.variable as FieldMode)
        : DEFAULT_DISPLAY_PREFS.variable;
    const theme: DisplayPrefs["theme"] = r.theme === "light" || r.theme === "dark" ? r.theme : "dark";
    const showLegend = typeof r.showLegend === "boolean" ? r.showLegend : true;
    const fieldVisible = typeof r.fieldVisible === "boolean" ? r.fieldVisible : DEFAULT_DISPLAY_PREFS.fieldVisible;
    const contours = typeof r.contours === "boolean" ? r.contours : DEFAULT_DISPLAY_PREFS.contours;
    const showStreamlines = typeof r.showStreamlines === "boolean" ? r.showStreamlines : DEFAULT_DISPLAY_PREFS.showStreamlines;
    const meanFields = typeof r.meanFields === "boolean" ? r.meanFields : DEFAULT_DISPLAY_PREFS.meanFields;
    const particleCount = typeof r.particleCount === "number" && PARTICLE_COUNTS.includes(r.particleCount)
        ? r.particleCount
        : DEFAULT_DISPLAY_PREFS.particleCount;
    const particleColor: ParticleColorMode = typeof r.particleColor === "string" && (PARTICLE_COLORS as string[]).includes(r.particleColor)
        ? (r.particleColor as ParticleColorMode)
        : DEFAULT_DISPLAY_PREFS.particleColor;
    const particleSizeRaw = r.particleSize;
    const particleSize = typeof particleSizeRaw === "number" && Number.isFinite(particleSizeRaw)
        ? Math.min(PARTICLE_SIZE_MAX, Math.max(PARTICLE_SIZE_MIN, particleSizeRaw))
        : PARTICLE_SIZE_DEFAULT;
    const overlayPinned = typeof r.overlayPinned === "boolean" ? r.overlayPinned : DEFAULT_DISPLAY_PREFS.overlayPinned;
    const overlayPinnedField: DisplayPrefs["overlayPinnedField"] =
        r.overlayPinnedField === null || r.overlayPinnedField === undefined
            ? null
            : VARIABLES.includes(r.overlayPinnedField as FieldMode)
                ? (r.overlayPinnedField as FieldMode)
                : null;
    return { colormap, variable, theme, showLegend, fieldVisible, contours, particleCount, particleColor, showStreamlines, meanFields, particleSize, overlayPinned, overlayPinnedField };
}

/** Load persisted display prefs, defaulting to viridis, speed, dark, legend on. */
export function loadDisplayPrefs(): DisplayPrefs {
    try {
        if (typeof localStorage === "undefined") return { ...DEFAULT_DISPLAY_PREFS };
        const raw = localStorage.getItem(DISPLAY_STORAGE_KEY);
        if (raw === null) return { ...DEFAULT_DISPLAY_PREFS };
        const parsed = JSON.parse(raw) as { version?: unknown; prefs?: unknown };
        if (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== 3 && parsed.version !== 4) return { ...DEFAULT_DISPLAY_PREFS };
        return sanitize(parsed.prefs);
    } catch {
        return { ...DEFAULT_DISPLAY_PREFS };
    }
}

/** Persist display prefs. Never throws. */
export function storeDisplayPrefs(prefs: DisplayPrefs): void {
    try {
        if (typeof localStorage === "undefined") return;
        localStorage.setItem(DISPLAY_STORAGE_KEY, JSON.stringify({ version: DISPLAY_VERSION, prefs }));
    } catch {
        // Quota or private mode: prefs still apply to this session.
    }
}

/** React binding for display prefs with persistence. */
export function useDisplayPrefs() {
    const [prefs, setPrefs] = useState<DisplayPrefs>(() => loadDisplayPrefs());
    const patch = useCallback((next: Partial<DisplayPrefs>): void => {
        setPrefs((prev) => {
            const merged = sanitize({ ...prev, ...next });
            storeDisplayPrefs(merged);
            return merged;
        });
    }, []);
    const reset = useCallback((): void => {
        setPrefs({ ...DEFAULT_DISPLAY_PREFS });
        storeDisplayPrefs({ ...DEFAULT_DISPLAY_PREFS });
    }, []);
    return { prefs, patch, reset };
}
