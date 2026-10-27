// Resolution controller tests: 256 default, auto fallback after two
// consecutive slow solves, pinned modes never fall back.

import { describe, expect, it, beforeEach } from "vitest";
import {
    initialResolution,
    recordSolve,
    resolveGridSize,
    setGridMode,
    SLOW_SOLVE_MS,
} from "./gridController";
import { GRID_128, GRID_256 } from "@/contracts/types";

describe("gridController", () => {
    beforeEach(() => {
        try {
            localStorage.removeItem("gearflow:gridMode");
        } catch {
            // Node env: readMode falls back to auto.
        }
    });

    it("defaults to auto with a 256 active grid", () => {
        const state = initialResolution();
        expect(state.mode).toBe("auto");
        expect(resolveGridSize(state)).toBe(GRID_256);
        expect(state.autoDropped).toBe(false);
    });

    it("falls back to 128 after two consecutive solves over budget", () => {
        let state = initialResolution("auto");
        const first = recordSolve(state, SLOW_SOLVE_MS + 50);
        expect(first.fellBack).toBe(false);
        expect(resolveGridSize(first.state)).toBe(GRID_256);
        state = first.state;
        const second = recordSolve(state, SLOW_SOLVE_MS + 50);
        expect(second.fellBack).toBe(true);
        expect(resolveGridSize(second.state)).toBe(GRID_128);
        expect(second.state.autoDropped).toBe(true);
        expect(second.state.notice).toContain("128");
    });

    it("resets the slow streak on a fast solve", () => {
        let state = initialResolution("auto");
        state = recordSolve(state, SLOW_SOLVE_MS + 1).state;
        state = recordSolve(state, 10).state;
        expect(state.slowStreak).toBe(0);
        const next = recordSolve(state, SLOW_SOLVE_MS + 1);
        expect(next.fellBack).toBe(false);
        expect(resolveGridSize(next.state)).toBe(GRID_256);
    });

    it("never falls back when pinned to 256", () => {
        let state = setGridMode(initialResolution("auto"), "256");
        for (let i = 0; i < 4; i++) {
            const next = recordSolve(state, SLOW_SOLVE_MS + 400);
            expect(next.fellBack).toBe(false);
            state = next.state;
        }
        expect(resolveGridSize(state)).toBe(GRID_256);
    });

    it("pins 128 directly with no notice", () => {
        const state = setGridMode(initialResolution("auto"), "128");
        expect(resolveGridSize(state)).toBe(GRID_128);
        expect(state.notice).toBeNull();
        const next = recordSolve(state, SLOW_SOLVE_MS + 900);
        expect(next.fellBack).toBe(false);
    });

    it("pinning 256 clears a prior auto drop", () => {
        let state = initialResolution("auto");
        state = recordSolve(state, SLOW_SOLVE_MS + 1).state;
        state = recordSolve(state, SLOW_SOLVE_MS + 1).state;
        expect(state.autoDropped).toBe(true);
        state = setGridMode(state, "256");
        expect(resolveGridSize(state)).toBe(GRID_256);
        expect(state.autoDropped).toBe(false);
    });
});
