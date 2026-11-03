// Cylinder intent parser. Pure, never throws. Reads free text for
// cylinder radius requests (radius or diameter phrasing) plus Re, and
// returns one validated set_spec apply carrying the full cylinder shape
// (alpha always 0, radius in [0.05, 1], diameter halves to radius).
// Question guards (what is, why, explain, define, compare, vs) and
// negation guards return null so glossary or declined talk falls through
// to teaching. Bare cylinder mentions with no size return null so the
// bare-body rescue owns defaulted setups; this parser only fires when an
// explicit radius or diameter number is named. Values clamp to the schema
// envelope with notes, the candidate is rechecked through
// validateParametricSpec, and only a fully valid spec returns apply.

import { CYLINDER_RADIUS_DEFAULT, CYLINDER_RADIUS_MAX, CYLINDER_RADIUS_MIN, RE_MAX, RE_MIN, validateParametricSpec } from "@/contracts/schema";
import type { AgentAction } from "@/contracts/types";
import { parseReynolds } from "./airfoilIntent";

export interface CylinderIntentContext {
    reynolds?: number | null;
}

export interface CylinderApply {
    kind: "apply";
    radius: number;
    reynolds: number | null;
    confidence: number;
    corrections: string[];
    notes: string[];
}

const CYLINDER_TRIGGER_RE = /\bcylinder\b|\bcircular\b|\bdisk\b/i;
const QUESTION_RE = /\bwhat\s+is\b|\bwhat'?s\b|\bwhy\b|\bexplain\b|\bdefine\b|\bmeaning of\b|\bcompar\w*|\bversus\b|\bvs\.?(?!\w)/i;
const NEGATION_RE = /\bdo\s+not\b|\bdon'?t\b|\bnever\b|\bno\s+cylinder\b|\bnot\s+a\s+cylinder\b/i;
const RADIUS_RE = /\bradius\s*(?:of\s*|is\s*|=\s*|:?\s*)(\d+(?:\.\d+)?)/i;
const DIAMETER_RE = /\bdiameter\s*(?:of\s*|is\s*|=\s*|:?\s*)(\d+(?:\.\d+)?)/i;
const SHORT_R_RE = /\br\s*=\s*(\d+(?:\.\d+)?)/i;

