// Intent router for the agent console. Keyword rules map plain words to one
// of five intents; anything else is plain chat. Offline templates give every
// intent a zero network reply. SPEC_WORDS also folds the R1 NACA typos
// (naka, ncca, airfoyle, airfoul, airfol) so the legacy router follows the
// shared parser, never its own regex.

import type { GeometrySpec } from "@/contracts/types";

export type IntentKind = "explain" | "spec" | "sam" | "poster" | "chat";

export interface Intent {
    kind: IntentKind;
    confidence: number;
    reason: string;
}

export interface IntentContext {
    metricsReady?: boolean;
    geometryKind?: GeometrySpec["kind"];
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Word boundary match so "thinking" never triggers "thin" and "within" never triggers "thin". */
function matchesPhrase(text: string, phrase: string): boolean {
    const pattern = phrase
        .split(/\s+/)
        .map((w) => `\\b${escapeRegExp(w)}\\b`)
        .join("\\s+");
    return new RegExp(pattern).test(text);
}

function matchesAny(text: string, words: string[]): boolean {
    return words.some((w) => matchesPhrase(text, w));
}

const EXPLAIN_WORDS = ["explain", "why", "what happened", "interpret", "read the run", "engineer"];
const SPEC_WORDS = ["thicken", "thicker", "thin", "camber", "alpha", "angle", "reynolds", "naca", "propose", "spec", "design point", "redesign", "suggest a change", "high lift", "naka", "ncca", "airfoyle", "airfoul", "airfol"];
const SAM_WORDS = ["segment", "sketch", "draw", "outline", "trace", "polygon from"];
const POSTER_WORDS = ["poster", "image", "render", "illustration", "figure for"];

/**
 * Route free text to an intent. Keyword rules run in priority order:
 * explain first (read the current run), then spec (propose a change), then
 * sam (sketch to shape), then poster (illustrated render), else chat.
 * Matching is word boundary based so substrings inside larger words never
 * fire. The optional context tunes confidence: missing metrics lowers
 * explain confidence, a custom body raises sam confidence.
 */
export function routeIntent(text: string, ctx?: IntentContext): Intent {
    const lower = text.toLowerCase();
    if (matchesAny(lower, EXPLAIN_WORDS)) {
        const ready = ctx?.metricsReady ?? true;
        return {
            kind: "explain",
            confidence: ready ? 0.8 : 0.4,
            reason: ready
                ? "Explanation keywords (explain, why, engineer)."
                : "Explanation keywords but run metrics are not ready.",
        };
    }
    if (matchesAny(lower, SPEC_WORDS)) {
        return { kind: "spec", confidence: 0.8, reason: "Design keywords (thicken, camber, alpha, spec)." };
    }
    if (matchesAny(lower, SAM_WORDS)) {
        const custom = ctx?.geometryKind === "custom";
        return {
            kind: "sam",
            confidence: custom ? 0.9 : 0.8,
            reason: custom
                ? "Sketch keywords with a custom body active."
                : "Sketch keywords (segment, sketch, outline).",
        };
    }
    if (matchesAny(lower, POSTER_WORDS)) {
        return { kind: "poster", confidence: 0.8, reason: "Poster keywords (poster, image, render)." };
    }
    return { kind: "chat", confidence: 0.5, reason: "No tool keywords, plain chat reply." };
}

/** Zero network fallback copy per intent, used when Spark is offline. */
export const OFFLINE_TEMPLATES: Record<IntentKind, string> = {
    explain: "Offline engineer note: the run on canvas is 2D potential flow plus a wake overlay. Raise alpha a touch for more lift, watch CpMin for suction peak growth.",
    spec: "Offline spec note: staying on the current shape. Nudge camber or alpha from Shape controls, the field recomputes locally.",
    sam: "Offline SAM note: sketch segmentation needs the network. The bbox fallback shape is available from the SAM row instead.",
    poster: "Offline poster note: reusing the baked offline poster. Live renders need the network.",
    chat: "Offline chat note: local only. Ask to explain, propose, segment, or render, and the console will route it.",
};
