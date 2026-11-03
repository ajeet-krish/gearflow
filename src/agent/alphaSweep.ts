// P3 live-stepping what-if alpha sweep. Pure runner plus deterministic
// narration, no React, no DOM, no network. The console drives an injected
// live-step callback (stepAlpha) that uses the real App analytic path, so
// the canvas morphs as each alpha applies. Tutor discipline: numbers only
// from the table, stall past 12 reads as a proxy with an honest caveat.
// Never throws.

import { buildTutorTable, type TutorSnapshotLite, type TutorTableRow } from "./tutorTable";

/** Live staircase: -4 to 12 deg in 2 deg steps, 9 points. */
export const SWEEP_ALPHAS: ReadonlyArray<number> = [-4, -2, 0, 2, 4, 6, 8, 10, 12];

/** Paint yield between sweep points. Exceeds the App canvas debounce
 *  (120 ms) plus a paint frame, so each intermediate alpha reaches the
 *  canvas in order instead of collapsing to the final alpha. */
export const SWEEP_YIELD_MS = 150;

/** Default yield: two paint frames plus the SWEEP_YIELD_MS timeout.
 *  Falls back to a plain timeout when rAF is unavailable (tests, SSR).
 *  Never throws, never rejects. */
export function defaultSweepYield(): Promise<void> {
    return new Promise<void>((resolve) => {
        const done = (): void => {
            setTimeout(resolve, SWEEP_YIELD_MS);
        };
        try {
            const raf = (globalThis as unknown as { requestAnimationFrame?: unknown }).requestAnimationFrame;
            if (typeof raf === "function") {
                (raf as (cb: () => void) => void)(() => {
                    try {
                        (raf as (cb: () => void) => void)(() => done());
                    } catch {
                        done();
                    }
                });
                return;
            }
        } catch {
            // Fall through to the timeout below.
        }
        setTimeout(resolve, SWEEP_YIELD_MS);
    });
}

/** Sweep intent patterns: sweep, what if alpha, alpha staircase, plus
 *  influence and effect phrasings (how AoA influences, influence of
 *  alpha/AoA, effect of alpha, across alpha, sweep through alpha) plus
 *  impact phrasings (impact of alpha, how AoA impacts, how changes affect).
 *  Question guards (what is, why, explain, compare, vs) and negation
 *  guards (do not, never, no sweep) return false, mirroring blockIntent,
 *  so definitional or declined sweeps fall through to teaching. */
const SWEEP_QUESTION_RE = /\bwhat\s+is\b|\bwhat'?s\b|\bwhy\b|\bexplain\b|\bcompar\w*|\bversus\b|\bvs\.?(?!\w)/i;
const SWEEP_NEGATION_RE = /\bdo\s+not\b|\bdon'?t\b|\bnever\b|\bno\s+sweep\b|\bnot\s+a\s+sweep\b/i;
const SWEEP_RE = /\bsweep\b/;
const WHAT_IF_ALPHA_RE = /what\s*if.*alpha|alpha.*what\s*if/;
const STAIRCASE_RE = /staircase|alpha ladder|alpha staircase/;
const INFLUENCE_RE = /influence\s+of\s+(alpha|aoa)|how\s+(alpha|aoa)\s+influences?|(alpha|aoa)\s+influence/;
const EFFECT_RE = /effect\s+of\s+(alpha|aoa)/;
const ACROSS_ALPHA_RE = /across\s+(alpha|aoa)/;
const SWEEP_THROUGH_RE = /sweep\s+through/;
const IMPACT_ALPHA_RE = /impact\s+of\s+(alpha|aoa)|(alpha|aoa).*impact|impact.*flow/;
const HOW_DOES_RE = /how\s+does\s+(alpha|aoa)\b/;
const HOW_DO_AFFECT_RE = /how\s+do\b.*\baffect\b|how\s+does\b.*\baffect\b|how\s+do\b.*\beffect\b|how\s+does\b.*\bimpact\b/;

/** True when the text asks for the live alpha staircase. Never throws. */
export function isAlphaSweepIntent(text: unknown): boolean {
    try {
        if (typeof text !== "string") return false;
        const lower = text.toLowerCase();
        if (SWEEP_QUESTION_RE.test(lower)) return false;
        if (SWEEP_NEGATION_RE.test(lower)) return false;
        return SWEEP_RE.test(lower) || WHAT_IF_ALPHA_RE.test(lower) || STAIRCASE_RE.test(lower) || INFLUENCE_RE.test(lower) || EFFECT_RE.test(lower) || ACROSS_ALPHA_RE.test(lower) || SWEEP_THROUGH_RE.test(lower) || IMPACT_ALPHA_RE.test(lower) || HOW_DOES_RE.test(lower) || HOW_DO_AFFECT_RE.test(lower);
    } catch {
        return false;
    }
}

