// Phase 2 live Modal tutor prompt. Pure message builder for the Explain
// path, no React, no DOM, no network. Tutor first and agent applied: the
// system teaches one idea in plain grade 8 to 10 language, cites only the
// tutor table, and answers with no action fence. Reasoning stays in
// reasoning_content only (check numbers against the table, pick the
// teaching point) and never leaks into the
// final content. Final order is fixed: What changed, Why, Try next, plus
// a short physics note only when the idea needs it (the
// potential flow picture omits separation and stall). No solver or tech
// stack talk, no field suggestions, no vorticity or omega copy. Never
// throws.

import type { ModalMessage } from "./modalClient";
import type { AgentContext } from "./agentContext";
import type { TutorConcept, TutorFieldSuggestion } from "./tutorPolicy";
import type { TutorTableRow } from "./tutorTable";
import { tutorRowsText } from "./tutorTable";

/** Prompt version pinned into the system line for drift tests. */
export const TUTOR_PROMPT_VERSION = "tutor-v4";

/** Prose word cap, not counting the table or the action fence. */
export const TUTOR_MAX_WORDS = 120;

export interface TutorHistoryTurn {
    role: "user" | "assistant";
    text: string;
}

/** Named misconception correction, retained for shape compatibility.
 *  The chat path no longer detects or teaches misconceptions: the input
 *  is accepted and ignored, and the prompt carries no Misconception
 *  section. Try next stays physics-only. */
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

/**
 * Build Modal chat messages for the live tutor path only. System carries
 * the tutor voice plus the reasoning_content contract plus the physics
 * only rules plus the no fence rule, user carries the concept plus the
 * table plus the bounded live context. The misconception input is
 * accepted for shape compatibility and ignored. Never throws.
 */
export interface PhysicsView {
    body: string;
    alphaDeg: number | null;
    reynolds: number | null;
    cl: number | null;
    cpMin: number | null;
    regime: string;
}

export function physicsViewFor(ctx: AgentContext | null | undefined): PhysicsView {
    try {
        const c = (ctx ?? {}) as Partial<AgentContext>;
        const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
        const text = (v: unknown, fallback: string): string => {
            if (typeof v !== "string") return fallback;
            const t = v.trim().replace(/\s+/g, " ");
            return t.length > 0 ? t.slice(0, 80) : fallback;
        };
        const spec = (c.spec ?? {}) as { alphaDeg?: unknown };
        const alpha = num(c.alphaDeg ?? spec.alphaDeg);
        const reynoldsRaw = num(c.reynolds);
        return {
            body: text(c.bodyLabel, "unknown body"),
            alphaDeg: alpha,
            reynolds: reynoldsRaw === null ? null : Math.round(reynoldsRaw),
            cl: num(c.cl),
            cpMin: num(c.cpMin),
            regime: text(c.regime, "unknown regime"),
        };
    } catch {
        return { body: "unknown body", alphaDeg: null, reynolds: null, cl: null, cpMin: null, regime: "unknown regime" };
    }
}

export function buildTutorMessages(input: BuildTutorMessagesInput): ModalMessage[] {
    try {
        const safe = (input ?? {}) as Partial<BuildTutorMessagesInput>;
        const concept = cleanConcept(safe.concept);
        void cleanPrimary(safe.suggestion?.primary);
        void cleanSecondary(safe.suggestion?.secondary);
        void safe.misconception;
        const table = tutorRowsText(Array.isArray(safe.rows) ? safe.rows : []);
        const contextJson = JSON.stringify(physicsViewFor(safe.after ?? null)).slice(0, 3500);
        const system: ModalMessage = {
            role: "system",
            content: [
                `You are the GearFlow flow tutor (${TUTOR_PROMPT_VERSION}).`,
                "Teach one idea per reply in plain grade 8 to 10 language, like an interactive textbook.",
                "First mention per turn expands each term, then symbols after: lift coefficient (Cl), pressure coefficient (Cp), angle of attack (alpha), Reynolds number (Re). Spell each full name once, then use the short form.",
                "When you use suction or separation, define the word in the same sentence you use it: suction means low pressure pulling on the surface, separation means flow leaving the surface.",
                "First write private reasoning in reasoning_content only: check every number against the Before vs after table, pick one teaching point for the concept. Never put reasoning in the final content.",
                "Final reply uses exactly this order, each on its own line or block:",
                "What changed (table numbers only), Why (one cause and effect), Try next (one physics thought experiment), plus a short physics note only when the idea needs it.",
                "What changed uses only the table numbers below, never invent numbers. When a value reads n/a or loading, call it pending. Tie lift coefficient (Cl) and minimum pressure coefficient numbers to the table cells only.",
                "Why is one cause and effect in grade 8 to 10 language.",
                "Try next is one physics-only thought experiment: nudge angle of attack (alpha) by 1 deg and compare, or change Reynolds number (Re) and reason about the effect. Never a field switch, never a view change, never a run.",
                "When the body is the orifice plate, never mention angle of attack (alpha): the plate has no angle, cite the gap opening instead. Try next for the orifice varies the gap opening or Reynolds number (Re), never angle of attack (alpha).",
                "Physics note only when the idea needs it, one line: the potential flow picture omits separation and stall.",
                "For any generated airfoil, add one line relating it to a real-world equivalent or why the shape cannot exist as drawn.",
                "Never list valid bodies or canvas limits in replies; keep nearest alternatives purely physical, like a venturi narrowing speeds the flow, never this-canvas-can-build talk.",
                "No solver or tech stack talk: teach flow physics only, no solver names, no statistics, no spinning-flow copy, no field views.",
                "Never promise a future run or sweep the agent did not take: teach only the applied run in the Before vs after table.",
                "When the setup was rejected, state what was rejected, why (naming the bound), and the nearest valid alternative with the canvas unchanged, and teach no table for the unapplied case.",
                `Keep the prose under ${TUTOR_MAX_WORDS} words, not counting the table.`,
                "Answer with no action fence and no field suggestion.",
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
