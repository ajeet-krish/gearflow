// Phase 25E block intent parser. Pure, never throws. Reads free text for
// square, rectangle, rectangular, block, square cylinder, square-cylinder
// requests plus dimensions, alpha, and Re, and returns one validated
// set_spec apply (never a partial shape). Dimensions resolve from explicit
// width/height, side/size, or a by/x pair; a lone square side applies to
// both axes. Question guards (what is, why, explain, compare, vs) and
// negation guards (do not, never, no square) return null. Bare mentions
// with no size return null so no default settles at high confidence.
// Alpha and Re reuse the airfoil intent regexes so block and airfoil
// coupling agree. Values clamp to the schema envelopes with notes,
// the candidate is rechecked through validateParametricSpec, and only a
// fully valid spec returns apply. Mention-only text returns null.

import { EXTENT_MAX, RE_MAX, RE_MIN, ALPHA_HARD_MAX, ALPHA_HARD_MIN, validateParametricSpec } from "@/contracts/schema";
import type { AgentAction } from "@/contracts/types";
import { parseAlphaDeg, parseReynolds } from "./airfoilIntent";

export interface BlockIntentContext {
    alphaDeg?: number | null;
    reynolds?: number | null;
}

export interface BlockApply {
    kind: "apply";
    width: number;
    height: number;
    alphaDeg: number | null;
    reynolds: number | null;
    confidence: number;
    corrections: string[];
    notes: string[];
}

const BLOCK_TRIGGER_RE = /\bsquare\b|\brectangle\b|\brectangular\b|\bblock\b|square[\s_-]*cylinder/;
const QUESTION_RE = /\bwhat\s+is\b|\bwhat'?s\b|\bwhy\b|\bexplain\b|\bcompar\w*|\bversus\b|\bvs\.?(?!\w)/i;
const NEGATION_RE = /\bdo\s+not\b|\bdon'?t\b|\bnever\b|\bno\s+(?:square|rectangle|rectangular|block)\b|\bnot\s+a\s+(?:square|rectangle|rectangular|block)\b/i;
const WIDTH_RE = /\bwidth\s*(?:of\s*|is\s*|=\s*|:?\s*)(\d+(?:\.\d+)?)/i;
const HEIGHT_RE = /\bheight\s*(?:of\s*|is\s*|=\s*|:?\s*)(\d+(?:\.\d+)?)/i;
const SIDE_RE = /\b(?:side|size|edge)\s*(?:of\s*|is\s*|=\s*|:?\s*)(\d+(?:\.\d+)?)/i;
const BY_PAIR_RE = /(\d+(?:\.\d+)?)\s*(?:by|x|\u00d7)\s*(\d+(?:\.\d+)?)/i;
const NUMBER_RE = /(\d+(?:\.\d+)?)/g;

const BLOCK_EXTENT_MIN = 0.1;

function clampExtent(v: number): number {
    if (!Number.isFinite(v)) return 0.5;
    if (v < BLOCK_EXTENT_MIN) return BLOCK_EXTENT_MIN;
    if (v > EXTENT_MAX) return EXTENT_MAX;
    return v;
}