function finiteOrNull(v: unknown): number | null {
    return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function clampRadius(v: number): number {
    if (!Number.isFinite(v)) return CYLINDER_RADIUS_DEFAULT;
    if (v < CYLINDER_RADIUS_MIN) return CYLINDER_RADIUS_MIN;
    if (v > CYLINDER_RADIUS_MAX) return CYLINDER_RADIUS_MAX;
    return v;
}

/**
 * Parse a cylinder radius intent. Returns an apply with the complete
 * cylinder shape (alpha always 0), or null when the text is not an
 * explicit radius request. Never throws.
 */
export function parseCylinderIntent(
    text: unknown,
    current?: CylinderIntentContext | null
): CylinderApply | null {
    try {
        if (typeof text !== "string") return null;
        const lower = text.toLowerCase();
        if (lower.trim().length === 0) return null;
        // Explain is size tolerant: an explicit radius or diameter number
        // still parses (explain cylinder radius 0.5 applies it) so the
        // console rescue keeps the size end to end. All other question
        // guards (what is, why, define, compare, vs) still return null.
        const hasSizeNumber = RADIUS_RE.test(text) || DIAMETER_RE.test(text) || SHORT_R_RE.test(text);
        const isExplainOnly = /\bexplain\b/i.test(lower) && !/\bwhat\s+is\b|\bwhat'?s\b|\bwhy\b|\bdefine\b|\bmeaning of\b|\bcompar\w*|\bversus\b|\bvs\.?(?!\w)/i.test(lower);
        if (QUESTION_RE.test(lower) && !(isExplainOnly && hasSizeNumber)) return null;
        if (NEGATION_RE.test(lower)) return null;
        if (!CYLINDER_TRIGGER_RE.test(lower)) return null;
        const radiusMatch = text.match(RADIUS_RE);
        const diameterMatch = text.match(DIAMETER_RE);
        const shortMatch = text.match(SHORT_R_RE);
        let rawRadius: number | null = null;
        let fromDiameter = false;
        if (radiusMatch !== null) {
            const v = Number(radiusMatch[1]);
            if (Number.isFinite(v)) rawRadius = v;
        } else if (diameterMatch !== null) {
            const v = Number(diameterMatch[1]);
            if (Number.isFinite(v)) {
                rawRadius = v / 2;
                fromDiameter = true;
            }
        } else if (shortMatch !== null) {
            const v = Number(shortMatch[1]);
            if (Number.isFinite(v)) rawRadius = v;
        }
        if (rawRadius === null) return null;
        const corrections: string[] = [];
        const notes: string[] = [];
        if (fromDiameter) {
            notes.push(`Note: diameter ${diameterMatch?.[1]} halves to radius ${rawRadius} for the cylinder.`);
        }
        const radius = clampRadius(rawRadius);
        if (radius !== rawRadius) {
            notes.push(`Note: radius ${rawRadius} clamped to ${radius} (envelope [${CYLINDER_RADIUS_MIN}, ${CYLINDER_RADIUS_MAX}]).`);
            corrections.push(`radius clamped from ${rawRadius} to ${radius}`);
        }
        const reRaw = parseReynolds(text);
        const curRe = finiteOrNull(current?.reynolds);
        const reBase = reRaw === null ? (curRe === null ? 100 : Math.round(curRe)) : Math.round(reRaw);
        const clampedRe = Math.min(Math.max(reBase, RE_MIN), RE_MAX);
        if (clampedRe !== reBase) {
            notes.push(`Note: Re ${reBase} clamped to ${clampedRe} (envelope [${RE_MIN}, ${RE_MAX}]).`);
        }
        const reynolds = reRaw === null && curRe === null ? null : clampedRe;
        try {
            validateParametricSpec({
                geometry: {
                    kind: "cylinder",
                    chord: 1,
                    alphaDeg: 0,
                    nPoints: 120,
                    radius,
                    center: { x: 0.5, y: 0 },
                },
                reynolds: reynolds ?? 100,
                rationale: `Agent setup Cylinder radius ${radius}.`,
            });
        } catch {
            return null;
        }
        return {
            kind: "apply",
            radius,
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
export interface CylinderEnvelopeContext {
    reynolds?: number | null;
}

/** Parser envelope for the console rescue path. One validated set_spec
 *  carrying the full cylinder geometry (alpha always 0) plus radius plus
 *  Re plus rationale, so the body never applies without its size and flow
 *  condition. Never throws. */
export interface CylinderEnvelope {
    reply: string;
    candidates: AgentAction[];
    corrections: string[];
    notes: string[];
}

export function buildCylinderEnvelope(
    apply: CylinderApply,
    current?: CylinderEnvelopeContext | null
): CylinderEnvelope {
    try {
        const corrections = [...apply.corrections];
        const notes = [...apply.notes];
        const curRe = typeof current?.reynolds === "number" && Number.isFinite(current.reynolds) ? Math.round(current.reynolds) : null;
        const reynolds = apply.reynolds ?? curRe ?? 100;
        const candidates: AgentAction[] = [
            {
                kind: "set_spec",
                spec: {
                    geometry: {
                        kind: "cylinder",
                        chord: 1,
                        alphaDeg: 0,
                        nPoints: 120,
                        radius: apply.radius,
                        center: { x: 0.5, y: 0 },
                    },
                    reynolds,
                    rationale: `Agent setup Cylinder radius ${apply.radius}.`,
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
            return { reply: "Parser cylinder envelope unreadable, canvas unchanged.", candidates: [], corrections, notes };
        }
        const tail = notes.length > 0 ? ` ${notes.join(" ")}` : "";
        const reply = `Applying the cylinder with radius ${apply.radius} at angle of attack (alpha) 0 and Reynolds number (Re) ${reynolds}.${tail}`;
        return { reply, candidates, corrections, notes };
    } catch {
        return { reply: "Parser cylinder envelope unreadable, canvas unchanged.", candidates: [], corrections: [], notes: [] };
    }
}
