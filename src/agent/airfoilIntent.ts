// R1 airfoil intent parser. Pure, never throws. Reads a free text request
// plus the current section and returns an apply (code plus alpha plus Re),
// a clarify (question plus candidates, never auto-applied), or null (plain
// mention or question with no action). Bare 4-digit codes need an action
// verb (set, show, use, try, generate, run, switch, apply, make, test,
// simulate) or naca/airfoil keyword context, else null. Question guards
// (what is, why, explain, compare, vs, and between two codes) return null.
// Five digit codes always clarify per user policy, never auto-fix, even
// for duplicate digit typos like 24112. Camber and thickness edits apply
// absolute (15 percent thick, 2% camber, symmetric sets m to 0) or relative
// (thicker/thinner shifts t by 0.02, more/less camber shifts m by 0.01).

import { isSchemaValidCode, parseNacaLoose } from "./nacaParse";
import type { AgentAction } from "@/contracts/types";

export interface AirfoilIntentContext {
    code?: string | null;
    alphaDeg?: number | null;
    reynolds?: number | null;
}

export interface AirfoilApply {
    kind: "apply";
    /** Resolved 4-digit code, or null when only alpha/Re change. */
    code: string | null;
    alphaDeg: number | null;
    reynolds: number | null;
    confidence: number;
    corrections: string[];
    notes: string[];
}

export interface AirfoilClarify {
    kind: "clarify";
    question: string;
    candidates: string[];
    corrections: string[];
    notes: string[];
}

export type AirfoilIntentResult = AirfoilApply | AirfoilClarify;

/** Bare codes only apply beside one of these verbs, else they are mentions. */
export const ACTION_VERBS: ReadonlyArray<string> = [
    "set",
    "show",
    "use",
    "try",
    "generate",
    "run",
    "switch",
    "apply",
    "make",
    "test",
    "simulate",
];

const QUESTION_RE = /\bwhat\s+is\b|\bwhat'?s\b|\bwhy\b|\bexplain\b|\bcompar\w*|\bversus\b|\bvs\.?(?!\w)/i;
const ALPHA_KEY_RE = /(?:alpha|aoa)(?:\s+of\s+attack)?[^-\d]{0,8}(-?\d+(?:\.\d+)?)/i;
const ALPHA_DEG_RE = /(-?\d+(?:\.\d+)?)\s*(?:degrees?|deg|°)/i;
const RE_RE = /\bre(?:ynolds)?(?:\s*(?:number|value|of|at|to|=|:))?\s*(\d[\d,]*(?:\.\d+)?(?:e[+-]?\d+)?)\s*([kKmM])?(?![\w])/i;
const THICK_PCT_RE = /(\d+(?:\.\d+)?)\s*(?:%|percent)\s*(?:thick(?:ness)?)/i;
const THICK_OF_RE = /\bthick(?:ness)?\s*(?:of\s*)?(\d+(?:\.\d+)?)\s*(?:%|percent)/i;
const CAMBER_PCT_RE = /(\d+(?:\.\d+)?)\s*(?:%|percent)\s*camber/i;
const SYMMETRIC_RE = /\bsymmetric(?:al)?\b/i;
const THICKER_RE = /\bthicker\b/i;
const THINNER_RE = /\bthinner\b/i;
const MORE_CAMBER_RE = /\bmore\s+camber\b/i;
const LESS_CAMBER_RE = /\bless\s+camber\b/i;

export interface ShapeMods {
    thicknessPct: number | null;
    camberPct: number | null;
    symmetric: boolean;
    thicker: boolean;
    thinner: boolean;
    moreCamber: boolean;
    lessCamber: boolean;
}

export function parseShapeMods(lower: string): ShapeMods {
    const thickA = lower.match(THICK_PCT_RE);
    const thickB = thickA === null ? lower.match(THICK_OF_RE) : null;
    const camber = lower.match(CAMBER_PCT_RE);
    return {
        thicknessPct: thickA !== null ? Number(thickA[1]) : thickB !== null ? Number(thickB[1]) : null,
        camberPct: camber !== null ? Number(camber[1]) : null,
        symmetric: SYMMETRIC_RE.test(lower),
        thicker: THICKER_RE.test(lower),
        thinner: THINNER_RE.test(lower),
        moreCamber: MORE_CAMBER_RE.test(lower),
        lessCamber: LESS_CAMBER_RE.test(lower),
    };
}

