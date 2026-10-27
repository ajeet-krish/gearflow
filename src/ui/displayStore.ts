// Display preferences store. Persisted to localStorage, version guarded,
// try/catch throughout so private mode never throws. Dark theme default.

import { useCallback, useState } from "react";
import { DEFAULT_DISPLAY_PREFS, type DisplayPrefs } from "@/contracts/types";
import type { ColormapName } from "@/flow/colormap";
import type { FieldMode } from "@/contracts/types";

export const DISPLAY_STORAGE_KEY = "gearflow:display:v1";
export const DISPLAY_VERSION = 1;

const COLORMAPS: ColormapName[] = [
    "viridis", "turbo", "plasma", "inferno", "magma", "cividis", "jet", "rdbu", "coolwarm", "grayscale",
];
const VARIABLES: FieldMode[] = ["speed", "cp", "omega", "u", "v"];

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
    return { colormap, variable, theme, showLegend };
}

/** Load persisted display prefs, defaulting to viridis, speed, dark, legend on. */
export function loadDisplayPrefs(): DisplayPrefs {
    try {
        if (typeof localStorage === "undefined") return { ...DEFAULT_DISPLAY_PREFS };
        const raw = localStorage.getItem(DISPLAY_STORAGE_KEY);
        if (raw === null) return { ...DEFAULT_DISPLAY_PREFS };
        const parsed = JSON.parse(raw) as { version?: unknown; prefs?: unknown };
        if (parsed.version !== DISPLAY_VERSION) return { ...DEFAULT_DISPLAY_PREFS };
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
