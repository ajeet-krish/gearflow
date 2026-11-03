// P3 alpha sweep tests. Pure runner with a fake stepper, zero network.

import { describe, expect, it } from "vitest";
import {
    SWEEP_ALPHAS,
    SWEEP_SUPPRESSES_TUTOR,
    describeSweepResult,
    isAlphaSweepIntent,
    runAlphaSweep,
    sweepToTutorRows,
    type AlphaSweepResult,
} from "./alphaSweep";
import { localReply } from "./localAssistant";
import type { AgentContext } from "./agentContext";

function makeCtx(): AgentContext {
    return {
        spec: { kind: "naca4", alphaDeg: 6, reynolds: 50000, naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 } },
        reynolds: 50000,
        regime: "attached laminar",
        bodyLabel: "NACA 2412",
        alphaDeg: 6,
        backend: "analytic",
        engine: "analytic",
        gridLabel: "grid 128",
        cl: 0.6,
        cpMin: -1.2,
        lbm: { status: "idle", hasSnapshot: false, effective: false, statsReady: false, stats: null },
        field: { variable: "speed", effective: "speed", hasTke: false, hasRecirc: false },
        validation: { pass: 1, warn: 0, fail: 0, info: 0 },
        provenanceLabel: "analytic",
        offline: true,
        honesty: [],
        neural: {
            available: false,
            envelope: "provisional neural envelope, no weights yet",
            path: "analytic",
        },
    };
}

describe("sweep alphas", () => {
    it("covers -4 to 12 step 2 with 9 points", () => {
        expect(SWEEP_ALPHAS).toEqual([-4, -2, 0, 2, 4, 6, 8, 10, 12]);
    });

    it("suppresses per-step tutor turns during the run", () => {
        expect(SWEEP_SUPPRESSES_TUTOR).toBe(true);
    });
});

describe("isAlphaSweepIntent", () => {
    it("matches sweep, what if alpha, and staircase phrasings", () => {
        expect(isAlphaSweepIntent("sweep alpha -4 to 12")).toBe(true);
        expect(isAlphaSweepIntent("what if alpha were higher")).toBe(true);
        expect(isAlphaSweepIntent("run the alpha staircase")).toBe(true);
        expect(isAlphaSweepIntent("show me a sweep")).toBe(true);
    });

    it("matches influence and effect phrasings for AoA", () => {
        expect(isAlphaSweepIntent("how does AoA influence lift")).toBe(true);
        expect(isAlphaSweepIntent("show the influence of alpha")).toBe(true);
        expect(isAlphaSweepIntent("show the effect of alpha")).toBe(true);
        expect(isAlphaSweepIntent("effect of AoA across the band")).toBe(true);
        expect(isAlphaSweepIntent("sweep through alpha")).toBe(true);
        expect(isAlphaSweepIntent("Cl across alpha")).toBe(true);
        expect(isAlphaSweepIntent("run a sweep")).toBe(true);
        expect(isAlphaSweepIntent("demonstrate the alpha sweep")).toBe(true);
    });

    it("matches impact and how-does and how-do affect phrasings", () => {
        expect(isAlphaSweepIntent("how does AoA impact flow")).toBe(true);
        expect(isAlphaSweepIntent("how do changes in alpha affect lift")).toBe(true);
        expect(isAlphaSweepIntent("how does alpha affect suction")).toBe(true);
        expect(isAlphaSweepIntent("impact of alpha on lift")).toBe(true);
        expect(isAlphaSweepIntent("alpha impact on suction")).toBe(true);
        expect(isAlphaSweepIntent("impact on flow from alpha")).toBe(true);
        expect(isAlphaSweepIntent("how does alpha impact flow")).toBe(true);
    });

    it("rejects non-alpha impact and affect phrasings", () => {
        expect(isAlphaSweepIntent("impact of Reynolds number on flow")).toBe(false);
        expect(isAlphaSweepIntent("how do changes in temperature affect flow")).toBe(false);
        expect(isAlphaSweepIntent("how does drag impact flow")).toBe(false);
        expect(isAlphaSweepIntent("impact of drag on flow")).toBe(false);
        expect(isAlphaSweepIntent("how does Reynolds affect lift")).toBe(false);
        expect(isAlphaSweepIntent("how do changes affect lift")).toBe(false);
    });

    it("rejects question guards even when sweep terms appear", () => {
        expect(isAlphaSweepIntent("explain the effect of alpha")).toBe(false);
        expect(isAlphaSweepIntent("explain how alpha influences lift")).toBe(false);
        expect(isAlphaSweepIntent("what is a sweep")).toBe(false);
        expect(isAlphaSweepIntent("what's a sweep")).toBe(false);
        expect(isAlphaSweepIntent("what is the influence of AoA on suction")).toBe(false);
        expect(isAlphaSweepIntent("why sweep alpha")).toBe(false);
        expect(isAlphaSweepIntent("why should I sweep")).toBe(false);
    });

    it("rejects negation guards even when sweep terms appear", () => {
        expect(isAlphaSweepIntent("do not sweep")).toBe(false);
        expect(isAlphaSweepIntent("do not run a sweep")).toBe(false);
        expect(isAlphaSweepIntent("don't sweep")).toBe(false);
        expect(isAlphaSweepIntent("dont sweep")).toBe(false);
        expect(isAlphaSweepIntent("never sweep")).toBe(false);
        expect(isAlphaSweepIntent("no sweep please")).toBe(false);
        expect(isAlphaSweepIntent("not a sweep")).toBe(false);
    });

    it("rejects plain setup and explainer text plus non strings", () => {
        expect(isAlphaSweepIntent("explain this run")).toBe(false);
        expect(isAlphaSweepIntent("set alpha 6")).toBe(false);
        expect(isAlphaSweepIntent("")).toBe(false);
        expect(isAlphaSweepIntent(null)).toBe(false);
        expect(isAlphaSweepIntent(42)).toBe(false);
    });
});

