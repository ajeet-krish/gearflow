// Resolution controller. Fixed single grid option: 512x512 for every
// analytic solve. The pinned 256/1024/custom options and the auto fallback
// streak are removed: gridMode is effectively always 512, recordSolve never
// falls back, and the notice channel stays null. parseCustomGrid is kept so
// the [128, 1024] fixture and schema caps keep one parser, but the live path
// never calls it. Surrogate always stays at 128 and never goes through this
// controller.

import { useCallback, useRef, useState } from "react";
import { CUSTOM_GRID_MAX, CUSTOM_GRID_MIN, GRID_512, type GridSize } from "@/contracts/types";

export type GridMode = "512";

export const GRID_MODE_KEY = "gearflow:gridMode";
export const GRID_CUSTOM_KEY = "gearflow:gridCustom";
/** Retained for test and history compat. The fixed grid never times out. */
export const SLOW_SOLVE_MS = 800;
/** Retained for test and history compat. The fixed grid never counts a streak. */
export const SLOW_STREAK_LIMIT = 2;

export interface ResolutionState {
    mode: GridMode;
    active: GridSize;
    customSize: number;
    slowStreak: number;
    autoDropped: boolean;
    notice: string | null;
}

function fixedState(): ResolutionState {
    return {
        mode: "512",
        active: GRID_512,
        customSize: GRID_512,
        slowStreak: 0,
        autoDropped: false,
        notice: null,
    };
}

export interface CustomGridParse {
    ok: boolean;
    size: number;
    reason: string | null;
}

/**
 * Parse a custom square grid side. Accepts numbers and numeric strings.
 * Must be an integer in [128, 1024]. Never throws. Kept for the fixture
 * and schema caps; the live solve path stays pinned to 512.
 */
export function parseCustomGrid(raw: unknown): CustomGridParse {
    const fail = (reason: string): CustomGridParse => ({ ok: false, size: GRID_512, reason });
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

export function initialResolution(_mode?: unknown): ResolutionState {
    return fixedState();
}

/** Effective grid size for the next solve. Always 512. */
export function resolveGridSize(_state: ResolutionState): GridSize {
    return GRID_512;
}

/**
 * Record one solve duration. The fixed grid never falls back: every timing
 * resolves to the same 512 state with fellBack false. Never throws.
 */
export function recordSolve(
    state: ResolutionState,
    _fieldMs: number
): { state: ResolutionState; fellBack: boolean } {
    void _fieldMs;
    return { state: { ...state, mode: "512", active: GRID_512, slowStreak: 0, autoDropped: false, notice: null }, fellBack: false };
}

/** Pin a grid mode. Legacy modes coerce to the fixed 512 state. */
export function setGridMode(state: ResolutionState, _mode?: unknown, _customRaw?: unknown): ResolutionState {
    void _mode;
    void _customRaw;
    return { ...state, mode: "512", active: GRID_512, slowStreak: 0, autoDropped: false, notice: null };
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
    const setMode = useCallback((mode?: unknown, customRaw?: unknown): void => {
        setState((prev) => setGridMode(prev, mode, customRaw));
    }, []);
    const clearNotice = useCallback((): void => {
        setState((prev) => (prev.notice === null ? prev : { ...prev, notice: null }));
    }, []);
    return { state, recordSolveMs, setMode, clearNotice };
}
