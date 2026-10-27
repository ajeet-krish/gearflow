// Theme loader. Dark theme default per booth decision; light is available
// via the data-theme attribute on the document root.

import type { DisplayPrefs } from "@/contracts/types";
import { loadDisplayPrefs, storeDisplayPrefs } from "./displayStore";

export type ThemeName = DisplayPrefs["theme"];

export const THEME_KEY = "gearflow:display:v1";

/** Load the active theme, defaulting to dark. Never throws. */
export function loadTheme(): ThemeName {
    try {
        return loadDisplayPrefs().theme;
    } catch {
        return "dark";
    }
}

/** Persist the theme and apply it to the document root. Never throws. */
export function storeTheme(theme: ThemeName): void {
    try {
        const prefs = loadDisplayPrefs();
        storeDisplayPrefs({ ...prefs, theme });
    } catch {
        // Private mode: theme still applies to this session via applyTheme.
    }
    applyTheme(theme);
}

/** Set data-theme on the root element. No-op without a DOM. */
export function applyTheme(theme: ThemeName): void {
    try {
        if (typeof document === "undefined") return;
        document.documentElement.setAttribute("data-theme", theme);
    } catch {
        // Non-DOM test env: theme string still round trips via storage.
    }
}

export { THEME_KEY as DISPLAY_THEME_KEY };
