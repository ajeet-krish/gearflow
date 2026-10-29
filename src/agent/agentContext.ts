// Phase B2 agent context snapshot. Pure builder, no React, no DOM, no
// typed arrays. Bounded JSON for the Spark prompt: finite guards on every
// number, truncated labels, capped honesty lines, target under 900 tokens.

import type { FieldMode, GeometrySpec, LbmStats } from "@/contracts/types";
import { ALPHA_MAX, ALPHA_MIN } from "@/contracts/schema";
import { PROVISIONAL_NEURAL_ENVELOPE, classifyNeuralDomain } from "@/flow/neuralDomain";

const PROVENANCE_MAX = 120;
const LABEL_MAX = 80;
const HONESTY_MAX_LINES = 5;
const HONESTY_MAX_CHARS = 140;
const CONTEXT_CHAR_BUDGET = 3500;

function finiteOrNull(v: unknown): number | null {
    return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function round4(v: number): number {
    return Math.round(v * 10000) / 10000;
}

function cleanLabel(v: unknown, max: number, fallback: string): string {
    if (typeof v !== "string") return fallback;
    const t = v.trim().replace(/\s+/g, " ");
    if (t.length === 0) return fallback;
    return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

function cleanCount(v: unknown): number {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return 0;
    return Math.min(9999, Math.floor(v));
}

/** Body token for the neural domain check. NACA kinds resolve to their
 *  code token, bluff bodies pass through, anything else stays as named so
 *  the envelope reports it out of domain honestly. */
function neuralBodyToken(kind: unknown, code: unknown): string {
    if (kind === "naca4" && typeof code === "string" && code.trim().length === 4) {
        return `naca${code.trim()}`;
    }
    return typeof kind === "string" && kind.length > 0 ? kind : "unknown";
}

/** Default envelope summary for the prompt when App omits it. */
function defaultEnvelopeSummary(): string {
    const env = PROVISIONAL_NEURAL_ENVELOPE;
    return `provisional neural envelope [${env.kinds.join(", ")}], alpha [${env.alphaMin}, ${env.alphaMax}], Re [${env.reMin}, ${env.reMax}], no weights yet`;
}

/** Step and sample counts report the true floor with no upper cap, so long
 *  runs never silently clip at a display bound. */
function cleanStep(v: unknown): number {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return 0;
    return Math.floor(v);
}

/** Everything App supplies without new data plumbing. All fields come from
 *  existing solved state, prefs, ledger counts, and LBM provider flags. */
export interface AppSnapshot {
    spec: GeometrySpec;
    reynolds: number;
    regime: string;
    bodyLabel: string;
    backend: string;
    engine: string;
    gridLabel: string;
    cl: number;
    cpMin: number;
    lbmStatus: string;
    lbmHasSnapshot: boolean;
    lbmEffective?: boolean;
    lbmStatsReady: boolean;
    lbmStats: LbmStats | null;
    variable: FieldMode;
    effectiveVariable: FieldMode;
    hasTke: boolean;
    hasRecirc: boolean;
    validation: { pass: number; warn: number; fail: number; info: number };
    provenanceLabel: string;
    offline: boolean;
    /** Neural serving flag, additive and optional for older callers. */
    neuralAvailable?: boolean;
    /** Short envelope summary for the prompt, optional for older callers. */
    neuralEnvelopeSummary?: string;
    /** Solver path actually displayed this frame, optional for older callers. */
    displayedPath?: string;
}

export interface AgentLbmStats {
    samples: number;
    step: number;
    recircFraction: number;
    cdMean: number | null;
    clMean: number | null;
    clRms: number | null;
    strouhal: number | null;
}

/** NACA section snapshot so relative parser edits (thicker, more camber)
 *  resolve against the live section instead of guessing a code. Null for
 *  non NACA bodies. */
export interface AgentNacaSnapshot {
    code: string;
    m: number;
    p: number;
    t: number;
}

export interface AgentContext {
    spec: { kind: string; alphaDeg: number | null; reynolds: number | null; naca: AgentNacaSnapshot | null };
    reynolds: number | null;
    regime: string;
    bodyLabel: string;
    alphaDeg: number | null;
    backend: string;
    engine: string;
    gridLabel: string;
    cl: number | null;
    cpMin: number | null;
    lbm: {
        status: string;
        hasSnapshot: boolean;
        effective: boolean;
        statsReady: boolean;
        stats: AgentLbmStats | null;
    };
    field: {
        variable: FieldMode;
        effective: FieldMode;
        hasTke: boolean;
        hasRecirc: boolean;
    };
    validation: { pass: number; warn: number; fail: number; info: number };
    provenanceLabel: string;
    offline: boolean;
    honesty: string[];
    neural: {
        available: boolean;
        envelope: string;
        path: string;
    };
}

/**
 * Build a bounded agent context from the App snapshot. Never throws: null
 * or partial snapshots fall back to safe defaults, and malformed numbers
 * become null. Step and sample counts report true values with no upper
 * cap, and never include typed arrays. Non finite Cl and CpMin become null
 * so the model cannot quote poisoned numbers. Honesty lines name the
 * fallback, pending, and gating state in plain words.
 */
export function buildAgentContext(snapshot: AppSnapshot | null | undefined): AgentContext {
    try {
        const snap = (snapshot ?? {}) as Partial<AppSnapshot>;
        const specRaw = (snap.spec ?? {}) as Partial<GeometrySpec>;
        const valRaw = (snap.validation ?? {}) as { pass?: unknown; warn?: unknown; fail?: unknown; info?: unknown };
        const kind = typeof specRaw.kind === "string" ? specRaw.kind : "unknown";
        const alphaRaw = finiteOrNull(specRaw.alphaDeg);
        const reRaw = finiteOrNull(snap.reynolds);
        const clRaw = finiteOrNull(snap.cl);
        const cpRaw = finiteOrNull(snap.cpMin);
        const statsIn = snap.lbmStats ?? null;
        let stats: AgentLbmStats | null = null;
        let naca: AgentNacaSnapshot | null = null;
        try {
            const nacaRaw = (specRaw as { naca?: unknown }).naca as
                | { code?: unknown; m?: unknown; p?: unknown; t?: unknown }
                | null
                | undefined;
            if (kind === "naca4" && typeof nacaRaw === "object" && nacaRaw !== null) {
                const code = typeof nacaRaw.code === "string" && /^\d{4}$/.test(nacaRaw.code) ? nacaRaw.code : null;
                const m = finiteOrNull(nacaRaw.m);
                const p = finiteOrNull(nacaRaw.p);
                const t = finiteOrNull(nacaRaw.t);
                if (code !== null && m !== null && p !== null && t !== null) {
                    naca = { code, m, p, t };
                }
            }
        } catch {
            naca = null;
        }
        if (snap.lbmStatsReady === true && statsIn !== null && typeof statsIn === "object") {
            const samples = cleanStep((statsIn as LbmStats).samples);
            const step = cleanStep((statsIn as LbmStats).step);
            const recircRaw = finiteOrNull((statsIn as LbmStats).recircFraction);
            stats = {
                samples,
                step,
                recircFraction: recircRaw === null ? 0 : Math.min(1, Math.max(0, recircRaw)),
                cdMean: finiteOrNull((statsIn as LbmStats).cdMean),
                clMean: finiteOrNull((statsIn as LbmStats).clMean),
                clRms: finiteOrNull((statsIn as LbmStats).clRms),
                strouhal: finiteOrNull((statsIn as LbmStats).strouhal),
            };
        }
        const variable = typeof snap.variable === "string" ? snap.variable : "speed";
        const effectiveVariable = typeof snap.effectiveVariable === "string" ? snap.effectiveVariable : variable;
        const hasTke = snap.hasTke === true;
        const hasRecirc = snap.hasRecirc === true;
        const honesty: string[] = [];
        const effectiveFlag = snap.lbmEffective === true;
        if (alphaRaw !== null && (alphaRaw < ALPHA_MIN || alphaRaw > ALPHA_MAX)) {
            honesty.push(`Alpha ${alphaRaw.toFixed(1)} deg is outside the characterized band [${ALPHA_MIN}, ${ALPHA_MAX}] deg, coefficients are unvalidated.`);
        }
        if (snap.offline === true) {
            honesty.push("Offline mode, local templates only, no live model calls.");
        }
        if (clRaw === null || cpRaw === null) {
            honesty.push("Run metrics not finite, no lift or suction claims until a clean solve lands.");
        }
        const backendWord = typeof snap.backend === "string" ? snap.backend : "";
        if (backendWord.includes("pending")) {
            honesty.push("LBM pending, placeholder preview shown, not physics. Press Run for the viscous solve.");
        } else if (backendWord.includes("fallback") || backendWord.includes("held")) {
            honesty.push(`Fallback active (${backendWord}), numbers are held or analytic, not fresh LBM.`);
        }
        if (variable !== effectiveVariable) {
            honesty.push(`Field ${variable} unavailable on this frame, showing ${effectiveVariable} instead.`);
        }
        if (variable === "k" && !hasTke) {
            honesty.push("TKE enables after the first LBM statistics sample.");
        }
        if (variable === "recirc" && !hasRecirc) {
            honesty.push("Recirculation mask enables after the first LBM statistics sample.");
        }
        const neuralAvailable = snap.neuralAvailable === true;
        const envelopeSummary = typeof snap.neuralEnvelopeSummary === "string" && snap.neuralEnvelopeSummary.trim().length > 0
            ? snap.neuralEnvelopeSummary.trim().slice(0, 240)
            : defaultEnvelopeSummary();
        const displayedPath = typeof snap.displayedPath === "string" && snap.displayedPath.trim().length > 0
            ? snap.displayedPath.trim().slice(0, LABEL_MAX)
            : cleanLabel(snap.engine, LABEL_MAX, "analytic");
        if (alphaRaw !== null && reRaw !== null) {
            const nacaCode = (specRaw as { naca?: { code?: unknown } }).naca?.code;
            const token = neuralBodyToken(kind, nacaCode);
            const verdict = classifyNeuralDomain(token, alphaRaw, reRaw);
            if (!verdict.inDomain && verdict.reason !== null) {
                honesty.push(`Outside the provisional neural envelope (${verdict.reason}). Analytic path serves this case.`);
            }
        }
        const trimmedHonesty = honesty
            .map((line) => (line.length > HONESTY_MAX_CHARS ? `${line.slice(0, HONESTY_MAX_CHARS - 3)}...` : line))
            .slice(0, HONESTY_MAX_LINES);
        const ctx: AgentContext = {
            spec: {
                kind,
                alphaDeg: alphaRaw === null ? null : round4(alphaRaw),
                reynolds: reRaw === null ? null : Math.round(reRaw),
                naca,
            },
            reynolds: reRaw === null ? null : Math.round(reRaw),
            regime: cleanLabel(snap.regime, LABEL_MAX, "unknown regime"),
            bodyLabel: cleanLabel(snap.bodyLabel, LABEL_MAX, "unknown body"),
            alphaDeg: alphaRaw === null ? null : round4(alphaRaw),
            backend: cleanLabel(snap.backend, LABEL_MAX, "unknown backend"),
            engine: cleanLabel(snap.engine, LABEL_MAX, "analytic"),
            gridLabel: cleanLabel(snap.gridLabel, LABEL_MAX, "unknown grid"),
            cl: clRaw === null ? null : round4(clRaw),
            cpMin: cpRaw === null ? null : round4(cpRaw),
            lbm: {
                status: cleanLabel(snap.lbmStatus, LABEL_MAX, "idle"),
                hasSnapshot: snap.lbmHasSnapshot === true,
                effective: effectiveFlag,
                statsReady: snap.lbmStatsReady === true,
                stats,
            },
            field: {
                variable: variable as FieldMode,
                effective: effectiveVariable as FieldMode,
                hasTke,
                hasRecirc,
            },
            validation: {
                pass: cleanCount(valRaw.pass),
                warn: cleanCount(valRaw.warn),
                fail: cleanCount(valRaw.fail),
                info: cleanCount(valRaw.info),
            },
            provenanceLabel: cleanLabel(snap.provenanceLabel, PROVENANCE_MAX, "unknown provenance"),
            offline: snap.offline === true,
            honesty: trimmedHonesty,
            neural: {
                available: neuralAvailable,
                envelope: envelopeSummary,
                path: displayedPath,
            },
        };
        try {
            let size = JSON.stringify(ctx).length;
            while (size > CONTEXT_CHAR_BUDGET && ctx.honesty.length > 0) {
                ctx.honesty.pop();
                size = JSON.stringify(ctx).length;
            }
        } catch {
            ctx.honesty = [];
        }
        return ctx;
    } catch {
        return {
            spec: { kind: "unknown", alphaDeg: null, reynolds: null, naca: null },
            reynolds: null,
            regime: "unknown regime",
            bodyLabel: "unknown body",
            alphaDeg: null,
            backend: "unknown backend",
            engine: "analytic",
            gridLabel: "unknown grid",
            cl: null,
            cpMin: null,
            lbm: { status: "idle", hasSnapshot: false, effective: false, statsReady: false, stats: null },
            field: { variable: "speed", effective: "speed", hasTke: false, hasRecirc: false },
            validation: { pass: 0, warn: 0, fail: 0, info: 0 },
            provenanceLabel: "unknown provenance",
            offline: false,
            honesty: ["Agent context unavailable, showing defaults."],
            neural: { available: false, envelope: defaultEnvelopeSummary(), path: "analytic" },
        };
    }
}