/** One live-step solve sample. Nulls mean the solve did not land. */
export interface SweepStepSample {
    cl: number | null;
    cpMin: number | null;
    solveMs: number | null;
}

/** Injected live-step callback using the real App analytic path. */
export type SweepStepFn = (alphaDeg: number) => SweepStepSample | Promise<SweepStepSample>;

/** One swept point with deltas against the previous point. */
export interface AlphaSweepPoint {
    alphaDeg: number;
    cl: number | null;
    cpMin: number | null;
    solveMs: number | null;
    dClVsPrev: number | null;
    dCpVsPrev: number | null;
}

/** Runner outcome. cancelled true means Stop fired mid-run. */
export interface AlphaSweepResult {
    points: AlphaSweepPoint[];
    cancelled: boolean;
    startedFrom: number | null;
    finalAlpha: number | null;
}

export interface RunAlphaSweepDeps {
    stepAlpha: SweepStepFn;
    /** Canvas morph per point, usually onAgentAction set_alpha. */
    onApply?: (alphaDeg: number) => void | Promise<void>;
    /** Restore the original alpha on cancel, optional (leave on last when absent). */
    onRestore?: (alphaDeg: number) => void | Promise<void>;
    /** Stop flag polled before each point. */
    isCancelled?: () => boolean;
    /** Progress paint hook after each applied point. */
    onProgress?: (done: number, total: number, alphaDeg: number) => void;
    /** Yield between points so progress paints and Stop lands. */
    yieldPaint?: () => void | Promise<void>;
    /** Alpha to restore on cancel, null skips restore. */
    startAlpha?: number | null;
    /** Alpha list override for tests, defaults to SWEEP_ALPHAS. */
    alphas?: ReadonlyArray<number>;
}

