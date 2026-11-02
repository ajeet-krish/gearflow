// Phase 2 live Modal tutor prompt. Pure message builder for the Explain
// path, no React, no DOM, no network. Tutor first and agent applied: the
// system teaches one idea in plain grade 8 to 10 language, cites only the
// tutor table, and allows at most one set_field fence matching the
// suggested primary. Reasoning stays in reasoning_content only (check
// numbers against the table, pick the teaching point, verify the
// misconception) and never leaks into the final content. Final order is
// fixed: What changed, Why, Misconception, What to look at, Try next,
// Caveat. Honesty is pinned: neural is predicted not validated, analytic
// is a potential flow estimate, only the LBM instantaneous snapshot may
// be called solved, and n/a reads as pending. Never throws.

import type { ModalMessage } from "./modalClient";
import type { AgentContext } from "./agentContext";
import type { TutorConcept, TutorFieldSuggestion } from "./tutorPolicy";
import type { TutorTableRow } from "./tutorTable";
import { tutorRowsText } from "./tutorTable";

/** Prompt version pinned into the system line for drift tests. */
export const TUTOR_PROMPT_VERSION = "tutor-v2";

/** Prose word cap, not counting the table or the action fence. */
export const TUTOR_MAX_WORDS = 120;

export interface TutorHistoryTurn {
    role: "user" | "assistant";
    text: string;
}

/** Named misconception correction carried into the tutor prompt. Claim
 *  names the tempting error, correction states what the model shows,
 *  experimentText is one analytic-only experiment (never run_lbm). */
export interface TutorMisconceptionInput {
    claim: string;
    correction: string;
    experimentText: string;
}

export interface BuildTutorMessagesInput {
    after: AgentContext | null | undefined;
    rows: TutorTableRow[] | null | undefined;
    concept: TutorConcept;
    suggestion: TutorFieldSuggestion | null | undefined;
    history?: ReadonlyArray<TutorHistoryTurn> | null | undefined;
    misconception?: TutorMisconceptionInput | null | undefined;
}

function cleanConcept(v: unknown): TutorConcept {
    const known: ReadonlyArray<string> = [
        "attached-lift",
        "suction-peak",
        "stall-separation",
        "karman-shedding",
        "turbulent-wake",
        "stagnation",
        "general",
    ];
    if (typeof v === "string" && known.includes(v)) return v as TutorConcept;
    return "general";
}

const FIELD_TOKENS: ReadonlyArray<string> = ["speed", "cp", "omega", "u", "v", "k", "recirc"];

function cleanPrimary(v: unknown): string {
    return typeof v === "string" && FIELD_TOKENS.includes(v) ? v : "speed";
}

function cleanSecondary(v: unknown): string | null {
    return typeof v === "string" && FIELD_TOKENS.includes(v) ? v : null;
}

function cleanText(v: unknown, fallback: string): string {
    if (typeof v !== "string") return fallback;
    const t = v.trim().replace(/\s+/g, " ");
    return t.length > 0 ? t.slice(0, 300) : fallback;
}

function cleanMisconception(v: TutorMisconceptionInput | null | undefined): TutorMisconceptionInput | null {
    try {
        if (v === null || v === undefined) return null;
        if (typeof v !== "object") return null;
        const rec = v as unknown as Record<string, unknown>;
        const claim = cleanText(rec.claim, "");
        const correction = cleanText(rec.correction, "");
        const experimentText = cleanText(rec.experimentText, "");
        if (claim.length === 0 || correction.length === 0) return null;
        return {
            claim,
            correction,
            experimentText: experimentText.length > 0 ? experimentText : "Nudge alpha by 1 deg and compare Cl.",
        };
    } catch {
        return null;
    }
}

/**
 * Build Modal chat messages for the live tutor path only. System carries
 * the tutor voice plus the reasoning_content contract plus the honesty
 * clauses plus the one fence rule, user carries the concept plus the
 * misconception plus the table plus the suggested field plus the bounded
 * live context. Never throws.
 */
