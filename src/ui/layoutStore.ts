// Layout store: collapsible shell prefs for the ParaView style workbench.
// Persisted to localStorage, version guarded, try/catch throughout so
// private mode never throws. Mirrors displayStore hardening line for line.

import { useCallback, useState } from "react";

export interface LayoutPrefs {
    leftCollapsed: boolean;
    rightCollapsed: boolean;
    barsCollapsed: boolean;
    focusMode: boolean;
}

export const DEFAULT_LAYOUT_PREFS: LayoutPrefs = {
    leftCollapsed: false,
    rightCollapsed: false,
    barsCollapsed: false,
    focusMode: false,
};

export const LAYOUT_STORAGE_KEY = "gearflow:layout:v1";
export const LAYOUT_VERSION = 1;

function asBool(value: unknown, fallback: boolean): boolean {
    return typeof value === "boolean" ? value : fallback;
}

function sanitize(raw: unknown): LayoutPrefs {
    const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    return {
        leftCollapsed: asBool(r.leftCollapsed, DEFAULT_LAYOUT_PREFS.leftCollapsed),
        rightCollapsed: asBool(r.rightCollapsed, DEFAULT_LAYOUT_PREFS.rightCollapsed),
        barsCollapsed: asBool(r.barsCollapsed, DEFAULT_LAYOUT_PREFS.barsCollapsed),
        focusMode: asBool(r.focusMode, DEFAULT_LAYOUT_PREFS.focusMode),
    };
}

/** Load persisted layout prefs, defaulting to everything expanded. */
export function loadLayoutPrefs(): LayoutPrefs {
    try {
        if (typeof localStorage === "undefined") return { ...DEFAULT_LAYOUT_PREFS };
        const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
        if (raw === null) return { ...DEFAULT_LAYOUT_PREFS };
        const parsed = JSON.parse(raw) as { version?: unknown; prefs?: unknown };
        if (parsed.version !== LAYOUT_VERSION) return { ...DEFAULT_LAYOUT_PREFS };
        return sanitize(parsed.prefs);
    } catch {
        return { ...DEFAULT_LAYOUT_PREFS };
    }
}

/** Persist layout prefs. Never throws. */
export function storeLayoutPrefs(prefs: LayoutPrefs): void {
    try {
        if (typeof localStorage === "undefined") return;
        localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({ version: LAYOUT_VERSION, prefs }));
    } catch {
        // Quota or private mode: prefs still apply to this session.
    }
}

/** Focus mode forces every region shut, so effective visibility is derived. */
export interface ShellVisibility {
    left: boolean;
    right: boolean;
    bars: boolean;
}

export function shellVisibility(prefs: LayoutPrefs): ShellVisibility {
    return {
        left: prefs.leftCollapsed || prefs.focusMode,
        right: prefs.rightCollapsed || prefs.focusMode,
        bars: prefs.barsCollapsed || prefs.focusMode,
    };
}

/** React binding for layout prefs with persistence. */
export function useLayoutPrefs() {
    const [prefs, setPrefs] = useState<LayoutPrefs>(() => loadLayoutPrefs());
    const patch = useCallback((next: Partial<LayoutPrefs>): void => {
        setPrefs((prev) => {
            const merged = sanitize({ ...prev, ...next });
            storeLayoutPrefs(merged);
            return merged;
        });
    }, []);
    const reset = useCallback((): void => {
        setPrefs({ ...DEFAULT_LAYOUT_PREFS });
        storeLayoutPrefs({ ...DEFAULT_LAYOUT_PREFS });
    }, []);
    return { prefs, patch, reset };
}
