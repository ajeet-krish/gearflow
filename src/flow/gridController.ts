// Resolution controller. Analytic solves default to 256x256; two consecutive
// solves slower than 800 ms at 256 drop to 128 with a notice. The mode is
// persisted to localStorage. Surrogate always stays at 128 and never goes
// through this controller. Phase B adds the 64 preset plus a custom square
// (32 to 512) parsed by parseCustomGrid.

import { useCallback, useRef, useState } from "react";
import { CUSTOM_GRID_MAX, CUSTOM_GRID_MIN, GRID_128, GRID_256, GRID_64, type GridSize } from "@/contracts/types";

export type GridMode = "auto" | "256" | "128" | "64" | "custom";

export const GRID_MODE_KEY = "gearflow:gridMode";
export const GRID_CUSTOM_KEY = "gearflow:gridCustom";
export const SLOW_SOLVE_MS = 800;
export const SLOW_STREAK_LIMIT = 2;

export interface ResolutionState {
    mode: GridMode;
    active: GridSize;
    customSize: number;
    slowStreak: number;
    autoDropped: boolean;
    notice: string | null;
}

function readMode(): GridMode {
    try {
        if (typeof localStorage === "undefined") return "auto";
        const raw = localStorage.getItem(GRID_MODE_KEY);
        if (raw === "256" || raw === "128" || raw === "64" || raw === "auto" || raw === "custom") return raw;
    } catch {
        // Private mode: fall through to auto.
    }
    return "auto";
}

function storeMode(mode: GridMode): void {
    try {
        if (typeof localStorage === "undefined") return;
        localStorage.setItem(GRID_MODE_KEY, mode);
    } catch {
        // Private mode: mode still applies to this session.
    }
}

function readCustomSize(): number {
    try {
        if (typeof localStorage === "undefined") return GRID_128;
        const raw = localStorage.getItem(GRID_CUSTOM_KEY);
        const parsed = parseCustomGrid(raw);
        if (parsed.ok) return parsed.size;
    } catch {
        // Private mode: fall through to the default.
    }
    return GRID_128;
}

function storeCustomSize(size: number): void {
    try {
        if (typeof localStorage === "undefined") return;
        localStorage.setItem(GRID_CUSTOM_KEY, String(size));
    } catch {
        // Private mode: size still applies to this session.
    }
}

export interface CustomGridParse {
    ok: boolean;
    size: number;
    reason: string | null;
}

/**
 * Parse a custom square grid side. Accepts numbers and numeric strings.
 * Must be an integer in [32, 512]. Never throws.
 */
export function parseCustomGrid(raw: unknown): CustomGridParse {
    const fail = (reason: string): CustomGridParse => ({ ok: false, size: GRID_128, reason });
    if (typeof raw === "string") {
        if (raw.trim().length === 0) {
            return fail(`custom grid needs a number in [${CUSTOM_GRID_MIN}, ${CUSTOM_GRID_MAX}], got empty input`);
        }
        const n = Number(raw.trim());
        return parseCustomGrid(n);
    }
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
        return fail(`custom grid needs a number in [${CUSTOM_GRID_MIN}, ${CUSTOM_GRID_MAX}], got non-numeric input`);
    }
    if (!Number.isInteger(raw)) {
        return fail(`custom grid must be an integer in [${CUSTOM_GRID_MIN}, ${CUSTOM_GRID_MAX}], got ${String(raw)}`);
    }
    if (raw < CUSTOM_GRID_MIN || raw > CUSTOM_GRID_MAX) {
        return fail(`custom grid must be in [${CUSTOM_GRID_MIN}, ${CUSTOM_GRID_MAX}], got ${raw}`);
    }
    return { ok: true, size: raw, reason: null };
}

function activeFor(mode: GridMode, customSize: number): GridSize {
    if (mode === "128") return GRID_128;
    if (mode === "64") return GRID_64;
    if (mode === "custom") return customSize;
    return GRID_256;
}

export function initialResolution(mode?: GridMode): ResolutionState {
    const m = mode ?? readMode();
    const customSize = readCustomSize();
    return {
        mode: m,
        active: m === "128" ? GRID_128 : m === "64" ? GRID_64 : m === "custom" ? customSize : GRID_256,
        customSize,
        slowStreak: 0,
        autoDropped: false,
        notice: null,
    };
}

/** Effective grid size for the next solve. */
export function resolveGridSize(state: ResolutionState): GridSize {
    return state.active;
}

/**
 * Record one solve duration. Returns the next state plus fellBack, which is
 * true only on the transition from 256 to 128. Only auto mode can fall back;
 * pinned modes keep their size and only track the streak.
 */
export function recordSolve(
    state: ResolutionState,
    fieldMs: number
): { state: ResolutionState; fellBack: boolean } {
    const ms = Number.isFinite(fieldMs) ? fieldMs : 0;
    if (state.active !== GRID_256) {
        return { state: { ...state, slowStreak: 0 }, fellBack: false };
    }
    if (ms <= SLOW_SOLVE_MS) {
        if (state.slowStreak === 0 && state.notice === null) return { state, fellBack: false };
        return { state: { ...state, slowStreak: 0 }, fellBack: false };
    }
    const streak = state.slowStreak + 1;
    if (streak >= SLOW_STREAK_LIMIT && state.mode === "auto") {
        return {
            state: {
                ...state,
                active: GRID_128,
                slowStreak: streak,
                autoDropped: true,
                notice: `Two consecutive solves over ${SLOW_SOLVE_MS} ms at 256, dropped to 128 automatically.`,
            },
            fellBack: true,
        };
    }
    return { state: { ...state, slowStreak: streak }, fellBack: false };
}

/** Pin a grid mode. Pinning 256 clears a prior auto drop. Custom pins the parsed size. */
export function setGridMode(state: ResolutionState, mode: GridMode, customRaw?: unknown): ResolutionState {
    storeMode(mode);
    if (mode === "128") {
        return { ...state, mode, active: GRID_128, notice: null };
    }
    if (mode === "64") {
        return { ...state, mode, active: GRID_64, notice: null };
    }
    if (mode === "custom") {
        const parsed = parseCustomGrid(customRaw ?? state.customSize);
        if (!parsed.ok) {
            return { ...state, mode, active: state.customSize, notice: parsed.reason };
        }
        storeCustomSize(parsed.size);
        return { ...state, mode, active: parsed.size, customSize: parsed.size, notice: null };
    }
    return { ...state, mode, active: GRID_256, slowStreak: 0, autoDropped: false, notice: null };
}

/** React binding for the resolution controller. */
export function useResolution() {
    const [state, setState] = useState<ResolutionState>(() => initialResolution());
    const stateRef = useRef<ResolutionState>(state);
    stateRef.current = state;
    const recordSolveMs = useCallback((fieldMs: number): boolean => {
        const next = recordSolve(stateRef.current, fieldMs);
        setState(next.state);
        return next.fellBack;
    }, []);
    const setMode = useCallback((mode: GridMode, customRaw?: unknown): void => {
        setState((prev) => setGridMode(prev, mode, customRaw));
    }, []);
    const clearNotice = useCallback((): void => {
        setState((prev) => (prev.notice === null ? prev : { ...prev, notice: null }));
    }, []);
    return { state, recordSolveMs, setMode, clearNotice };
}
