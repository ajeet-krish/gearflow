// R1 tolerant NACA 4-digit parser. Pure, never throws. Folds common typos
// (naka, ncca, airfoul, airfoyle, airfol) plus wing section and wing
// profile synonyms, collapses separators (dash, underscore, spaces, spaced
// digits like 2 4 1 2), and accepts explicit (naca plus 3 to 5 digits),
// compact (naca2412), keyword led (airfoil 4412), and suffixed (2415
// airfoil) forms. Status is ok, ambiguous, invalid, or none. Five digit
// hits always clarify with single deletion candidates, never auto-fix.
// Codes validate through parseNaca4 plus the schema envelope (m 0 to 9%,
// p 20 to 80% chord when cambered, thickness 6 to 40% chord, matching
// validateGeometrySpec) while the realistic flag follows
// the trainer band (6 to 18% thickness plus camber rules) so the tutor can
// explain shapes that mesh but fly poorly.

import { NACA_M_MAX_ENV, NACA_M_MIN, NACA_P_MAX, NACA_P_MIN, NACA_T_MAX_ENV, NACA_T_MIN, NACA_T_REALISTIC_MAX } from "@/contracts/schema";
import { parseNaca4 } from "@/geometry/parametric";

export type NacaParseStatus = "ok" | "ambiguous" | "invalid" | "none";

export interface NacaParseOk {
    status: "ok";
    code: string;
    m: number;
    p: number;
    t: number;
    realistic: boolean;
    note: string | null;
    /** True when a naca or airfoil keyword grounds the code, false for bare digits. */
    explicit: boolean;
    corrections: string[];
}

export interface NacaParseAmbiguous {
    status: "ambiguous";
    kind: "five-digit" | "multi";
    candidates: string[];
    question: string;
    explicit: boolean;
    corrections: string[];
}

export interface NacaParseInvalid {
    status: "invalid";
    code: string | null;
    reason: string;
    nearest: string | null;
    explicit: boolean;
    corrections: string[];
}

export interface NacaParseNone {
    status: "none";
    corrections: string[];
}

export type NacaParseResult = NacaParseOk | NacaParseAmbiguous | NacaParseInvalid | NacaParseNone;

/** Widened validity is parseNaca4 itself (thickness up to 40% chord). */
export interface SchemaCodeCheck {
    ok: boolean;
    code: string;
    m: number;
    p: number;
    t: number;
    realistic: boolean;
    note: string | null;
    reason: string | null;
}

/** Realistic trainer band: 6 to 18% thickness, 0 to 9% camber, peak at 20 to 80% chord. */
export function isRealisticSection(m: number, p: number, t: number): boolean {
    if (!(t >= NACA_T_MIN && t <= NACA_T_REALISTIC_MAX)) return false;
    if (!(m >= 0 && m <= NACA_M_MAX_ENV)) return false;
    if (m > 1e-10 && !(p >= NACA_P_MIN && p <= NACA_P_MAX)) return false;
    return true;
}

/** Tutor note for a valid but unrealistic section. Null when realistic. */
export function unrealisticSectionNote(code: string, m: number, p: number, t: number): string | null {
    if (isRealisticSection(m, p, t)) return null;
    const problems: string[] = [];
    if (!(t >= NACA_T_MIN && t <= NACA_T_REALISTIC_MAX)) {
        problems.push(`${Math.round(t * 100)}% thick, outside the realistic 6 to 18% band`);
    }
    if (!(m >= 0 && m <= NACA_M_MAX_ENV)) {
        problems.push(`${Math.round(m * 100)}% camber, above the realistic 0 to 9% band`);
    }
    if (m > 1e-10 && !(p >= NACA_P_MIN && p <= NACA_P_MAX)) {
        problems.push(`camber peak at ${Math.round(p * 100)}% chord, outside the realistic 20 to 80% band`);
    }
    const detail = problems.length > 0 ? ` (${problems.join("; ")})` : "";
    return (
        `NACA ${code} is valid but not a realistic trainer shape${detail}. ` +
        `It still meshes, but expect draggy, unvalidated coefficients. ` +
        `A textbook trainer uses 12 to 15% thickness with 2 to 4% camber (try 2412 or 4412).`
    );
}

/**
 * Validate one 4-digit code. Accepts the schema envelope (m 0 to 9% camber,
 * p 0.2 to 0.8 when cambered, thickness 6 to 40% chord, matching
 * validateGeometrySpec) and marks realistic false outside the 6 to 18%
 * trainer band or the camber rules so the tutor can explain shapes that
 * mesh but fly poorly. Never throws.
 */
