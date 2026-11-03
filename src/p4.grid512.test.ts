// P4 verification: auto grid defaults 512 with fallback 256 after two slow
// solves, pinned modes unchanged, analytic 1024 cap with the LBM 512 envelope
// intact, custom 128 to 1024, plus docs notes (README Vercel stay,
// DECISIONS 2026-11-03).
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
    GRID_256,
    GRID_512,
    GRID_OPTIONS,
} from "@/contracts/types";
import { ANALYTIC_MAX_CELLS, ANALYTIC_MAX_NX, ANALYTIC_MAX_NY } from "@/contracts/schema";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

describe("P4 auto grid defaults 512", () => {
    beforeEach(() => {
        try {
            localStorage.removeItem("gearflow:gridMode");
            localStorage.removeItem("gearflow:gridCustom");
        } catch {
            // Node env without storage: controller falls back to auto.
        }
    });

    it("GRID_512 pins 512 and auto resolves to it", () => {
        expect(GRID_512).toBe(512);
        expect(SLOW_STREAK_LIMIT).toBe(2);
        expect(SLOW_SOLVE_MS).toBe(800);
        const auto = initialResolution("auto");
        expect(auto.mode).toBe("auto");
        expect(resolveGridSize(auto)).toBe(512);
        expect(resolveGridSize(auto)).toBe(GRID_512);
        expect(auto.autoDropped).toBe(false);
        expect(auto.slowStreak).toBe(0);
    });

    it("falls back to 256 only after two consecutive slow solves", () => {
        let state = initialResolution("auto");
        const first = recordSolve(state, SLOW_SOLVE_MS + 50);
        expect(first.fellBack).toBe(false);
        expect(resolveGridSize(first.state)).toBe(GRID_512);
        expect(first.state.slowStreak).toBe(1);
        const second = recordSolve(first.state, SLOW_SOLVE_MS + 50);
        expect(second.fellBack).toBe(true);
        expect(resolveGridSize(second.state)).toBe(GRID_256);
        expect(second.state.autoDropped).toBe(true);
        expect(second.state.notice).toContain("256");
        expect(second.state.notice).toContain("512");
    });

    it("does not fall back on a single slow solve or on-budget timing", () => {
        let state = initialResolution("auto");
        state = recordSolve(state, SLOW_SOLVE_MS + 1).state;
        expect(resolveGridSize(state)).toBe(GRID_512);
        expect(state.slowStreak).toBe(1);
        const exact = recordSolve(initialResolution("auto"), SLOW_SOLVE_MS);
        expect(exact.fellBack).toBe(false);
        expect(resolveGridSize(exact.state)).toBe(GRID_512);
    });

    it("resets the streak on a fast solve and ignores non-finite timings", () => {
        let state = initialResolution("auto");
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

describe("P4 pinned modes unchanged", () => {
    beforeEach(() => {
        try {
            localStorage.removeItem("gearflow:gridMode");
            localStorage.removeItem("gearflow:gridCustom");
        } catch {
            // Node env without storage.
        }
    });

    it("keeps GRID_OPTIONS as the three pinned presets", () => {
        expect(GRID_256).toBe(256);
        expect(GRID_512).toBe(512);
        expect(GRID_1024).toBe(1024);
        expect(GRID_OPTIONS).toEqual([256, 512, 1024]);
        expect(GRID_OPTIONS).not.toContain(128);
    });

    it("never falls back when pinned to 256, 512, 1024, or custom", () => {
        for (const mode of ["256", "512", "1024"] as const) {
            let state = setGridMode(initialResolution("auto"), mode);
            for (let i = 0; i < 4; i++) {
                const next = recordSolve(state, SLOW_SOLVE_MS + 500);
                expect(next.fellBack).toBe(false);
                state = next.state;
            }
            expect(state.autoDropped).toBe(false);
        }
        let custom = setGridMode(initialResolution("auto"), "custom", 256);
        expect(custom.active).toBe(256);
        for (let i = 0; i < 3; i++) {
            const next = recordSolve(custom, SLOW_SOLVE_MS + 500);
            expect(next.fellBack).toBe(false);
            custom = next.state;
        }
        expect(resolveGridSize(custom)).toBe(256);
    });

    it("pinning 256 clears a prior auto drop and pinning auto returns to 512", () => {
        let state = initialResolution("auto");
        state = recordSolve(state, SLOW_SOLVE_MS + 1).state;
        state = recordSolve(state, SLOW_SOLVE_MS + 1).state;
        expect(state.autoDropped).toBe(true);
        expect(resolveGridSize(state)).toBe(GRID_256);
        const pinned = setGridMode(state, "256");
        expect(resolveGridSize(pinned)).toBe(GRID_256);
        expect(pinned.autoDropped).toBe(false);
        expect(pinned.notice).toBeNull();
        const backToAuto = setGridMode(pinned, "auto");
        expect(resolveGridSize(backToAuto)).toBe(GRID_512);
        expect(backToAuto.autoDropped).toBe(false);
    });
});

describe("P4 1024 analytic cap plus custom range intact", () => {
    it("caps the analytic grid at 1024 with the LBM envelope unchanged", () => {
        expect(CUSTOM_GRID_MAX).toBe(1024);
        expect(CUSTOM_GRID_MIN).toBe(128);
        expect(ANALYTIC_MAX_NX).toBe(1024);
        expect(ANALYTIC_MAX_NY).toBe(1024);
        expect(ANALYTIC_MAX_CELLS).toBe(1048576);
        expect(GRID_512).toBeLessThanOrEqual(CUSTOM_GRID_MAX);
        expect(GRID_1024).toBeLessThanOrEqual(CUSTOM_GRID_MAX);
    });

    it("accepts custom squares from 128 to 1024 inclusive", () => {
        expect(parseCustomGrid(128).ok).toBe(true);
        expect(parseCustomGrid(1024).ok).toBe(true);
        expect(parseCustomGrid("128").ok).toBe(true);
        expect(parseCustomGrid("1024").ok).toBe(true);
        expect(parseCustomGrid(256).ok).toBe(true);
        const custom = setGridMode(initialResolution("auto"), "custom", 256);
        expect(custom.active).toBe(256);
        const edge = setGridMode(initialResolution("auto"), "custom", 1024);
        expect(edge.active).toBe(1024);
    });

    it("rejects custom sides outside 128 to 1024 with a helpful reason", () => {
        expect(parseCustomGrid(127).ok).toBe(false);
        expect(parseCustomGrid(1025).ok).toBe(false);
        expect(parseCustomGrid(7).ok).toBe(false);
        expect(parseCustomGrid(0).ok).toBe(false);
        expect(parseCustomGrid(-4).ok).toBe(false);
        expect(parseCustomGrid(96.5).ok).toBe(false);
        expect(parseCustomGrid("abc").ok).toBe(false);
        expect(parseCustomGrid("").ok).toBe(false);
        expect(parseCustomGrid(Number.NaN).ok).toBe(false);
        const bad = setGridMode(initialResolution("auto"), "custom", 7);
        expect(bad.notice).toContain("128");
        const over = setGridMode(initialResolution("auto"), "custom", 1025);
        expect(over.notice).toContain("1024");
    });

    it("SettingsModal and App copy name the 512 auto contract", () => {
        const modal = readFileSync(resolve(root, "src/ui/SettingsModal.tsx"), "utf8");
        expect(modal).toContain("Auto (512, fallback to 256)");
        expect(modal).not.toContain("Auto (256, fallback to 128)");
        const app = readFileSync(resolve(root, "src/App.tsx"), "utf8");
        expect(app).toContain("512 default");
        expect(app).toContain("512 drop to 256");
    });
});

describe("P4 docs notes", () => {
    it("README keeps the Vercel stay note", () => {
        const readme = readFileSync(resolve(root, "README.md"), "utf8");
        expect(readme).toContain("stay on Vercel");
        expect(readme).toContain("GitHub Pages rejected");
        expect(readme).toContain("/api/modal");
    });

    it("DECISIONS logs the 2026-11-03 Vercel stay entry", () => {
        const decisions = readFileSync(resolve(root, "docs/DECISIONS.md"), "utf8");
        expect(decisions).toContain("2026-11-03 Stay on Vercel");
        expect(decisions).toContain("GitHub Pages");
    });
});
