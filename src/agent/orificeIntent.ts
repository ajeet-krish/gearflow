// Orifice intent parser. Pure, never throws. Reads free text for orifice,
// venturi, throat, constriction, and tunnel requests plus an optional gap
// or plate size plus Re, and returns one validated set_spec apply carrying
// the full orifice shape (width plate thickness 0.08 default, height gap
// opening 0.4 default, alphaDeg always 0 because the plate has no angle of
// attack). Question guards (what is, why, explain, compare, vs) and
// negation guards (do not, never, no orifice) return null, mirroring
// blockIntent, so definitional or declined orifice talk falls through to
// teaching. Bare mentions with no action verb and no size still apply when
// the orifice token is explicit (set up the orifice), settling on the
// gap and width defaults with high confidence. Values clamp to the schema
// envelopes with notes, the candidate is rechecked through
// validateParametricSpec, and only a fully valid spec returns apply.
// Never mentions canvas limits, the copy stays purely physical (a narrower
// gap speeds the flow like a venturi).

import { ORIFICE_GAP_DEFAULT, ORIFICE_GAP_MAX, ORIFICE_GAP_MIN, ORIFICE_THICKNESS_DEFAULT, ORIFICE_THICKNESS_MAX, ORIFICE_THICKNESS_MIN, RE_MAX, RE_MIN, validateParametricSpec } from "@/contracts/schema";
import type { AgentAction } from "@/contracts/types";
import { parseReynolds } from "./airfoilIntent";

export interface OrificeIntentContext {
    reynolds?: number | null;
}

export interface OrificeApply {
    kind: "apply";
    /** Plate thickness, schema envelope [0.02, 0.2], default 0.08. */
    width: number;
    /** Gap opening, schema envelope [0.05, 1.8], default 0.4. */
    height: number;
    reynolds: number | null;
    confidence: number;
    corrections: string[];
    notes: string[];
}

const ORIFICE_TRIGGER_RE = /\borifice\b|\bventuri\b|\bthroat\b|\bconstriction\b|\btunnel\b/i;
const QUESTION_RE = /\bwhat\s+is\b|\bwhat'?s\b|\bwhy\b|\bexplain\b|\bcompar\w*|\bversus\b|\bvs\.?(?!\w)/i;
const NEGATION_RE = /\bdo\s+not\b|\bdon'?t\b|\bnever\b|\bno\s+(?:orifice|venturi|throat|constriction|tunnel)\b|\bnot\s+(?:an?|the)\s+(?:orifice|venturi|throat|constriction|tunnel)\b/i;
const VERB_GATE_RE = /\b(set|setup|show|use|try|generate|run|switch|apply|make|test|simulate|change|display|put)\b/i;
const GAP_RE = /\bgap\s*(?:of\s*|is\s*|=\s*|:?\s*)(\d+(?:\.\d+)?)/i;
const THICKNESS_RE = /\b(?:thickness|plate)\s*(?:of\s*|is\s*|=\s*|:?\s*)(\d+(?:\.\d+)?)/i;

