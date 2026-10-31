// Sweep paint wiring: intermediate alphas must paint in order.
// Pins the P3 debounce fix: a 30 ms yield against the 120 ms App debounce
// collapses to the final alpha, while the immediate flush path plus the
// SWEEP_YIELD_MS paint yield preserves every point.

import { describe, expect, it } from "vitest";
import {
    SWEEP_ALPHAS,
    SWEEP_YIELD_MS,
    defaultSweepYield,
    runAlphaSweep,
} from "@/agent/alphaSweep";

const DEBOUNCE_MS = 120;

describe("sweep paint yield", () => {
    it("exceeds the App canvas debounce so intermediates survive", () => {
        expect(SWEEP_YIELD_MS).toBeGreaterThan(DEBOUNCE_MS);
    });

    it("defaultSweepYield waits at least the paint budget", async () => {
        const start = Date.now();
        await defaultSweepYield();
        const elapsed = Date.now() - start;
        expect(elapsed).toBeGreaterThanOrEqual(SWEEP_YIELD_MS - 25);
    });
});

describe("legacy debounce collapse vs immediate flush", () => {
    it("legacy setSpec with 30 ms yield collapses to the final alpha", async () => {
        let specAlpha = 6;
        const painted: number[] = [];
        let timer: ReturnType<typeof setTimeout> | null = null;
        const setSpec = (alpha: number): void => {
            specAlpha = alpha;
            if (timer !== null) clearTimeout(timer);
            timer = setTimeout(() => {
                painted.push(specAlpha);
            }, DEBOUNCE_MS);
        };
        await runAlphaSweep({
            stepAlpha: async () => ({ cl: 0.5, cpMin: -1, solveMs: 1 }),
            onApply: async (alpha: number) => {
                setSpec(alpha);
            },
            yieldPaint: () => new Promise<void>((resolve) => setTimeout(resolve, 30)),
            startAlpha: 6,
        });
        await new Promise<void>((resolve) => setTimeout(resolve, DEBOUNCE_MS + 80));
        expect(painted).toEqual([12]);
    });

    it("immediate flush paints every intermediate alpha in order", async () => {
        const painted: number[] = [];
        const applyImmediate = (alpha: number): void => {
            painted.push(alpha);
        };
        const result = await runAlphaSweep({
            stepAlpha: async (alpha: number) => ({ cl: 0.1 * alpha, cpMin: -1, solveMs: 1 }),
            onApply: async (alpha: number) => {
                applyImmediate(alpha);
            },
            yieldPaint: () => defaultSweepYield(),
            startAlpha: 6,
        });
        expect(painted).toEqual([...SWEEP_ALPHAS]);
        expect(result.points.map((p) => p.alphaDeg)).toEqual([...SWEEP_ALPHAS]);
    });
});