export function isSchemaValidCode(code: unknown): SchemaCodeCheck {
    const label = typeof code === "string" ? code : String(code);
    try {
        if (typeof code !== "string" || !/^\d{4}$/.test(code)) {
            return { ok: false, code: label, m: 0, p: 0, t: 0, realistic: false, note: null, reason: `NACA code must be 4 digits, got ${label}` };
        }
        const { m, p, t } = parseNaca4(code);
        if (!(m >= NACA_M_MIN && m <= NACA_M_MAX_ENV)) {
            return { ok: false, code: label, m: 0, p: 0, t: 0, realistic: false, note: null, reason: `NACA ${code} camber ${Math.round(m * 100)}% outside the schema 0 to 9% band` };
        }
        if (m > 1e-10 && !(p >= NACA_P_MIN && p <= NACA_P_MAX)) {
            return { ok: false, code: label, m: 0, p: 0, t: 0, realistic: false, note: null, reason: `NACA ${code} camber peak ${Math.round(p * 100)}% chord outside the schema 20 to 80% band` };
        }
        if (!(t >= NACA_T_MIN && t <= NACA_T_MAX_ENV)) {
            return { ok: false, code: label, m: 0, p: 0, t: 0, realistic: false, note: null, reason: `NACA ${code} thickness ${Math.round(t * 100)}% outside the schema 6 to 40% band` };
        }
        const realistic = isRealisticSection(m, p, t);
        return { ok: true, code, m, p, t, realistic, note: realistic ? null : unrealisticSectionNote(code, m, p, t), reason: null };
    } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        return { ok: false, code: label, m: 0, p: 0, t: 0, realistic: false, note: null, reason };
    }
}

const EXPLICIT_RE = /\bnaca[\s\-_]*((?:\d[\s\-_]*){3,5})(?!\d)/gi;
const KEYWORD_BEFORE_RE = /\bairfoil[\s\-_]*((?:\d[\s\-_]*){3,5})(?!\d)/gi;
const SUFFIXED_RE = /(?<!\d)((?:\d[\s\-_]*){4})(?!\d)\s*airfoils?/gi;
const BARE_RE = /(?<!\d)(?:\d[\s\-_]?){4,5}(?!\d)/g;
const KEYWORD_CTX_RE = /\b(?:naca|airfoil)\b/;

const RE_EXPR_MASK = /\bre(?:ynolds)?(?:\s*(?:number|value|of|at|to|=|:))?\s*\d[\d,]*(?:\.\d+)?(?:e[+-]?\d+)?\s*[kKmM]?(?![\w])/gi;
const ALPHA_KEY_MASK = /(?:alpha|aoa)(?:\s+of\s+attack)?[^-\d]{0,8}-?\d+(?:\.\d+)?/gi;
const DEG_MASK = /-?\d+(?:\.\d+)?\s*(?:degrees?|deg|°)/gi;
const PERCENT_MASK = /\d+(?:\.\d+)?\s*(?:%|percent)/gi;

function foldAliases(lower: string, corrections: string[]): string {
    let out = lower;
    const push = (from: string, to: string, display: string): void => {
        if (out.includes(from)) corrections.push(`read "${from}" as "${display}"`);
        out = out.split(from).join(to);
    };
    push("airfoyle", "airfoil", "airfoil");
    push("airfoul", "airfoil", "airfoil");
    push("airfol", "airfoil", "airfoil");
    push("naka", "naca", "NACA");
    push("ncca", "naca", "NACA");
    if (/wing\s+sections?/.test(out)) corrections.push(`read "wing section" as "airfoil"`);
    out = out.replace(/wing\s+sections?/g, "airfoil");
    if (/wing\s+profiles?/.test(out)) corrections.push(`read "wing profile" as "airfoil"`);
    out = out.replace(/wing\s+profiles?/g, "airfoil");
    return out;
}

function collapseDigits(raw: string): string {
    return raw.replace(/[\s\-_]/g, "");
}

function maskedForBare(folded: string): string {
    let out = folded;
    for (const re of [RE_EXPR_MASK, ALPHA_KEY_MASK, DEG_MASK, PERCENT_MASK]) {
        out = out.replace(re, " ");
    }
    return out;
}

function oxfordJoin(items: string[]): string {
    if (items.length === 0) return "";
    if (items.length === 1) return items[0];
    if (items.length === 2) return `${items[0]} or ${items[1]}`;
    return `${items.slice(0, -1).join(", ")}, or ${items[items.length - 1]}`;
}

function fiveDigitQuestion(five: string, candidates: string[]): string {
    const names = candidates.slice(0, 4).map((c) => `NACA ${c}`);
    return (
        `NACA ${five} has 5 digits, and 5-digit sections are a different family, so I will not guess. ` +
        `Did you mean ${oxfordJoin(names)}? Reply with one 4-digit code.`
    );
}

function multiQuestion(codes: string[]): string {
    const names = codes.map((c) => `NACA ${c}`);
    return `I see more than one airfoil (${oxfordJoin(names)}). Which one should I set up? Reply with one 4-digit code.`;
}