describe("runAlphaSweep", () => {
    it("steps every alpha with deltas and progress in order", async () => {
        const seen: number[] = [];
        const applied: number[] = [];
        const progress: Array<{ done: number; total: number; current: number }> = [];
        const result = await runAlphaSweep({
            stepAlpha: (alpha: number) => {
                seen.push(alpha);
                return { cl: 0.1 * alpha, cpMin: -0.5 - 0.05 * alpha, solveMs: 1 };
            },
            onApply: (alpha: number) => {
                applied.push(alpha);
            },
            isCancelled: () => false,
            onProgress: (done: number, total: number, current: number) => {
                progress.push({ done, total, current });
            },
            yieldPaint: () => {},
            startAlpha: 6,
        });
        expect(result.cancelled).toBe(false);
        expect(result.points.length).toBe(9);
        expect(seen).toEqual([-4, -2, 0, 2, 4, 6, 8, 10, 12]);
        expect(applied).toEqual(seen);
        expect(progress.length).toBe(9);
        expect(progress[2]).toEqual({ done: 3, total: 9, current: 0 });
        expect(result.points[0].dClVsPrev).toBe(null);
        expect(result.points[1].dClVsPrev).toBeCloseTo(0.2, 9);
        expect(result.points[1].dCpVsPrev).toBeCloseTo(-0.1, 9);
        expect(result.startedFrom).toBe(6);
        expect(result.finalAlpha).toBe(12);
    });

    it("restores the start alpha on cancel and marks the run stopped", async () => {
        const restored: number[] = [];
        const result = await runAlphaSweep({
            stepAlpha: () => ({ cl: 0.5, cpMin: -1, solveMs: 1 }),
            onApply: () => {},
            onRestore: (alpha: number) => {
                restored.push(alpha);
            },
            isCancelled: (() => {
                let calls = 0;
                return () => {
                    calls += 1;
                    return calls > 2;
                };
            })(),
            startAlpha: 6,
        });
        expect(result.cancelled).toBe(true);
        expect(result.points.length).toBe(2);
        expect(restored).toEqual([6]);
    });

    it("leaves the last applied alpha when no restore hook is set", async () => {
        const result = await runAlphaSweep({
            stepAlpha: () => ({ cl: 0.5, cpMin: -1, solveMs: 1 }),
            isCancelled: (() => {
                let calls = 0;
                return () => {
                    calls += 1;
                    return calls > 1;
                };
            })(),
            startAlpha: 6,
        });
        expect(result.cancelled).toBe(true);
        expect(result.points.length).toBe(1);
        expect(result.finalAlpha).toBe(-4);
    });

    it("never throws on a failing stepper, recording n/a cells", async () => {
        const result = await runAlphaSweep({
            stepAlpha: () => {
                throw new Error("boom");
            },
            alphas: [-4, -2],
        });
        expect(result.points.length).toBe(2);
        expect(result.points[0].cl).toBe(null);
        expect(result.cancelled).toBe(false);
    });
});