function finiteOrNull(v: unknown): number | null {
    return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Parse a block intent. Returns an apply with a complete block shape, or
 * null when the text is not a block request. Never throws.
 */
export function parseBlockIntent(
    text: unknown,
    current?: BlockIntentContext | null
): BlockApply | null {
    try {
        if (typeof text !== "string") return null;
        const lower = text.toLowerCase();
        if (lower.trim().length === 0) return null;
        if (QUESTION_RE.test(lower)) return null;
        if (NEGATION_RE.test(lower)) return null;
        if (!BLOCK_TRIGGER_RE.test(lower)) return null;
        const widthMatch = text.match(WIDTH_RE);
        const heightMatch = text.match(HEIGHT_RE);
        const sideMatch = text.match(SIDE_RE);
        const pairMatch = text.match(BY_PAIR_RE);
        let width: number | null = null;
        let height: number | null = null;
        const corrections: string[] = [];
        const notes: string[] = [];
        if (widthMatch !== null) {
            const v = Number(widthMatch[1]);
            if (Number.isFinite(v)) width = v;
        }
        if (heightMatch !== null) {
            const v = Number(heightMatch[1]);
            if (Number.isFinite(v)) height = v;
        }
        if (width === null && height === null && sideMatch !== null) {
            const v = Number(sideMatch[1]);
            if (Number.isFinite(v)) {
                width = v;
                height = v;
            }
        }
        if (width === null && height === null && pairMatch !== null) {
            const a = Number(pairMatch[1]);
            const b = Number(pairMatch[2]);
            if (Number.isFinite(a) && Number.isFinite(b)) {
                width = a;
                height = b;
            }
        }
        if (width === null && height === null) {
            // Lone square side applies to both axes. A bare square mention
            // with no size returns null so the rescue path cannot settle a
            // defaulted shape at high confidence.
            if (/\bsquare\b/.test(lower)) {
                const nums: number[] = [];
                for (const m of text.matchAll(NUMBER_RE)) {
                    const v = Number(m[1]);
                    if (Number.isFinite(v)) nums.push(v);
                }
                // Filter out numbers that belong to alpha or Re phrases.
                const alphaHere = parseAlphaDeg(text);
                const reHere = parseReynolds(text);
                const filtered = nums.filter((n) => {
                    if (alphaHere !== null && n === alphaHere) return false;
                    if (reHere !== null && (n === reHere || n === reHere / 1000 || n === reHere / 1000000)) return false;
                    if (n > EXTENT_MAX * 4) return false;
                    return true;
                });
                if (filtered.length > 0) {
                    const side = filtered[0];
                    width = side;
                    height = side;
                } else {
                    return null;
                }
            } else {
                return null;
            }
        }
        if (width !== null && height === null) {
            height = width as number;
            notes.push(`Note: lone width ${width} mirrored to height (no height named), a rectangular section keeps both axes.`);
        } else if (width === null && height !== null) {
            width = height as number;
            notes.push(`Note: lone height ${height} mirrored to width (no width named), a rectangular section keeps both axes.`);
        }
        if (width === null || height === null) return null;
        const rawWidth = width;
        const rawHeight = height;
        width = clampExtent(width);
        height = clampExtent(height);
        if (width !== rawWidth) {
            notes.push(`Note: width ${rawWidth} clamped to ${width} for the rectangular section, a narrower section speeds the flow like a venturi.`);
            corrections.push(`width clamped from ${rawWidth} to ${width}`);
        }
        if (height !== rawHeight) {
            notes.push(`Note: height ${rawHeight} clamped to ${height} for the rectangular section, a narrower section speeds the flow like a venturi.`);
            corrections.push(`height clamped from ${rawHeight} to ${height}`);
        }
        const alphaRaw = parseAlphaDeg(text);
        const reRaw = parseReynolds(text);
        const curAlpha = finiteOrNull(current?.alphaDeg);
        const curRe = finiteOrNull(current?.reynolds);
        const alphaBase = alphaRaw ?? curAlpha ?? 0;
        const clampedAlpha = Math.min(Math.max(alphaBase, ALPHA_HARD_MIN), ALPHA_HARD_MAX);
        if (alphaRaw !== null && clampedAlpha !== alphaRaw) {
            notes.push(`Note: alpha ${alphaRaw} clamped to ${clampedAlpha} (envelope [${ALPHA_HARD_MIN}, ${ALPHA_HARD_MAX}]).`);
        }
        const reBase = reRaw === null ? (curRe === null ? 50000 : Math.round(curRe)) : Math.round(reRaw);
        const clampedRe = Math.min(Math.max(reBase, RE_MIN), RE_MAX);
        if (clampedRe !== reBase) {
            notes.push(`Note: Re ${reBase} clamped to ${clampedRe} (envelope [${RE_MIN}, ${RE_MAX}]).`);
        }
        const alphaDeg = alphaRaw === null && curAlpha === null ? null : clampedAlpha;
        const reynolds = reRaw === null && curRe === null ? null : clampedRe;
        // Validate the full spec before returning apply, so the caller never
        // settles a partial rectangular section.
        try {
            validateParametricSpec({
                geometry: {
                    kind: "block",
                    chord: 1,
                    alphaDeg: alphaDeg ?? 0,
                    nPoints: 120,
                    width,
                    height,
                    center: { x: 0.5, y: 0 },
                },
                reynolds: reynolds ?? 50000,
                rationale: `Agent setup Rectangle ${width} by ${height}.`,
            });
        } catch {
            return null;
        }
        return {
            kind: "apply",
            width,
            height,
            alphaDeg,
            reynolds,
            confidence: 0.92,
            corrections,
            notes,
        };
    } catch {
        return null;
    }
}

/** Live section the envelope fills missing alpha and Re from. */
export interface BlockEnvelopeContext {
    alphaDeg?: number | null;
    reynolds?: number | null;
}

/** Parser envelope for the console rescue path. One validated set_spec
 *  carrying the full block geometry plus alpha plus Re plus rationale, so
 *  the body never applies without its flow condition. Never throws. */
export interface BlockEnvelope {
    reply: string;
    candidates: AgentAction[];
    corrections: string[];
    notes: string[];
}

export function buildBlockEnvelope(
    apply: BlockApply,
    current?: BlockEnvelopeContext | null
): BlockEnvelope {
    try {
        const corrections = [...apply.corrections];
        const notes = [...apply.notes];
        const curAlpha = typeof current?.alphaDeg === "number" && Number.isFinite(current.alphaDeg) ? current.alphaDeg : null;
        const curRe = typeof current?.reynolds === "number" && Number.isFinite(current.reynolds) ? Math.round(current.reynolds) : null;
        const alpha = apply.alphaDeg ?? curAlpha ?? 0;
        const reynolds = apply.reynolds ?? curRe ?? 50000;
        const candidates: AgentAction[] = [
            {
                kind: "set_spec",
                spec: {
                    geometry: {
                        kind: "block",
                        chord: 1,
                        alphaDeg: alpha,
                        nPoints: 120,
                        width: apply.width,
                        height: apply.height,
                        center: { x: 0.5, y: 0 },
                    },
                    reynolds,
                    rationale: `Agent setup Rectangle ${apply.width} by ${apply.height}.`,
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
            return { reply: "Parser rectangular section envelope unreadable, canvas unchanged.", candidates: [], corrections, notes };
        }
        const parts: string[] = [`Rectangle ${apply.width} by ${apply.height}`];
        if (apply.alphaDeg !== null) parts.push(`alpha ${apply.alphaDeg}`);
        if (apply.reynolds !== null) parts.push(`Re ${apply.reynolds}`);
        const tail = notes.length > 0 ? ` ${notes.join(" ")}` : "";
        const reply = `Applying ${parts.join(", ")}, the canvas updates on apply.${tail}`;
        return { reply, candidates, corrections, notes };
    } catch {
        return { reply: "Parser rectangular section envelope unreadable, canvas unchanged.", candidates: [], corrections: [], notes: [] };
    }
}
