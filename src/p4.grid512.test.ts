// P4 verification: fixed single grid option 512x512, analytic 1024 cap
// with the LBM 512 envelope intact, custom parser 128 to 1024 for fixtures,
// plus docs notes (README frozen Vercel hosting plus Modal proxy, DECISIONS 2026-11-03).
import { describe, expect, it, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
    initialResolution,
    parseCustomGrid,
    recordSolve,
    resolveGridSize,
    setGridMode,
    SLOW_SOLVE_MS,
    SLOW_STREAK_LIMIT,
} from "@/flow/gridController";
import {
    CUSTOM_GRID_MAX,
    CUSTOM_GRID_MIN,
    GRID_1024,
    GRID_512,
    GRID_OPTIONS,
} from "@/contracts/types";
import { ANALYTIC_MAX_CELLS, ANALYTIC_MAX_NX, ANALYTIC_MAX_NY } from "@/contracts/schema";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

describe("P4 fixed grid 512", () => {
    beforeEach(() => {
        try {
            localStorage.removeItem("gearflow:gridMode");
            localStorage.removeItem("gearflow:gridCustom");
        } catch {
            // Node env without storage: controller is fixed at 512.
        }
    });

    it("GRID_512 is 512 and the controller resolves to it", () => {
        expect(GRID_512).toBe(512);
        expect(SLOW_STREAK_LIMIT).toBe(2);
        expect(SLOW_SOLVE_MS).toBe(800);
        const fixed = initialResolution();
        expect(fixed.mode).toBe("512");
        expect(resolveGridSize(fixed)).toBe(512);
        expect(resolveGridSize(fixed)).toBe(GRID_512);
        expect(fixed.autoDropped).toBe(false);
        expect(fixed.slowStreak).toBe(0);
        expect(fixed.notice).toBeNull();
    });

    it("never falls back on slow solves", () => {
        let state = initialResolution();
        const first = recordSolve(state, SLOW_SOLVE_MS + 50);
        expect(first.fellBack).toBe(false);
        expect(resolveGridSize(first.state)).toBe(GRID_512);
        expect(first.state.slowStreak).toBe(0);
        const second = recordSolve(first.state, SLOW_SOLVE_MS + 50);
        expect(second.fellBack).toBe(false);
        expect(resolveGridSize(second.state)).toBe(GRID_512);
        expect(second.state.autoDropped).toBe(false);
        expect(second.state.notice).toBeNull();
    });

    it("ignores on-budget, fast, and non-finite timings alike", () => {
        let state = initialResolution();
        state = recordSolve(state, SLOW_SOLVE_MS + 1).state;
        expect(resolveGridSize(state)).toBe(GRID_512);
        expect(state.slowStreak).toBe(0);
        const exact = recordSolve(initialResolution(), SLOW_SOLVE_MS);
        expect(exact.fellBack).toBe(false);
        expect(resolveGridSize(exact.state)).toBe(GRID_512);
    });

    it("ignores fast solves and non-finite timings without a streak", () => {
        let state = initialResolution();
        state = recordSolve(state, SLOW_SOLVE_MS + 100).state;
        state = recordSolve(state, 10).state;
        expect(state.slowStreak).toBe(0);
        expect(resolveGridSize(state)).toBe(GRID_512);
        const nan = recordSolve(state, Number.NaN);
        expect(nan.fellBack).toBe(false);
        expect(resolveGridSize(nan.state)).toBe(GRID_512);
        const inf = recordSolve(state, Number.POSITIVE_INFINITY);
        expect(inf.fellBack).toBe(false);
    });
});