export function hasShapeMods(mods: ShapeMods): boolean {
    return (
        mods.thicknessPct !== null ||
        mods.camberPct !== null ||
        mods.symmetric ||
        mods.thicker ||
        mods.thinner ||
        mods.moreCamber ||
        mods.lessCamber
    );
}

/** Angle of attack from alpha/aoa keywords, deg/degrees words, or the degree symbol. */
export function parseAlphaDeg(text: unknown): number | null {
    try {
        if (typeof text !== "string") return null;
        const keyed = text.match(ALPHA_KEY_RE);
        if (keyed !== null) {
            const v = Number(keyed[1]);
            return Number.isFinite(v) ? v : null;
        }
        const deg = text.match(ALPHA_DEG_RE);
        if (deg !== null) {
            const v = Number(deg[1]);
            return Number.isFinite(v) ? v : null;
        }
        return null;
    } catch {
        return null;
    }
}

/** Reynolds number: reynolds keyword with k/m suffix, e notation, and commas. */
export function parseReynolds(text: unknown): number | null {
    try {
        if (typeof text !== "string") return null;
        const m = text.match(RE_RE);
        if (m === null) return null;
        let v = Number(m[1].replace(/,/g, ""));
        if (!Number.isFinite(v)) return null;
        const suffix = m[2];
        if (suffix === "k" || suffix === "K") v *= 1e3;
        else if (suffix === "m" || suffix === "M") v *= 1e6;
        return Math.round(v);
    } catch {
        return null;
    }
}

function normalizeCurrentCode(raw: unknown): string | null {
    if (typeof raw !== "string") return null;
    const m = raw.match(/(\d{4})(?!\d)/);
    if (m === null) return null;
    return isSchemaValidCode(m[1]).ok ? m[1] : null;
}

function applyModsToFractions(
    base: { m: number; p: number; t: number },
    mods: ShapeMods
): { m: number; p: number; t: number } | null {
    let { m, p, t } = base;
    if (mods.thicknessPct !== null) t = mods.thicknessPct / 100;
    if (mods.camberPct !== null) m = mods.camberPct / 100;
    if (mods.symmetric) {
        m = 0;
        p = 0;
    }
    if (mods.thicker) t += 0.02;
    if (mods.thinner) t -= 0.02;
    if (mods.moreCamber) m += 0.01;
    if (mods.lessCamber) m -= 0.01;
    if (!(t > 0) || t > 0.4) return null;
    if (m < 0) m = 0;
    if (m > 0.09) m = 0.09;
    // Symmetric sections carry p 0, so a camber increase from 0012 would
    // digitize to 1012 and fail validation with a thickness blame note.
    // Default the peak to mid chord when camber rises from zero.
    if (m > 1e-10 && p <= 1e-10) p = 0.4;
    return { m, p, t };
}

function digitsFromFractions(m: number, p: number, t: number): string {
    const mD = Math.max(0, Math.min(9, Math.round(m * 100)));
    const pD = Math.max(0, Math.min(9, Math.round(p * 10)));
    const tD = Math.max(1, Math.min(40, Math.round(t * 100)));
    return `${mD}${pD}${String(tD).padStart(2, "0")}`;
}

function reshapeFailedNote(code: string): string {
    return (
        `That reshape of NACA ${code} falls outside the 4-digit family ` +
        `(thickness must stay within 1 to 40% chord). ` +
        `Which 4-digit code should I use instead (try 0012, 2412, or 4412)?`
    );
}

function scoreConfidence(o: { explicit: boolean; verb: boolean; alpha: boolean; re: boolean; mods: boolean; typo: boolean }): number {
    let c = 0.5;
    if (o.explicit) c += 0.2;
    if (o.verb) c += 0.1;
    if (o.alpha) c += 0.05;
    if (o.re) c += 0.05;
    if (o.mods) c += 0.05;
    if (o.typo) c -= 0.1;
    return Math.max(0.05, Math.min(0.95, Math.round(c * 100) / 100));
}