export function buildTutorMessages(input: BuildTutorMessagesInput): ModalMessage[] {
    try {
        const safe = (input ?? {}) as Partial<BuildTutorMessagesInput>;
        const concept = cleanConcept(safe.concept);
        const primary = cleanPrimary(safe.suggestion?.primary);
        const secondary = cleanSecondary(safe.suggestion?.secondary);
        const mis = cleanMisconception(safe.misconception ?? null);
        const table = tutorRowsText(Array.isArray(safe.rows) ? safe.rows : []);
        const contextJson = safe.after === null || safe.after === undefined
            ? "{}"
            : JSON.stringify(safe.after).slice(0, 3500);
        const misBlock = mis !== null
            ? `Misconception under test: claim "${mis.claim}", correction "${mis.correction}", experiment "${mis.experimentText}".`
            : "Misconception under test: none flagged. Write No misconception spotted in the Misconception section.";
        const system: ModalMessage = {
            role: "system",
            content: [
                `You are the GearFlow flow tutor (${TUTOR_PROMPT_VERSION}).`,
                "Teach one idea per reply in plain grade 8 to 10 language.",
                "When you use vorticity, suction, or separation, define the word in the same sentence you use it: vorticity means spinning motion in the flow, suction means low pressure pulling on the surface, separation means flow leaving the surface.",
                "First write private reasoning in reasoning_content only: check every number against the Before vs after table, pick one teaching point for the concept, verify the misconception against the table. Never put reasoning in the final content.",
                "Final reply uses exactly this order, each on its own line or block:",
                "What changed (table numbers only), Why (one cause and effect), Misconception (named correction or No misconception spotted), What to look at (the suggested field), Try next (one analytic experiment, never run_lbm), Caveat (analytic estimate with the path label, n/a is pending).",
                "What changed uses only the table numbers below, never invent numbers. When a value reads n/a or loading, call it pending.",
                "Why is one cause and effect in grade 8 to 10 language.",
                "Misconception names the correction from the misconception block, or writes No misconception spotted when none is flagged.",
                "What to look at names the suggested field below.",
                "Try next is one analytic-only experiment (a field view or an alpha nudge, never run_lbm, cancel_lbm, or a viscous solve). Prefer the misconception experiment when one is flagged.",
                "Caveat names the analytic estimate path label below, or pending when the path reads n/a.",
                "Neural frames are predicted, not validated. Analytic frames are a potential flow estimate, not validated. Only an LBM instantaneous snapshot (viscous D2Q9, not time averaged) may be called solved.",
                `Keep the prose under ${TUTOR_MAX_WORDS} words, not counting the table or the action fence.`,
                `You may append at most one set_field fence for the suggested primary field (${primary}), and no other action fence. Otherwise answer with no fence. Example fence:\n\`\`\`action-json\n{"kind":"set_field","field":"${primary}"}\n\`\`\``,
            ].join("\n"),
        };
        const rawHistory = Array.isArray(safe.history) ? safe.history : [];
        const tail: ModalMessage[] = [];
        for (const turn of rawHistory.slice(-6)) {
            try {
                if (turn === null || turn === undefined || typeof turn !== "object") continue;
                const rec = turn as Partial<TutorHistoryTurn>;
                const role = rec.role === "user" ? "user" : "assistant";
                const text = typeof rec.text === "string" ? rec.text.slice(0, 2000) : "";
                tail.push({ role, content: text });
            } catch {
                continue;
            }
        }
        const user: ModalMessage = {
            role: "user",
            content: [
                `Concept: ${concept}`,
                misBlock,
                `Suggested field: ${primary} (secondary: ${secondary ?? "none"})`,
                "Before vs after table:",
                table,
                `Live context: ${contextJson}`,
                "Explain this run.",
            ].join("\n"),
        };
        return [system, ...tail, user];
    } catch {
        return [
            { role: "system", content: `You are the GearFlow flow tutor (${TUTOR_PROMPT_VERSION}). Teach one idea per reply in plain grade 8 to 10 language.` },
            { role: "user", content: "Explain this run." },
        ];
    }
}
