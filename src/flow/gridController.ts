// Resolution controller. Analytic solves default to 256x256; two consecutive
// solves slower than 800 ms at 256 drop to 128 with a notice. The mode is
// persisted to localStorage. Surrogate always stays at 128 and never goes
// through this controller.

import { useCallback, useRef, useState } from "react";
import { GRID_128, GRID_256, type GridSize } from "@/contracts/types";

export type GridMode = "auto" | "256" | "128";

export const GRID_MODE_KEY = "gearflow:gridMode";
export const SLOW_SOLVE_MS = 800;
export const SLOW_STREAK_LIMIT = 2;

export interface ResolutionState {
    mode: GridMode;
    active: GridSize;
    slowStreak: number;
    autoDropped: boolean;
    notice: string | null;
}

function readMode(): GridMode {
    try {
        if (typeof localStorage === "undefined") return "auto";
        const raw = localStorage.getItem(GRID_MODE_KEY);
        if (raw === "256" || raw === "128" || raw === "auto") return raw;
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

export function initialResolution(mode?: GridMode): ResolutionState {
    const m = mode ?? readMode();
    return {
        mode: m,
        active: m === "128" ? GRID_128 : GRID_256,
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

/** Pin a grid mode. Pinning 256 clears a prior auto drop. */
export function setGridMode(state: ResolutionState, mode: GridMode): ResolutionState {
    storeMode(mode);
    if (mode === "128") {
        return { ...state, mode, active: GRID_128, notice: null };
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
    const setMode = useCallback((mode: GridMode): void => {
        setState((prev) => setGridMode(prev, mode));
    }, []);
    const clearNotice = useCallback((): void => {
        setState((prev) => (prev.notice === null ? prev : { ...prev, notice: null }));
    }, []);
    return { state, recordSolveMs, setMode, clearNotice };
}
