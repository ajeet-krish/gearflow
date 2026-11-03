// Theme loader. Dark only: the instrument skin is fixed, no switch.
// Kept as a thin shim so existing imports keep working; every call
// applies dark and every load returns dark regardless of stored payload.

import type { DisplayPrefs } from "@/contracts/types";
import { loadDisplayPrefs, storeDisplayPrefs } from "./displayStore";

export type ThemeName = DisplayPrefs["theme"];

export const THEME_KEY = "gearflow:display:v1";

/** Load the active theme, always dark. Never throws. */
export function loadTheme(): ThemeName {
    try {
        void loadDisplayPrefs();
        return "dark";
    } catch {
        return "dark";
    }
}

/** Persist prefs with theme forced to dark, then apply dark. Never throws. */
export function storeTheme(_theme: ThemeName): void {
    try {
        const prefs = loadDisplayPrefs();
        storeDisplayPrefs({ ...prefs, theme: "dark" });
    } catch {
        // Private mode: theme still applies to this session via applyTheme.
    }
    applyTheme("dark");
}

/** Set data-theme dark on the root element. No-op without a DOM. */
export function applyTheme(_theme: ThemeName): void {
    try {
        if (typeof document === "undefined") return;
        document.documentElement.setAttribute("data-theme", "dark");
    } catch {
        // Non-DOM test env: nothing to apply.
    }
}

export { THEME_KEY as DISPLAY_THEME_KEY };