/**
 * Parse an airfoil intent. Returns apply, clarify, or null (mention or
 * question, never an action). Clarify never carries a code to apply.
 * Never throws.
 */
export function parseAirfoilIntent(
    text: unknown,
    current?: AirfoilIntentContext | null
): AirfoilIntentResult | null {
    try {
        if (typeof text !== "string") return null;
        const lower = text.toLowerCase();
        if (lower.trim().length === 0) return null;
        if (QUESTION_RE.test(lower)) return null;
        const parsed = parseNacaLoose(text);
        const corrections = [...parsed.corrections];
        const alphaDeg = parseAlphaDeg(text);
        const reynolds = parseReynolds(text);
        const mods = parseShapeMods(lower);
        const modded = hasShapeMods(mods);
        const hasVerb = ACTION_VERBS.some((v) => new RegExp(`\\b${v}\\b`).test(lower));
        const typo = corrections.length > 0;
        if (parsed.status === "ambiguous") {
            if (parsed.kind === "five-digit") {
                return { kind: "clarify", question: parsed.question, candidates: parsed.candidates, corrections, notes: [] };
            }
            if (/\band\b|\bor\b/.test(lower)) return null;
            return { kind: "clarify", question: parsed.question, candidates: parsed.candidates, corrections, notes: [] };
        }
        if (parsed.status === "invalid") {
            const candidates = parsed.nearest === null ? [] : [parsed.nearest];
            const base = parsed.code === null ? "That code" : `NACA ${parsed.code}`;
            const hint = candidates.length > 0 ? ` Did you mean NACA ${candidates[0]}?` : "";
            return {
                kind: "clarify",
                question: `${base} is not a valid 4-digit section (${parsed.reason}).${hint} Reply with a valid 4-digit code (try 0012, 2412, or 4412).`,
                candidates,
                corrections,
                notes: [],
            };
        }
        if (parsed.status === "ok") {
            if (!parsed.explicit && !hasVerb) return null;
            const base = isSchemaValidCode(parsed.code);
            if (!base.ok) return null;
            let code = parsed.code;
            if (modded) {
                const next = applyModsToFractions({ m: base.m, p: base.p, t: base.t }, mods);
                if (next === null) {
                    return { kind: "clarify", question: reshapeFailedNote(parsed.code), candidates: [], corrections, notes: [] };
                }
                code = digitsFromFractions(next.m, next.p, next.t);
            }
            const check = isSchemaValidCode(code);
            if (!check.ok) {
                return { kind: "clarify", question: reshapeFailedNote(parsed.code), candidates: [], corrections, notes: [] };
            }
            const notes: string[] = [];
            if (check.note !== null) notes.push(check.note);
            return {
                kind: "apply",
                code,
                alphaDeg,
                reynolds,
                confidence: scoreConfidence({ explicit: parsed.explicit, verb: hasVerb, alpha: alphaDeg !== null, re: reynolds !== null, mods: modded, typo }),
                corrections,
                notes,
            };
        }
        if (modded) {
            const baseCode = normalizeCurrentCode(current?.code);
            if (baseCode === null) {
                return {
                    kind: "clarify",
                    question: "Which airfoil should I reshape? Reply with a NACA 4-digit code (try 0012, 2412, or 4412).",
                    candidates: [],
                    corrections,
                    notes: [],
                };
            }
            const base = isSchemaValidCode(baseCode);
            if (!base.ok) return null;
            const next = applyModsToFractions({ m: base.m, p: base.p, t: base.t }, mods);
            if (next === null) {
                return { kind: "clarify", question: reshapeFailedNote(baseCode), candidates: [], corrections, notes: [] };
            }
            const code = digitsFromFractions(next.m, next.p, next.t);
            const check = isSchemaValidCode(code);
            if (!check.ok) {
                return { kind: "clarify", question: reshapeFailedNote(baseCode), candidates: [], corrections, notes: [] };
            }
            const notes: string[] = [];
            if (check.note !== null) notes.push(check.note);
            return {
                kind: "apply",
                code,
                alphaDeg,
                reynolds,
                confidence: scoreConfidence({ explicit: false, verb: hasVerb, alpha: alphaDeg !== null, re: reynolds !== null, mods: true, typo }),
                corrections,
                notes,
            };
        }
        if (alphaDeg !== null || reynolds !== null) {
            return { kind: "apply", code: null, alphaDeg, reynolds, confidence: 0.5, corrections, notes: [] };
        }
        return null;
    } catch {
        return null;
    }
}