describe("P4 legacy modes coerce to 512", () => {
    beforeEach(() => {
        try {
            localStorage.removeItem("gearflow:gridMode");
            localStorage.removeItem("gearflow:gridCustom");
        } catch {
            // Node env without storage.
        }
    });

    it("keeps the schema grid constants for fixtures", () => {
        expect(GRID_512).toBe(512);
        expect(GRID_1024).toBe(1024);
        expect(GRID_OPTIONS).toEqual([256, 512, 1024]);
        expect(GRID_OPTIONS).not.toContain(128);
    });

    it("coerces pinned and custom modes to the fixed 512 state", () => {
        for (const mode of ["auto", "256", "512", "1024"] as const) {
            let state = setGridMode(initialResolution(), mode);
            expect(state.mode).toBe("512");
            for (let i = 0; i < 4; i++) {
                const next = recordSolve(state, SLOW_SOLVE_MS + 500);
                expect(next.fellBack).toBe(false);
                state = next.state;
            }
            expect(state.autoDropped).toBe(false);
            expect(resolveGridSize(state)).toBe(GRID_512);
        }
        const custom = setGridMode(initialResolution(), "custom", 256);
        expect(custom.active).toBe(GRID_512);
        expect(resolveGridSize(custom)).toBe(GRID_512);
    });
});

describe("P4 1024 analytic cap plus fixture parser intact", () => {
    it("caps the analytic grid at 1024 with the LBM envelope unchanged", () => {
        expect(CUSTOM_GRID_MAX).toBe(1024);
        expect(CUSTOM_GRID_MIN).toBe(128);
        expect(ANALYTIC_MAX_NX).toBe(1024);
        expect(ANALYTIC_MAX_NY).toBe(1024);
        expect(ANALYTIC_MAX_CELLS).toBe(1048576);
        expect(GRID_512).toBeLessThanOrEqual(CUSTOM_GRID_MAX);
        expect(GRID_1024).toBeLessThanOrEqual(CUSTOM_GRID_MAX);
    });

    it("accepts fixture squares from 128 to 1024 inclusive", () => {
        expect(parseCustomGrid(128).ok).toBe(true);
        expect(parseCustomGrid(1024).ok).toBe(true);
        expect(parseCustomGrid("128").ok).toBe(true);
        expect(parseCustomGrid("1024").ok).toBe(true);
        expect(parseCustomGrid(256).ok).toBe(true);
    });

    it("rejects fixture sides outside 128 to 1024 with a helpful reason", () => {
        expect(parseCustomGrid(127).ok).toBe(false);
        expect(parseCustomGrid(1025).ok).toBe(false);
        expect(parseCustomGrid(7).ok).toBe(false);
        expect(parseCustomGrid(0).ok).toBe(false);
        expect(parseCustomGrid(-4).ok).toBe(false);
        expect(parseCustomGrid(96.5).ok).toBe(false);
        expect(parseCustomGrid("abc").ok).toBe(false);
        expect(parseCustomGrid("").ok).toBe(false);
        expect(parseCustomGrid(Number.NaN).ok).toBe(false);
    });

    it("SettingsModal carries no resolution section while App keeps the fixed 512 contract", () => {
        const modal = readFileSync(resolve(root, "src/ui/SettingsModal.tsx"), "utf8");
        expect(modal).not.toContain("RESOLUTION");
        expect(modal).not.toContain("Fixed grid");
        expect(modal).not.toContain("Auto (512, fallback to 256)");
        expect(modal).not.toContain("Custom square");
        const app = readFileSync(resolve(root, "src/App.tsx"), "utf8");
        expect(app).toContain("fixed 512");
        expect(app).not.toContain("512 drop to 256");
    });
});

describe("P4 docs notes", () => {
    it("README documents frozen Vercel hosting with server Modal proxy", () => {
        const readme = readFileSync(resolve(root, "README.md"), "utf8");
        expect(readme).toContain("vercel.app");
        expect(readme).toContain("Vercel");
        expect(readme).toContain("Modal proxy");
        expect(readme).toContain("MODAL_");
    });

    it("DECISIONS logs the 2026-11-03 Vercel stay entry", () => {
        const decisions = readFileSync(resolve(root, "docs/DECISIONS.md"), "utf8");
        expect(decisions).toContain("2026-11-03 Stay on Vercel");
        expect(decisions).toContain("GitHub Pages");
    });
});