function rankDeletionCandidates(five: string): string[] {
    const uniq: string[] = [];
    for (let i = 0; i < five.length; i++) {
        const cand = five.slice(0, i) + five.slice(i + 1);
        if (!uniq.includes(cand)) uniq.push(cand);
    }
    const scored = uniq.map((c, idx) => {
        const check = isSchemaValidCode(c);
        const rank = !check.ok ? 2 : check.realistic ? 0 : 1;
        return { c, idx, rank };
    });
    scored.sort((a, b) => a.rank - b.rank || a.idx - b.idx);
    return scored.map((s) => s.c);
}

/** Nearest parseable 4-digit code by single digit substitution, realistic first. */
export function nearestValidCode(bad: string): string | null {
    if (!/^\d{4}$/.test(bad)) return null;
    let best: string | null = null;
    let bestScore = Infinity;
    for (let i = 0; i < 4; i++) {
        const orig = parseInt(bad[i], 10);
        for (let d = 0; d <= 9; d++) {
            if (d === orig) continue;
            const cand = bad.slice(0, i) + String(d) + bad.slice(i + 1);
            const check = isSchemaValidCode(cand);
            if (!check.ok) continue;
            const score = (check.realistic ? 0 : 100) + Math.abs(d - orig) * 10 + i;
            if (score < bestScore) {
                bestScore = score;
                best = cand;
            }
        }
    }
    return best;
}

/**
 * Loose NACA parse. Never throws: non-string or empty input returns none,
 * and every branch returns a shaped result. Five digit hits always return
 * ambiguous with deletion candidates, never an auto-fix. Invalid codes
 * carry the reason plus the nearest valid code, never m/p/t fractions.
 */
export function parseNacaLoose(text: unknown): NacaParseResult {
    try {
        if (typeof text !== "string") return { status: "none", corrections: [] };
        const lower = text.toLowerCase();
        if (lower.trim().length === 0) return { status: "none", corrections: [] };
        const corrections: string[] = [];
        const folded = foldAliases(lower, corrections);
        const keywordCtx = KEYWORD_CTX_RE.test(folded);
        const seen: string[] = [];
        const grounded = new Set<string>();
        const add = (digits: string, isGrounded: boolean): void => {
            if (!seen.includes(digits)) seen.push(digits);
            if (isGrounded) grounded.add(digits);
        };
        for (const re of [EXPLICIT_RE, KEYWORD_BEFORE_RE]) {
            re.lastIndex = 0;
            for (const m of folded.matchAll(re)) {
                const digits = collapseDigits(m[1] ?? "");
                if (digits.length >= 3 && digits.length <= 5) add(digits, true);
            }
        }
        SUFFIXED_RE.lastIndex = 0;
        for (const m of folded.matchAll(SUFFIXED_RE)) {
            const digits = collapseDigits(m[1] ?? "");
            if (digits.length === 4) add(digits, true);
        }
        const masked = maskedForBare(folded);
        BARE_RE.lastIndex = 0;
        for (const m of masked.matchAll(BARE_RE)) {
            const digits = collapseDigits(m[0] ?? "");
            if (digits.length < 4 || digits.length > 5) continue;
            add(digits, grounded.has(digits) || keywordCtx);
        }
        const fives = seen.filter((v) => v.length === 5);
        if (fives.length > 0) {
            const five = fives[0];
            const candidates = rankDeletionCandidates(five);
            return {
                status: "ambiguous",
                kind: "five-digit",
                candidates,
                question: fiveDigitQuestion(five, candidates),
                explicit: keywordCtx || candidates.some((c) => grounded.has(c)),
                corrections,
            };
        }
        const fours = [...new Set(seen.filter((v) => v.length === 4))];
        if (fours.length >= 2) {
            return {
                status: "ambiguous",
                kind: "multi",
                candidates: fours,
                question: multiQuestion(fours),
                explicit: keywordCtx || fours.some((c) => grounded.has(c)),
                corrections,
            };
        }
        if (fours.length === 1) {
            const check = isSchemaValidCode(fours[0]);
            if (check.ok) {
                return {
                    status: "ok",
                    code: check.code,
                    m: check.m,
                    p: check.p,
                    t: check.t,
                    realistic: check.realistic,
                    note: check.note,
                    explicit: grounded.has(check.code) || keywordCtx,
                    corrections,
                };
            }
            return {
                status: "invalid",
                code: check.code,
                reason: check.reason ?? `NACA ${check.code} is not a valid 4-digit section`,
                nearest: nearestValidCode(check.code),
                explicit: grounded.has(check.code) || keywordCtx,
                corrections,
            };
        }
        const threes = seen.filter((v) => v.length === 3);
        if (threes.length > 0) {
            return {
                status: "invalid",
                code: threes[0],
                reason: `NACA ${threes[0]} has 3 digits, sections need 4 digits (try 0012, 2412, or 4412)`,
                nearest: null,
                explicit: true,
                corrections,
            };
        }
        return { status: "none", corrections };
    } catch {
        return { status: "none", corrections: [] };
    }
}
