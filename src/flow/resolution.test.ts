// Resolution controller tests: fixed single grid option 512x512. No
// pinned alternatives, no auto fallback, no slow streak.

import { describe, expect, it, beforeEach } from "vitest";
import {
    initialResolution,
    recordSolve,
    resolveGridSize,
    setGridMode,
    SLOW_SOLVE_MS,
} from "./gridController";
import { GRID_512 } from "@/contracts/types";

describe("gridController", () => {
    beforeEach(() => {
        try {
            localStorage.removeItem("gearflow:gridMode");
        } catch {
            // Node env: fixed state needs no storage.
        }
    });

    it("is fixed at mode 512 with a 512 active grid", () => {
        const state = initialResolution();
        expect(state.mode).toBe("512");
        expect(resolveGridSize(state)).toBe(GRID_512);
        expect(resolveGridSize(state)).toBe(512);
        expect(state.autoDropped).toBe(false);
        expect(state.notice).toBeNull();
        expect(state.slowStreak).toBe(0);
    });

    it("never falls back on slow solves", () => {
        let state = initialResolution();
        const first = recordSolve(state, SLOW_SOLVE_MS + 50);
        expect(first.fellBack).toBe(false);
        expect(resolveGridSize(first.state)).toBe(GRID_512);
        state = first.state;
        const second = recordSolve(state, SLOW_SOLVE_MS + 50);
        expect(second.fellBack).toBe(false);
        expect(resolveGridSize(second.state)).toBe(GRID_512);
        expect(second.state.autoDropped).toBe(false);
        expect(second.state.notice).toBeNull();
    });

    it("ignores fast, slow, and non-finite timings alike", () => {
        let state = initialResolution();
        state = recordSolve(state, SLOW_SOLVE_MS + 1).state;
        state = recordSolve(state, 10).state;
        expect(state.slowStreak).toBe(0);
        const next = recordSolve(state, SLOW_SOLVE_MS + 1);
        expect(next.fellBack).toBe(false);
        expect(resolveGridSize(next.state)).toBe(GRID_512);
        const nan = recordSolve(state, Number.NaN);
        expect(nan.fellBack).toBe(false);
        expect(resolveGridSize(nan.state)).toBe(GRID_512);
    });

    it("coerces legacy modes to the fixed 512 state", () => {
        for (const mode of ["auto", "256", "512", "1024", "custom"] as const) {
            const state = setGridMode(initialResolution(), mode, 256);
            expect(state.mode).toBe("512");
            expect(resolveGridSize(state)).toBe(GRID_512);
            expect(state.autoDropped).toBe(false);
            expect(state.notice).toBeNull();
            const next = recordSolve(state, SLOW_SOLVE_MS + 900);
            expect(next.fellBack).toBe(false);
            expect(resolveGridSize(next.state)).toBe(GRID_512);
        }
    });
});