/** Body tokens the console select carries. Any other valid 4-digit code
 *  travels as a full set_spec instead, per the prompt contract. */
const CANONICAL_CONSOLE_BODIES: ReadonlySet<string> = new Set(["naca0012", "naca2412", "naca4412"]);

/** Live section the envelope fills missing alpha and Re from. */
export interface AirfoilEnvelopeContext {
    alphaDeg?: number | null;
    reynolds?: number | null;
}

/** Parser envelope for the console fast path. Candidates are unvalidated
 *  primitives in apply order: the caller rechecks each through
 *  validateAgentAction and settles the survivors through the shared path.
 *  Canonical NACA codes ride set_body, every other valid code rides one
 *  set_spec carrying the full parametric geometry plus rationale. Never
 *  throws. */
export interface AirfoilEnvelope {
    reply: string;
    candidates: AgentAction[];
    corrections: string[];
    notes: string[];
}

export function buildAirfoilEnvelope(
    apply: AirfoilApply,
    current?: AirfoilEnvelopeContext | null
): AirfoilEnvelope {
    try {
        const corrections = [...apply.corrections];
        const notes = [...apply.notes];
        const candidates: AgentAction[] = [];
        const parts: string[] = [];
        const alphaHere = apply.alphaDeg;
        const reHere = apply.reynolds === null ? null : Math.round(apply.reynolds);
        const curAlpha = typeof current?.alphaDeg === "number" && Number.isFinite(current.alphaDeg) ? current.alphaDeg : null;
        const curRe = typeof current?.reynolds === "number" && Number.isFinite(current.reynolds) ? Math.round(current.reynolds) : null;
        if (apply.code !== null) {
            const check = isSchemaValidCode(apply.code);
            if (check.ok) {
                const token = `naca${check.code}`;
                if (CANONICAL_CONSOLE_BODIES.has(token)) {
                    candidates.push({ kind: "set_body", body: token as AgentAction extends { kind: "set_body"; body: infer B } ? B : never });
                } else {
                    // Non console bodies ride one set_spec carrying alpha and
                    // Re inside, so the body never applies without its flow
                    // condition. Separate alpha and Re actions are skipped on
                    // this branch to avoid a double apply.
                    const alpha = alphaHere ?? curAlpha ?? 6;
                    const reynolds = reHere ?? curRe ?? 50000;
                    candidates.push({
                        kind: "set_spec",
                        spec: {
                            geometry: {
                                kind: "naca4",
                                naca: { code: check.code, m: check.m, p: check.p, t: check.t },
                                chord: 1,
                                alphaDeg: alpha,
                                nPoints: 120,
                            },
                            reynolds,
                            rationale: `Parser apply for NACA ${check.code}.`,
                        },
                    });
                    if (alphaHere !== null) parts.push(`alpha ${alphaHere}`);
                    if (reHere !== null) parts.push(`Re ${reHere}`);
                }
                parts.push(`NACA ${check.code}`);
            }
        }
        const carriedBySpec = candidates.length === 1 && candidates[0].kind === "set_spec";
        if (alphaHere !== null && !carriedBySpec) {
            candidates.push({ kind: "set_alpha", alphaDeg: alphaHere });
            parts.push(`alpha ${alphaHere}`);
        }
        if (reHere !== null && !carriedBySpec) {
            candidates.push({ kind: "set_reynolds", reynolds: reHere });
            parts.push(`Re ${reHere}`);
        }
        const head = parts.length > 0 ? `Applying ${parts.join(", ")}.` : "Applying the parsed airfoil edit.";
        const tail = notes.length > 0 ? ` ${notes.join(" ")}` : "";
        const typo = corrections.length > 0 ? ` Note: ${corrections.join("; ")}.` : "";
        const reply = `${head} Canvas updates on apply.${tail}${typo}`;
        return { reply, candidates, corrections, notes };
    } catch {
        return { reply: "Parser envelope unreadable, canvas unchanged.", candidates: [], corrections: [], notes: [] };
    }
}
