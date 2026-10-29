// Phase T1 tutor prompt. Pure message builder for the Explain preset,
// no React, no DOM, no network. Tutor first and agent applied: the system
// teaches one idea in plain grade 8 to 10 language, cites only the tutor
// table, and allows at most one set_field fence matching the suggested
// primary. Honesty is pinned: neural is predicted not validated, analytic
// is a potential flow estimate, only the LBM instantaneous snapshot may
// be called solved, and n/a reads as pending. Never throws.

import type { BasetenMessage } from "./basetenClient";
import type { AgentContext } from "./agentContext";
import type { TutorConcept, TutorFieldSuggestion } from "./tutorPolicy";
import type { TutorTableRow } from "./tutorTable";
import { tutorRowsText } from "./tutorTable";

/** Prompt version pinned into the system line for drift tests. */
export const TUTOR_PROMPT_VERSION = "tutor-v1";

/** Prose word cap, not counting the table or the action fence. */
export const TUTOR_MAX_WORDS = 120;

export interface TutorHistoryTurn {
    role: "user" | "assistant";
    text: string;
}

export interface BuildTutorMessagesInput {
    after: AgentContext | null | undefined;
    rows: TutorTableRow[] | null | undefined;
    concept: TutorConcept;
    suggestion: TutorFieldSuggestion | null | undefined;
    history?: ReadonlyArray<TutorHistoryTurn> | null | undefined;
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

/**
 * Build Spark chat messages for the Explain preset only. System carries
 * the tutor voice plus the honesty clauses plus the one fence rule, user
 * carries the concept plus the table plus the suggested field plus the
 * bounded live context. Never throws.
 */
export function buildTutorMessages(input: BuildTutorMessagesInput): BasetenMessage[] {
    try {
        const safe = (input ?? {}) as Partial<BuildTutorMessagesInput>;
        const concept = cleanConcept(safe.concept);
        const primary = cleanPrimary(safe.suggestion?.primary);
        const secondary = cleanSecondary(safe.suggestion?.secondary);
        const table = tutorRowsText(Array.isArray(safe.rows) ? safe.rows : []);
        const contextJson = safe.after === null || safe.after === undefined
            ? "{}"
            : JSON.stringify(safe.after).slice(0, 3500);
        const system: BasetenMessage = {
            role: "system",
            content: [
                `You are the GearFlow flow tutor (${TUTOR_PROMPT_VERSION}).`,
                "Teach one idea per reply in plain grade 8 to 10 language.",
                "When you use vorticity, suction, or separation, define the word in the same sentence you use it: vorticity means spinning motion in the flow, suction means low pressure pulling on the surface, separation means flow leaving the surface.",
                "Structure every reply as: What changed (use only the table numbers below), Why (one cause and effect), What to look at (the suggested field), Try next (one experiment). Then a one line caveat.",
                "Use only the table numbers below, never invent numbers. When a value reads n/a or loading, call it pending.",
                "Neural frames are predicted, not validated. Analytic frames are a potential flow estimate, not validated. Only an LBM instantaneous snapshot (viscous D2Q9, not time averaged) may be called solved.",
                `Keep the prose under ${TUTOR_MAX_WORDS} words, not counting the table or the action fence.`,
                `You may append at most one set_field fence for the suggested primary field (${primary}), and no other action fence. Otherwise answer with no fence. Example fence:\n\`\`\`action-json\n{"kind":"set_field","field":"${primary}"}\n\`\`\``,
            ].join("\n"),
        };
        const rawHistory = Array.isArray(safe.history) ? safe.history : [];
        const tail: BasetenMessage[] = rawHistory.slice(-6).map((turn): BasetenMessage => {
            const role = turn.role === "user" ? "user" : "assistant";
            const text = typeof turn.text === "string" ? turn.text.slice(0, 2000) : "";
            return { role, content: text };
        });
        const user: BasetenMessage = {
            role: "user",
            content: [
                `Concept: ${concept}`,
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