function finiteOrNull(v: unknown): number | null {
    return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function cleanSample(raw: unknown): SweepStepSample {
    try {
        const rec = (raw ?? {}) as { cl?: unknown; cpMin?: unknown; solveMs?: unknown };
        return { cl: finiteOrNull(rec.cl), cpMin: finiteOrNull(rec.cpMin), solveMs: finiteOrNull(rec.solveMs) };
    } catch {
        return { cl: null, cpMin: null, solveMs: null };
    }
}

/** While a sweep runs the console suppresses per-step tutor turns and
 *  renders one summary at the end. Exported so the console settle path
 *  and tests share one flag. */
export const SWEEP_SUPPRESSES_TUTOR = true;

/**
 * Run the live staircase. Steps each alpha through stepAlpha, applies it
 * for the canvas morph, yields between points for progress paint plus Stop.
 * On cancel the runner stops early and restores startAlpha through
 * onRestore when both are present, otherwise it leaves the last applied
 * alpha with the caller noting it honestly. Never throws.
 */
export async function runAlphaSweep(deps: RunAlphaSweepDeps): Promise<AlphaSweepResult> {
    try {
        const alphas = Array.isArray(deps.alphas) && deps.alphas.length > 0 ? deps.alphas : SWEEP_ALPHAS;
        const start = finiteOrNull(deps.startAlpha ?? null);
        const points: AlphaSweepPoint[] = [];
        let cancelled = false;
        let prevCl: number | null = null;
        let prevCp: number | null = null;
        const total = alphas.length;
        let done = 0;
        for (const alpha of alphas) {
            try {
                if (typeof deps.isCancelled === "function" && deps.isCancelled()) {
                    cancelled = true;
                    break;
                }
            } catch {
                // Cancel probe faults never stop the sweep.
            }
            let sample: SweepStepSample = { cl: null, cpMin: null, solveMs: null };
            try {
                sample = cleanSample(await deps.stepAlpha(alpha));
            } catch {
                sample = { cl: null, cpMin: null, solveMs: null };
            }
            const dCl = sample.cl !== null && prevCl !== null ? sample.cl - prevCl : null;
            const dCp = sample.cpMin !== null && prevCp !== null ? sample.cpMin - prevCp : null;
            points.push({ alphaDeg: alpha, cl: sample.cl, cpMin: sample.cpMin, solveMs: sample.solveMs, dClVsPrev: dCl, dCpVsPrev: dCp });
            if (sample.cl !== null) prevCl = sample.cl;
            if (sample.cpMin !== null) prevCp = sample.cpMin;
            try {
                if (typeof deps.onApply === "function") await deps.onApply(alpha);
            } catch {
                // Canvas faults stay local, the sweep keeps its samples.
            }
            done += 1;
            try {
                if (typeof deps.onProgress === "function") deps.onProgress(done, total, alpha);
            } catch {
                // Progress faults never break the sweep.
            }
            try {
                if (typeof deps.yieldPaint === "function") await deps.yieldPaint();
            } catch {
                // Yield faults never break the sweep.
            }
        }
        try {
            if (typeof deps.isCancelled === "function" && deps.isCancelled()) cancelled = true;
        } catch {
            // Final probe faults keep the completed flag.
        }
        if (cancelled && start !== null && typeof deps.onRestore === "function") {
            try {
                await deps.onRestore(start);
            } catch {
                // Restore faults stay local, the result still reports cancelled.
            }
        }
        const finalAlpha = points.length > 0 ? points[points.length - 1].alphaDeg : null;
        return { points, cancelled, startedFrom: start, finalAlpha };
    } catch {
        return { points: [], cancelled: true, startedFrom: null, finalAlpha: null };
    }
}

function fmtCl(v: number | null): string {
    return v === null ? "n/a" : v.toFixed(3);
}

function fmtCp(v: number | null): string {
    return v === null ? "n/a" : v.toFixed(3);
}

/**
 * Deterministic local narration for a sweep result. Cites only the swept
 * samples: Cl slope per deg, suction trend, and the honest stall caveat
 * past 12 deg where the potential model cannot show stall. Never throws.
 */
export function describeSweepResult(result: AlphaSweepResult): string {
    try {
        const pts = Array.isArray(result.points) ? result.points : [];
        if (pts.length === 0) {
            return "Local sweep note, local only. No sweep points landed, canvas unchanged. Caveat: analytic estimate only, served by the analytic path.";
        }
        const first = pts[0];
        const last = pts[pts.length - 1];
        const span = last.alphaDeg - first.alphaDeg;
        let slopeText = "Cl slope pending";
        if (first.cl !== null && last.cl !== null && span !== 0) {
            const slope = (last.cl - first.cl) / span;
            if (Number.isFinite(slope)) slopeText = `Cl slope about ${slope.toFixed(3)} per deg from ${fmtCl(first.cl)} at ${first.alphaDeg} deg to ${fmtCl(last.cl)} at ${last.alphaDeg} deg`;
        }
        let suctionText = "suction trend pending";
        if (first.cpMin !== null && last.cpMin !== null) {
            const deepening = last.cpMin < first.cpMin;
            suctionText = deepening
                ? `suction deepens from CpMin ${fmtCp(first.cpMin)} to ${fmtCp(last.cpMin)} as alpha rises`
                : `CpMin moves from ${fmtCp(first.cpMin)} to ${fmtCp(last.cpMin)} across the staircase`;
        }
        const cancelledNote = result.cancelled
            ? " Stopped early, leaving the last applied alpha in place."
            : "";
        return (
            `Local sweep note, local only. Live alpha staircase ${first.alphaDeg} to ${last.alphaDeg} deg in 2 deg steps (${pts.length} points), analytic path, canvas stepped with each alpha. ` +
            `${slopeText}. ${suctionText}. ` +
            `Past 12 deg the potential model cannot show stall, treat higher alpha lift as unvalidated.${cancelledNote} ` +
            `Caveat: analytic estimate only, served by the analytic table, the stepper is analytic unconditionally.`
        );
    } catch {
        return "Local sweep note, local only. The sweep summary is unavailable, canvas unchanged. Caveat: analytic estimate only.";
    }
}

function sweepLite(pts: AlphaSweepPoint[], at: "first" | "last", bodyLabel: string): TutorSnapshotLite {
    const pick = at === "first" ? pts[0] : pts[pts.length - 1];
    return {
        caseKey: `sweep|a${pick.alphaDeg}`,
        bodyLabel,
        alpha: pick.alphaDeg,
        reynolds: null,
        cl: pick.cl,
        cpMin: pick.cpMin,
        regime: "analytic staircase",
        pathLabel: "analytic",
        strouhal: null,
    };
}

/**
 * First vs last sweep table reusing the TutorTableRow shape, so the
 * summary turn renders through the existing tutor table skin with Apply
 * chips per point handled separately. Never throws.
 */
export function sweepToTutorRows(result: AlphaSweepResult, bodyLabel = "current body"): TutorTableRow[] {
    try {
        const pts = Array.isArray(result.points) ? result.points : [];
        if (pts.length === 0) return [];
        const label = typeof bodyLabel === "string" && bodyLabel.trim().length > 0 ? bodyLabel.trim() : "current body";
        return buildTutorTable(sweepLite(pts, "first", label), sweepLite(pts, "last", label));
    } catch {
        return [];
    }
}