describe("describeSweepResult", () => {
    function swept(): AlphaSweepResult {
        return {
            points: [
                { alphaDeg: -4, cl: 0.1, cpMin: -0.4, solveMs: 1, dClVsPrev: null, dCpVsPrev: null },
                { alphaDeg: 12, cl: 1.1, cpMin: -2.0, solveMs: 1, dClVsPrev: 1, dCpVsPrev: -1.6 },
            ],
            cancelled: false,
            startedFrom: 6,
            finalAlpha: 12,
        };
    }

    it("narrates slope, suction, and the stall caveat from table numbers only", () => {
        const text = describeSweepResult(swept());
        expect(text).toContain("per deg");
        expect(text).toContain("suction deepens");
        expect(text).toContain("Past 12 deg the potential model cannot show stall");
        expect(text).toContain("analytic");
    });

    it("notes an early stop honestly and stays pending safe on empty runs", () => {
        const stopped = describeSweepResult({ ...swept(), cancelled: true });
        expect(stopped).toContain("Stopped early");
        expect(stopped).toContain("last applied alpha");
        expect(describeSweepResult({ points: [], cancelled: true, startedFrom: null, finalAlpha: null })).toContain("No sweep points");
    });
});

describe("sweepToTutorRows", () => {
    it("builds a first vs last delta table in TutorTableRow shape", () => {
        const rows = sweepToTutorRows(
            {
                points: [
                    { alphaDeg: -4, cl: 0.1, cpMin: -0.4, solveMs: 1, dClVsPrev: null, dCpVsPrev: null },
                    { alphaDeg: 12, cl: 1.1, cpMin: -2.0, solveMs: 1, dClVsPrev: 1, dCpVsPrev: -1.6 },
                ],
                cancelled: false,
                startedFrom: 6,
                finalAlpha: 12,
            },
            "NACA 2412"
        );
        expect(rows.length).toBe(6);
        expect(rows.map((row) => row.metric)).toEqual(["Body", "Alpha", "Re", "Cl", "CpMin", "Regime"]);
        for (const row of rows) {
            expect(typeof row.metric).toBe("string");
            expect(typeof row.before).toBe("string");
            expect(typeof row.after).toBe("string");
            expect(typeof row.delta).toBe("string");
        }
        const cl = rows.find((row) => row.metric === "Cl");
        expect(cl?.before).toBe("0.100");
        expect(cl?.after).toBe("1.100");
        expect(cl?.delta).toBe("+1.000");
    });

    it("returns no rows for an empty sweep", () => {
        expect(sweepToTutorRows({ points: [], cancelled: true, startedFrom: null, finalAlpha: null })).toEqual([]);
    });
});

describe("localAssistant sweep intent", () => {
    it("answers sweep phrasings locally with zero actions", () => {
        for (const text of ["sweep alpha -4 to 12", "what if alpha were higher", "run the alpha staircase", "how does AoA influence lift", "show the effect of alpha"]) {
            const out = localReply(text, makeCtx());
            expect(out.actions).toEqual([]);
            expect(out.reply).toContain("staircase");
            expect(out.reply).toContain("9 points");
        }
    });
});