function finiteOrNull(v: unknown): number | null {
    return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function clampGap(v: number): number {
    if (!Number.isFinite(v)) return ORIFICE_GAP_DEFAULT;
    if (v < ORIFICE_GAP_MIN) return ORIFICE_GAP_MIN;
    if (v > ORIFICE_GAP_MAX) return ORIFICE_GAP_MAX;
    return v;
}

function clampThickness(v: number): number {
    if (!Number.isFinite(v)) return ORIFICE_THICKNESS_DEFAULT;
    if (v < ORIFICE_THICKNESS_MIN) return ORIFICE_THICKNESS_MIN;
    if (v > ORIFICE_THICKNESS_MAX) return ORIFICE_THICKNESS_MAX;
    return v;
}

/**
 * Parse an orifice intent. Returns an apply with the complete orifice
 * shape (alpha always 0), or null when the text is not an orifice
 * request. Never throws.
 */
export function parseOrificeIntent(
    text: unknown,
    current?: OrificeIntentContext | null
): OrificeApply | null {
    try {
        if (typeof text !== "string") return null;
        const lower = text.toLowerCase();
        if (lower.trim().length === 0) return null;
        if (QUESTION_RE.test(lower)) return null;
        if (NEGATION_RE.test(lower)) return null;
        if (!ORIFICE_TRIGGER_RE.test(lower)) return null;
        // Bare mentions only stage with an action verb, mirroring the R1
        // verb gating, so questions and plain mentions ("what is a
        // venturi") leave the canvas alone. Explicit size numbers bypass
        // the gate.
        const gapMatch = text.match(GAP_RE);
        const thickMatch = text.match(THICKNESS_RE);
        const hasSize = gapMatch !== null || thickMatch !== null;
        if (!hasSize && !VERB_GATE_RE.test(lower)) return null;
        const corrections: string[] = [];
        const notes: string[] = [];
        const rawGap = gapMatch !== null ? Number(gapMatch[1]) : ORIFICE_GAP_DEFAULT;
        const rawThick = thickMatch !== null ? Number(thickMatch[1]) : ORIFICE_THICKNESS_DEFAULT;
        const height = clampGap(rawGap);
        const width = clampThickness(rawThick);
        if (height !== rawGap) {
            notes.push(`Note: gap ${rawGap} clamped to ${height} for the orifice plate, a narrower gap speeds the flow like a venturi.`);
            corrections.push(`gap clamped from ${rawGap} to ${height}`);
        }
        if (width !== rawThick) {
            notes.push(`Note: plate thickness ${rawThick} clamped to ${width} for the orifice plate.`);
            corrections.push(`thickness clamped from ${rawThick} to ${width}`);
        }
        const reRaw = parseReynolds(text);
        const curRe = finiteOrNull(current?.reynolds);
        // Orifice default Re follows the orifice body tab memory (1000)
        // when neither the text nor the live context names one.
        const reBase = reRaw === null ? (curRe === null ? 1000 : Math.round(curRe)) : Math.round(reRaw);
        const clampedRe = Math.min(Math.max(reBase, RE_MIN), RE_MAX);
        if (clampedRe !== reBase) {
            notes.push(`Note: Re ${reBase} clamped to ${clampedRe} (envelope [${RE_MIN}, ${RE_MAX}]).`);
        }
        const reynolds = reRaw === null && curRe === null ? null : clampedRe;
        // Validate the full spec before returning apply, so the caller
        // never settles a partial orifice shape. Alpha is always 0: the
        // plate has no angle of attack.
        try {
            validateParametricSpec({
                geometry: {
                    kind: "orifice",
                    chord: 1,
                    alphaDeg: 0,
                    nPoints: 120,
                    width,
                    height,
                    center: { x: 0.5, y: 0 },
                },
                reynolds: reynolds ?? 1000,
                rationale: `Agent setup Orifice gap ${height} plate ${width}.`,
            });
        } catch {
            return null;
        }
        return {
            kind: "apply",
            width,
            height,
            reynolds,
            confidence: 0.92,
            corrections,
            notes,
        };
    } catch {
        return null;
    }
}

/** Live section the envelope fills missing Re from. */
export interface OrificeEnvelopeContext {
    reynolds?: number | null;
}

/** Parser envelope for the console rescue path. One validated set_spec
 *  carrying the full orifice geometry (alpha always 0) plus Re plus
 *  rationale, so the body never applies without its flow condition.
 *  Never throws. */
export interface OrificeEnvelope {
    reply: string;
    candidates: AgentAction[];
    corrections: string[];
    notes: string[];
}

export function buildOrificeEnvelope(
    apply: OrificeApply,
    current?: OrificeEnvelopeContext | null
): OrificeEnvelope {
    try {
        const corrections = [...apply.corrections];
        const notes = [...apply.notes];
        const curRe = typeof current?.reynolds === "number" && Number.isFinite(current.reynolds) ? Math.round(current.reynolds) : null;
        const reynolds = apply.reynolds ?? curRe ?? 1000;
        const candidates: AgentAction[] = [
            {
                kind: "set_spec",
                spec: {
                    geometry: {
                        kind: "orifice",
                        chord: 1,
                        alphaDeg: 0,
                        nPoints: 120,
                        width: apply.width,
                        height: apply.height,
                        center: { x: 0.5, y: 0 },
                    },
                    reynolds,
                    rationale: `Agent setup Orifice gap ${apply.height} plate ${apply.width}.`,
                },
            },
        ];
        const checked = (() => {
            try {
                validateParametricSpec((candidates[0] as { spec: unknown }).spec);
                return true;
            } catch {
                return false;
            }
        })();
        if (!checked) {
            return { reply: "Parser orifice envelope unreadable, canvas unchanged.", candidates: [], corrections, notes };
        }
        const parts: string[] = [`Orifice plate, gap opening ${apply.height}, plate thickness ${apply.width}`];
        if (apply.reynolds !== null) parts.push(`Re ${apply.reynolds}`);
        else parts.push(`Re ${reynolds}`);
        const tail = notes.length > 0 ? ` ${notes.join(" ")}` : "";
        const reply = `Applying ${parts.join(", ")}. A narrower gap speeds the flow like a venturi. Canvas updates on apply.${tail}`;
        return { reply, candidates, corrections, notes };
    } catch {
        return { reply: "Parser orifice envelope unreadable, canvas unchanged.", candidates: [], corrections: [], notes: [] };
    }
}
