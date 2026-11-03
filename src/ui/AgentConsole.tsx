// Agent console: Modal chat transcript over the live run context.
// Composer streams through ModalClient with Stop plus a 60 s budget,
// every live turn goes through the live Modal port, and a live failure
// lands an honest error turn with zero canvas writes plus Retry.
// Setup actions auto apply through onAgentAction, run and cancel render
// as confirm chips only, rejections render as reason text. Transcript
// persists capped at 50. React plus plain CSS classes from the Zenith
// shell, react-markdown plus remark-gfm for agent prose (user turns stay
// plain text). Single agent response: the tutor teaches in place on the
// applied action turn (What changed, Why, one
// physics-only Try next, plus a short physics note only when needed)
// with a real before vs after table, never a second tutor turn and never
// rendered apply receipts, reasoning traces, or concept badges.

import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentAction, ChatTurn } from "@/contracts/types";
import type { AgentContext } from "@/agent/agentContext";
import { ModalClient, type ModalChatResult, type ModalMessage, type ModalStreamChunk } from "@/agent/modalClient";
import { MODAL_MODEL_ID, MODAL_TIMEOUT_MS } from "@/agent/modalGate";
import { actionContractSummary, MAX_ENVELOPE_ACTIONS, parseAgentEnvelope, validateAgentAction, type AgentValidationContext } from "@/agent/agentActions";
import { buildTutorTable, tutorRowsText, type TutorSnapshotLite, type TutorTableRow } from "@/agent/tutorTable";
import { detectConcept, fieldForConcept, type TutorConcept, type TutorFieldSuggestion } from "@/agent/tutorPolicy";
import { buildTutorMessages } from "@/agent/tutorPrompt";
import { buildAirfoilEnvelope, parseAirfoilIntent, parseReynolds, type AirfoilApply } from "@/agent/airfoilIntent";
import { buildBlockEnvelope, parseBlockIntent } from "@/agent/blockIntent";
import { buildCylinderEnvelope, parseCylinderIntent } from "@/agent/cylinderIntent";
import { isSchemaValidCode } from "@/agent/nacaParse";
import { buildOrificeEnvelope, parseOrificeIntent } from "@/agent/orificeIntent";
import { expandCasePreset } from "@/agent/casePresets";
import { isAlphaSweepIntent, isOrificeSweepBody, runAlphaSweep, sweepDwellYield, sweepToTutorRows, SWEEP_ALPHAS } from "@/agent/alphaSweep";
import { SESSION_SPEND_CAP_USD, addSpend, isSoftStopped } from "@/agent/sessionSpend";
import { appendTurns, CHAT_TEXT_MAX, loadTurns, saveTurns } from "@/agent/chatStore";
import { resolveAgentFirst } from "@/config/agentFirst";
import { g_evalLog } from "@/meta/evalLog";
import { CURRICULUM_CHIPS } from "@/agent/curriculum";

/** Minimal chat port so tests inject a fake with zero live calls.
 *  Reasoning rides the result (reasoning_content or reasoning) and never
 *  feeds the action envelope. */
export interface ModalChatPort {
    streamChat(
        messages: ModalMessage[],
        opts?: { feature?: string; signal?: AbortSignal; timeoutMs?: number }
    ): AsyncGenerator<ModalStreamChunk, ModalChatResult, void>;
    chat(
        messages: ModalMessage[],
        opts?: { feature?: string; signal?: AbortSignal; timeoutMs?: number }
    ): Promise<ModalChatResult>;
}

export interface AgentConsoleProps {
    spec?: unknown;
    reynolds?: number;
    cl?: number;
    cpMin?: number;
    offline?: boolean;
    onOfflineChange?: (next: boolean) => void;
    onApplySpec?: (next: never) => void;
    client?: unknown;
    cache?: unknown;
    posterUrl?: string | null;
    onPosterUrl?: (url: string | null) => void;
    offlineCases?: unknown;
    agentContext?: AgentContext | null;
    onAgentAction?: (action: AgentAction) => void;
    /** Live what-if sweep stepper. App implements with the analytic path,
     *  returning Cl, CpMin, and solveMs for one alpha. Absent means the
     *  sweep still morphs the canvas through onAgentAction with n/a cells. */
    onWhatIfSweep?: (alphaDeg: number) => { cl: number | null; cpMin: number | null; solveMs: number | null } | Promise<{ cl: number | null; cpMin: number | null; solveMs: number | null }>;
    /** Immediate sweep apply that bypasses the App canvas debounce so each
     *  intermediate alpha paints in order. Falls back to onAgentAction
     *  set_alpha when absent. */
    onSweepAlpha?: (alphaDeg: number) => void | Promise<void>;
    chatClient?: ModalChatPort | null;
    evalSink?: ((payload: { feature: string; model: string }) => void) | null;
    spendCapUsd?: number;
    initialTurns?: ChatTurn[];
    initialBusy?: boolean;
    initialExtras?: Record<string, TurnExtra>;
}

export const MODAL_FEATURE = "modal-chat";
export const STREAM_FLUSH_MS = 50;
export const SPEND_SOFT_STOP_USD = SESSION_SPEND_CAP_USD;
export const TRANSCRIPT_CAP = 50;
/** Phase 2 live tutor hook constants. The tutor fires once per settled
 *  after-caseKey through the live Modal port with a 60 s budget, or after
 *  the settle timeout with a loading line. No local prose fallback. */
export const TUTOR_FEATURE = "tutor";
export const TUTOR_TIMEOUT_MS = 2500;
export const TUTOR_LOADING_LINE = "Prediction still loading, showing the pending table.";
/** Parser apply floor: a high confidence apply (>= 0.9) settles through the
 *  shared validator on the post-model rescue path. Clarify, invalid,
 *  question, and low confidence results never apply. The pre-submit fast
 *  path is removed: every live turn goes through the Modal port. */
export const PARSER_APPLY_CONFIDENCE = 0.9;
/** Model attribution for zero credit parser turns. Spend stays untouched,
 *  the badge names the local path honestly. */
export const PARSER_LOCAL_MODEL = "parser-local";

/** Compact example prompts for the prompt dropdown. Labels read plain,
// prompts ride the existing parser and local path: NACA setup, Re change,
// relative thickness reshape. Tutorials live beside them in their own
// dropdown fed by CURRICULUM_CHIPS. */
export interface ExamplePrompt {
    id: string;
    label: string;
    prompt: string;
}

export const EXAMPLE_PROMPTS: ReadonlyArray<ExamplePrompt> = [
    { id: "naca-setup", label: "Set up NACA 2412 at angle of attack (alpha) 6", prompt: "Set up NACA 2412 alpha 6" },
    { id: "re-change", label: "Increase Reynolds number (Re)", prompt: "Increase Re to 200000" },
    { id: "thicken", label: "Increase airfoil thickness", prompt: "Make the airfoil thicker" },
];

/** Auto apply kinds plus confirm chip kinds, derived from the validator
 *  contract so the console, the prompt, and the validator cannot drift.
 *  Retired setup_high_pressure is in neither set: the validator rejects
 *  it with the honest divergence reason before it could apply. */
export const SETUP_KINDS: ReadonlySet<string> = new Set(actionContractSummary().setupKinds);

export const RUN_KINDS: ReadonlySet<string> = new Set(actionContractSummary().runKinds);

/** Phase 25C theory nav kinds, derived from the validator contract so the
 *  console NAV settle branch, the prompt, and the validator cannot drift. */
export const NAV_KINDS: ReadonlySet<string> = new Set(actionContractSummary().navKinds);

export interface TurnExtra {
    model: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    streaming: boolean;
    stopped: boolean;
    applied: string[];
    rejections: string[];
    pendingRuns: AgentAction[];
    /** Live sweep per-point samples for Apply chips on the summary turn. */
    sweepPoints?: Array<{ alphaDeg: number; cl: number | null; cpMin: number | null }>;
    /** Suggested setup prompts on no-action explain turns. Each renders
     *  as a confirm-style chip that submits as a new user turn, never an
     *  auto apply. */
    suggestedPrompts?: string[];
    /** True when the sweep summary ended early via Stop. */
    sweepCancelled?: boolean;
    /** Live sweep progress marker on the running turn. */
    sweepProgress?: { done: number; total: number; current: number } | null;
    /** Collapsed reasoning trace from result.reasoning. Never envelope
     *  parsed, never persisted as prose. Hidden when empty. */
    reasoning?: string;
    /** Honest tutor failure detail. When set the tutor turn renders rows
     *  plus the error plus a Retry chip, never local prose. */
    tutorError?: string | null;
    /** Honest chat failure detail for the main composer Retry chip. */
    chatError?: string | null;
    /** Phase 25C theory nav topics settled on this turn. Records each
     *  applied open_theory topic so the transcript names the companion
     *  anchor without re-reading the envelope. */
    navTopics?: string[];
}

export interface SpendTotals {
    model: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
}

let turnCounter = 0;

function nextId(): string {
    turnCounter += 1;
    return `chat-${Date.now().toString(36)}-${turnCounter.toString(36)}`;
}

function nowIso(): string {
    return new Date().toISOString();
}

function envOffline(): boolean {
    try {
        const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
        return env?.VITE_DEMO_OFFLINE === "true";
    } catch {
        return false;
    }
}

export function spendExceeded(costUsd: number, cap: number = SPEND_SOFT_STOP_USD): boolean {
    return isSoftStopped(costUsd, cap);
}

/** Phase T2 tutor lite snapshot. Maps the bounded agent context onto the
 *  tutor table input. Finite guards throughout, labels fall back to n/a
 *  through the table cleaner. Never throws. */
export function snapshotLiteFor(ctx: AgentContext | null | undefined): TutorSnapshotLite {
    try {
        const c = (ctx ?? {}) as Partial<AgentContext>;
        const spec = (c.spec ?? {}) as { kind?: unknown; alphaDeg?: unknown };
        const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
        const text = (v: unknown, fallback: string): string => {
            if (typeof v !== "string") return fallback;
            const t = v.trim().replace(/\s+/g, " ");
            return t.length > 0 ? t : fallback;
        };
        const kind = typeof spec.kind === "string" ? spec.kind : "unknown";
        // The orifice plate has no angle of attack: its lite snapshot
        // carries a null alpha so tutor tables read n/a consistently.
        const rawAlpha = num(c.alphaDeg ?? spec.alphaDeg);
        const alpha = kind === "orifice" ? null : rawAlpha;
        const reynolds = num(c.reynolds);
        const fieldVar = (() => {
            const f = (c.field ?? {}) as { variable?: unknown; effective?: unknown };
            if (typeof f.variable === "string" && f.variable.trim().length > 0) return f.variable.trim();
            if (typeof f.effective === "string" && f.effective.trim().length > 0) return f.effective.trim();
            return "speed";
        })();
        const fieldToken = `f${fieldVar}`;
        const key = typeof c.caseKey === "string" && c.caseKey.trim().length > 0
            ? c.caseKey.trim()
            : `${kind}|a${alpha === null ? "?" : alpha}|Re${reynolds === null ? "?" : Math.round(reynolds)}|${text(c.neural?.path, "analytic")}|${fieldToken}`;
        // Explicit keys from the App already carry the field token. Legacy or
        // hand built keys without one get the field suffix so a field-only
        // apply moves the key and cannot be mistaken for a settled repeat.
        const keyWithField = key.includes("|f") ? key : `${key}|${fieldToken}`;
        const pathLabel = text(c.provenanceLabel, "") !== ""
            ? text(c.provenanceLabel, "analytic")
            : text(c.neural?.path, "analytic");
        const strouhal = c.surrogate?.strouhal ?? c.lbm?.stats?.strouhal ?? null;
        const specRadius = (spec as { radius?: unknown }).radius;
        return {
            caseKey: keyWithField,
            bodyLabel: text(c.bodyLabel, "unknown body"),
            alpha,
            reynolds,
            cl: num(c.cl),
            cpMin: num(c.cpMin),
            regime: text(c.regime, "unknown regime"),
            pathLabel,
            strouhal: num(strouhal),
            radius: typeof specRadius === "number" && Number.isFinite(specRadius) ? specRadius : null,
        };
    } catch {
        return {
            caseKey: "n/a",
            bodyLabel: "n/a",
            alpha: null,
            reynolds: null,
            cl: null,
            cpMin: null,
            regime: "n/a",
            pathLabel: "n/a",
            strouhal: null,
            radius: null,
        };
    }
}

/** Suggested setup prompts for no-action explain turns. When a reply
 *  discusses a setup (orifice constriction or airfoil) but applied
 *  nothing, the turn carries these prompts as confirm-style chips that
 *  submit as new user turns, never auto applies. Never throws. */
export function suggestedPromptsFor(reply: unknown): string[] {
    try {
        if (typeof reply !== "string") return [];
        const lower = reply.toLowerCase();
        const out: string[] = [];
        if (/orifice|constriction|venturi|throat|\btunnel\b/.test(lower)) out.push("Set up the orifice");
        if (/\bairfoil\b|\bnaca\b/.test(lower)) out.push("Set up NACA 2412 alpha 6");
        return out.slice(0, 2);
    } catch {
        return [];
    }
}

/** Pending tutor capture: the turn that applied plus the before snapshot
 *  plus the after-caseKey. baseText is
 *  the applied turn reply the teaching appends to in place. The effect
 *  fires once the settled context moves past caseKeyBefore. */
export interface PendingTutor {
    turnId: string;
    before: TutorSnapshotLite;
    caseKeyBefore: string;
    actionsSummary: string;
    startedAt: number;
    beforeVariable: string;
    triggerText: string;
    baseText: string;
}

/** Tutor retry payload: the same capture plus the settled after snapshot
 *  so Retry refires one Modal call for the same after-caseKey. */
interface TutorRetry {
    capture: PendingTutor;
    after: TutorSnapshotLite;
    timedOut: boolean;
}

/** Effect shim: legacy wiring harnesses mock useState/useMemo/useRef only.
 *  The tutor effect is skipped there (caught) instead of crashing the
 *  transcript, spend, and gating tests. Full harnesses provide useEffect
 *  and the tutor fires normally. */
function useSafeEffect(fn: () => void | (() => void), deps?: unknown[]): void {
    try {
        useEffect(fn, deps);
    } catch {
        // Legacy harness without effect support: tutor stays pending.
    }
}

/** Validation context derived from the agent snapshot, engine flag first,
 *  neural envelope carried when the snapshot names it. The agent-first flag
 *  rides the context when the snapshot names it, otherwise the build-time
 *  default decides, so the console gates match the App executor. */
export function validationContextFor(ctx: AgentContext | null | undefined): AgentValidationContext {
    if (ctx === null || ctx === undefined) {
        return { lbmEffective: false, statsReady: false, hasTke: false, hasRecirc: false };
    }
    const flagged = (ctx.lbm as unknown as { effective?: unknown } | null | undefined)?.effective;
    let lbmEffective: boolean;
    if (typeof flagged === "boolean") {
        lbmEffective = flagged;
    } else {
        const status = typeof ctx.lbm?.status === "string" ? ctx.lbm.status.toLowerCase() : "";
        lbmEffective = ctx.lbm?.hasSnapshot === true || status.includes("live") || status.includes("running");
    }
    return {
        lbmEffective,
        statsReady: ctx.lbm?.statsReady === true,
        hasTke: ctx.field?.hasTke === true,
        hasRecirc: ctx.field?.hasRecirc === true,
        neuralAvailable: ctx.neural?.available === true,
        agentFirst: resolveAgentFirst((ctx as unknown as { agentFirst?: unknown }).agentFirst),
    };
}

/** Prompt lines for the setup presets, derived from the validator
 *  contract plus live expandCasePreset output so expansions and Re values
 *  in the prompt can never drift from what the App executor applies.
 *  Physics-only copy: body plus angle plus Re, no field or solver talk.
 *  Retired setup_high_pressure is labeled retired plus the redirect,
 *  never a live example. */
export function presetPromptLines(): { live: string; retired: string } {
    const contract = actionContractSummary();
    const parts: string[] = [];
    for (const preset of contract.presets) {
        if (preset.retired) continue;
        const expanded = expandCasePreset(
            preset.id === "shedding"
                ? { preset: "shedding" }
                : preset.id === "high_re_wake"
                    ? { preset: "high_re_wake" }
                    : { preset: "airfoil" }
        );
        if (!expanded.ok) continue;
        let body = "";
        let alpha = 0;
        let re = 0;
        for (const a of expanded.actions) {
            if (a.kind === "set_body") body = a.body;
            else if (a.kind === "set_alpha") alpha = a.alphaDeg;
            else if (a.kind === "set_reynolds") re = a.reynolds;
        }
        if (preset.id === "airfoil") {
            parts.push(
                `airfoil (${preset.actionKind}) is ${body} at angle of attack (alpha) ${alpha} Reynolds number (Re) ${re}, e.g. NACA 0012, 2412, 4412 presets`
            );
        } else {
            parts.push(`${preset.id} (${preset.actionKind}) is ${body} angle of attack (alpha) ${alpha} Reynolds number (Re) ${re}`);
        }
    }
    const retired = "setup_high_pressure is retired, use setup_high_re_wake instead";
    return { live: parts.join(", "), retired };
}

/** Physics-only live context for model prompts. Projects the full agent
 *  snapshot onto body plus angle plus Reynolds number plus coefficients
 *  plus regime, so no engine, field, solver, or statistics tokens reach
 *  the model. Never throws. */
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

/** Prompt messages: system instruction plus bounded context plus recent history.
 *  Setup presets auto apply through the App executor, run and cancel render
 *  as confirm chips only, at most five validated actions per envelope. */
export function buildModalMessages(
    input: string,
    ctx: AgentContext | null | undefined,
    history: ChatTurn[]
): ModalMessage[] {
    const presetLines = presetPromptLines();
    const contextJson = JSON.stringify(physicsViewFor(ctx)).slice(0, 3500);
    void resolveAgentFirst((ctx as unknown as { agentFirst?: unknown } | null | undefined)?.agentFirst);
    // Phase 25C prompt lines derive the nav plus block fences from the
    // validator contract so the prompt cannot drift from the allowlists the
    // validator enforces. Topics name Theory page anchors, block sizes stay
    // in [0.1, 3] with a full center, matching validateGeometrySpec.
    const contract = actionContractSummary();
    const topicList = contract.topics.join(", ");
    const systemLines = [
        "You are the GearFlow flow tutor. Answer briefly about the run like an interactive textbook.",
        "First mention per turn expands each term, then symbols after: lift coefficient (Cl), pressure coefficient (Cp), angle of attack (alpha), Reynolds number (Re).",
        "To change the canvas, append one fenced block per action, at most five:",
        "```action-json",
        '{"kind":"set_alpha","alphaDeg":6}',
        "```",
        "```action-json",
        '{"kind":"set_spec","spec":{"geometry":{"kind":"naca4","naca":{"code":"2415","m":0.02,"p":0.4,"t":0.15},"chord":1,"alphaDeg":6,"nPoints":120},"reynolds":200000,"rationale":"Agent setup NACA 2415 alpha 6."}}',
        "```",
        `Valid actions: adjust angle of attack (alpha), adjust Reynolds number (Re), apply any body including the orifice plate (fourth body tab), apply a body setup preset, show or plot a field, or ask for an alpha sweep summary.`,
        `The exact Reynolds number (Re) action kind is "set_reynolds".`,
        `Plot requests set the field: show or plot pressure or Cp emits set_field cp (contours coupling follows), show or plot velocity or speed emits set_field speed.`,
        `Pressure-effect questions set the field too: how does this affect pressure, how pressure changes, pressure effect, impact on pressure, or Cp equivalents emit set_field cp in addition to teaching (contours follow the field).`,
        `Constriction, tunnel, venturi, throat, or orifice language means the orifice body and it IS appliable like any body (fourth body tab): emit set_body orifice or one set_spec with the orifice plate thickness 0.08, gap opening (height) 0.4, alphaDeg always 0. Explain it as a narrower gap speeding the flow like a venturi, never canvas limits. Example fence:`,
        "```action-json",
        '{"kind":"set_spec","spec":{"geometry":{"kind":"orifice","chord":1,"alphaDeg":0,"nPoints":120,"width":0.08,"height":0.4,"center":{"x":0.5,"y":0}},"reynolds":1000,"rationale":"Agent setup Orifice gap 0.4 plate 0.08."}}',
        "```",
        `Never mention angle of attack (alpha) for the orifice plate: it has no angle, cite the gap opening instead. Orifice specs always carry alphaDeg 0.`,
        `Setup presets expand atomically: ${presetLines.live}.`,
        presetLines.retired,
        `Only setup_shedding, setup_high_re_wake, and setup_airfoil exist: set_preset aliases map before validation (cylinder, shedding, karman, or vortex map to setup_shedding; high Re wake maps to setup_high_re_wake; NACA or airfoil maps to setup_airfoil; high pressure maps to retired setup_high_pressure), while conflicting or unknown presets (bare wake, high resistance, cylinder airfoil together) are strictly rejected with the canvas unchanged.`,
        `Bare body requests apply a setup with the stated Reynolds number (Re) together: show me a cylinder (or vortex shedding, karman) means setup_shedding plus a validated Reynolds number action carrying the stated Re when one is named; high Reynolds number (Re) wake means setup_high_re_wake plus a validated Reynolds number action carrying the stated Re when one is named; NACA or airfoil (any 4-digit code or bare airfoil) means setup_airfoil carrying the code into body plus angle of attack (alpha) when named; rectangle, block, or square means one set_spec block; orifice, constriction, tunnel, venturi, throat, or gap means one set_spec orifice with angle of attack (alpha) always 0.`,
        `Cylinder size maps to the cylinder radius in [0.05, 1]: radius phrasing carries directly, diameter phrasing halves into radius, out of range values clamp with a note naming the bound.`,
        `Explain or teach plus a body noun applies that body setup first (when it names a body other than the current one) and then teaches fully in the same single response; a pure explain-this-run question with no body noun never writes the canvas. What, why, and define questions without a setup request never write the canvas.`,
        'Any 4-digit NACA rides one set_spec with the full parametric geometry plus reynolds plus rationale (required non-empty string, e.g. rationale "Agent setup NACA 2415 alpha 6.").',
        "NACA validity: thickness (t) in [0.02, 1.0], camber (m) in [0, 0.15], when camber (m) is above 0 camber position (p) in (0, 1); clamp or pick the nearest valid value and say so.",
        "Bounds: alpha in [-180, 180] hard ([-4, 12] characterized), reynolds in [100, 1000000]. Orifice alpha is always 0, never outside that single value.",
        "On rejection the turn states what was rejected, why (naming the bound), and the nearest valid alternative, with the canvas unchanged. No teaching prose for unapplied cases. Keep nearest alternatives purely physical, like a venturi narrowing speeds the flow, never list valid bodies or canvas limits.",
        `To open the companion page, append one fence with at most one nav action: {"kind":"open_theory","topic":"cl-vs-alpha"}. Valid topics name a Theory page anchor: ${topicList}.`,
        'A square, rectangle, or rectangular section rides one set_spec with kind block plus chord 1 plus width plus height in [0.1, 3] plus a finite center plus reynolds plus rationale (required non-empty string, e.g. rationale "Agent setup Rectangle 0.5 by 0.5."). Example fence:',
        "```action-json",
        '{"kind":"set_spec","spec":{"geometry":{"kind":"block","chord":1,"alphaDeg":0,"nPoints":120,"width":0.5,"height":0.5,"center":{"x":0.5,"y":0}},"reynolds":200000,"rationale":"Agent setup Rectangle 0.5 by 0.5."}}',
        "```",
        "Angle of attack (alpha) influence, stall demo, stall sweep, or show stall: when the user asks to see angle of attack (alpha) influence or effect, or names a stall demo, stall sweep, or show stall, answer with no action fence and name the live analytic staircase (-4 to 12 step 2, 9 points) that the agent runs now with Stop plus per-point Apply chips, never just describe it and never promise a run the agent did not take. Sweep replies carry NO fence: never emit alpha_sweep_summary or any action-json fence on a sweep reply, the agent runs the staircase.",
        "Reply with exactly one sentence describing the new case (body plus angle of attack plus Reynolds number plus what changed on canvas) plus the fence only, never two sentences, never duplicate What changed, Why, or Try next in the model reply, never teaching sections, never tables, never narrate future bumps or plans; then the validated apply follows and the tutor upsert owns all teaching on the same turn with a before versus after table plus Why plus Try next. Questions with no actions answer fully.",
        "Never name presets in the reply; describe physics only (body plus angle plus Reynolds number), never setup names or preset words. Prose never contains raw JSON: actions ride fenced blocks only.",
        "Try next is a physics thought experiment only: nudge angle of attack by 1 deg or change Reynolds number and reason about the effect. Never a field switch, never a view change, never a run.",
        "No solver or tech stack talk: teach flow physics only, no solver names, no statistics, no spinning-flow copy, no field views. Physics note only when the idea needs it: the potential flow picture omits separation and stall.",
    ];
    systemLines.push(
        "Never invent bodies, Re, or alpha: name the nearest valid case on rejection.",
        `Live context: ${contextJson}`
    );
    const system: ModalMessage = {
        role: "system",
        content: systemLines.join("\n"),
    };
    const tail = history.slice(-8).map((t): ModalMessage => ({
        role: t.role === "user" ? "user" : "assistant",
        content: t.text.slice(0, 2000),
    }));
    return [system, ...tail, { role: "user", content: input.slice(0, 2000) }];
}

/** Offline demo reply without local prose. Zero network, zero canvas
 *  writes, zero imports from the local assistant. The live tutor path
 *  never calls this; it renders an honest error turn with rows plus Retry
 *  instead. Kept exported so older harnesses importing localOfflineReply
 *  keep compiling while the console live path stays Modal only. */
export function localOfflineReply(input: string, metrics: { cl: number; cpMin: number; reynolds: number }): string {
    try {
        const safe = (metrics ?? {}) as { cl?: unknown; cpMin?: unknown; reynolds?: unknown };
        const num = (v: unknown): string => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(3) : "pending");
        const text = typeof input === "string" ? input.slice(0, 120) : "";
        return `Offline demo mode, cached table only. Lift coefficient (Cl) ${num(safe.cl)} with minimum pressure coefficient (CpMin) ${num(safe.cpMin)}. You asked: ${text}. Canvas unchanged.`;
    } catch {
        return "Offline demo mode, cached table only. Canvas unchanged.";
    }
}

function describeAction(a: AgentAction): string {
    if (a.kind === "set_body") {
        const label = a.body === "block" ? "Rectangle" : a.body;
        return `body ${label}`;
    }
    if (a.kind === "set_alpha") return `angle of attack (alpha) ${a.alphaDeg} deg`;
    if (a.kind === "set_reynolds") return `Reynolds number (Re) ${a.reynolds}`;
    if (a.kind === "set_engine") return "calculation setting applied";
    if (a.kind === "set_field") return "view setting applied";
    if (a.kind === "run_lbm") return "run";
    if (a.kind === "cancel_lbm") return "cancelled run";
    if (a.kind === "open_theory") return `theory ${(a as { topic?: unknown }).topic ?? ""}`;
    if (a.kind === "setup_shedding") return "vortex shedding case (cylinder, angle of attack (alpha) 0, Reynolds number (Re) 100)";
    if (a.kind === "setup_high_re_wake") return "high Reynolds number (Re) wake case (cylinder, angle of attack (alpha) 0, Reynolds number (Re) 700)";
    if (a.kind === "setup_high_pressure") return "retired high pressure case (use setup_high_re_wake instead)";
    if (a.kind === "setup_airfoil") {
        const body = typeof (a as { body?: unknown }).body === "string" ? String((a as { body?: unknown }).body) : "naca2412";
        const alpha = typeof (a as { alphaDeg?: unknown }).alphaDeg === "number" ? (a as { alphaDeg: number }).alphaDeg : 6;
        return `airfoil case (${body} at angle of attack (alpha) ${alpha}, Reynolds number (Re) 1200)`;
    }
    return "custom spec";
}

/** First sentence of a model reply, so settled turns stay one sentence.
 *  Collapses whitespace, cuts at the first period, question, or
 *  exclamation mark, and folds any parser Note tail into the same
 *  sentence with a semicolon. Never throws. */
export function firstSentenceReply(raw: unknown): string {
    try {
        if (typeof raw !== "string") return "";
        const flat = raw.trim().replace(/\s+/g, " ");
        if (flat.length === 0) return "";
        const match = flat.match(/^(.+?[.!?])(\s|$)/);
        const first = match !== null ? match[1].trim() : flat.split(/(?<!\d)\.(?!\d)/)[0]?.trim() ?? flat;
        const single = first.length > 0 ? first : flat;
        return single.endsWith(".") || single.endsWith("!") || single.endsWith("?") ? single : `${single}.`;
    } catch {
        return "";
    }
}

/** Collapse a built reply with parser Note tails into one sentence so
 *  settled turns never render two sentences. Note tails join with
 *  semicolons inside the single trailing period. Never throws. */
export function collapseToOneSentence(reply: unknown): string {
    try {
        if (typeof reply !== "string") return "";
        const flat = reply.trim().replace(/\s+/g, " ");
        if (flat.length === 0) return "";
        const folded = flat.replace(/\.?\s*Note:\s*/gi, "; note: ");
        const sentences = folded.split(/(?<=[.!?])\s+/);
        if (sentences.length <= 1) {
            return folded.endsWith(".") || folded.endsWith("!") || folded.endsWith("?") ? folded : `${folded}.`;
        }
        const joined = sentences.map((s) => s.replace(/[.?!]+$/, "")).join("; ");
        return `${joined}.`;
    } catch {
        return typeof reply === "string" ? reply : "";
    }
}

/** Atomic setup settle: a setup envelope carrying any rejection settles
 *  zero actions, so a half applied case can never land. Pure helper so
 *  the review round pins the contract without a React harness. Never
 *  throws. */
export function atomicSetupActions(actions: AgentAction[], rejections: string[]): AgentAction[] {
    try {
        const hasSetupPreset = actions.some((a) => typeof a.kind === "string" && a.kind.startsWith("setup_"));
        if (rejections.length > 0 && hasSetupPreset) return [];
        return actions;
    } catch {
        return [];
    }
}

/** Honest executor fault copy: claims the canvas unchanged only when
 *  nothing applied yet, otherwise names the partial apply count. Never
 *  throws. */
export function executorFaultCopy(kind: string, appliedCount: number): string {
    try {
        const safeKind = typeof kind === "string" && kind.length > 0 ? kind : "action";
        const safeCount = Number.isFinite(appliedCount) ? Math.max(0, Math.floor(appliedCount)) : 0;
        return safeCount > 0
            ? `apply failed for ${safeKind} after ${safeCount} applied, check the canvas`
            : `apply failed for ${safeKind}, canvas unchanged`;
    } catch {
        return "apply failed, check the canvas";
    }
}

function describeEnvelopeActions(actions: AgentAction[]): string {
    try {
        const parts: string[] = [];
        for (const a of actions.slice(0, 5)) {
            if (a.kind === "setup_shedding") parts.push("the cylinder at angle of attack (alpha) 0 and Reynolds number (Re) 100");
            else if (a.kind === "setup_high_re_wake") parts.push("the cylinder at angle of attack (alpha) 0 and Reynolds number (Re) 700");
            else if (a.kind === "setup_airfoil") {
                const body = typeof (a as { body?: unknown }).body === "string" ? String((a as { body?: unknown }).body).toUpperCase() : "airfoil";
                const alpha = typeof (a as { alphaDeg?: unknown }).alphaDeg === "number" ? ` at angle of attack (alpha) ${(a as { alphaDeg: number }).alphaDeg}` : " at angle of attack (alpha) 6";
                parts.push(`the ${body} body${alpha} at Reynolds number (Re) 1200`);
            } else if (a.kind === "set_spec") {
                const kind = (a as { spec?: { geometry?: { kind?: unknown } } }).spec?.geometry?.kind;
                const re = (a as { spec?: { reynolds?: unknown } }).spec?.reynolds;
                const reText = typeof re === "number" && Number.isFinite(re) ? ` at Reynolds number (Re) ${Math.round(re)}` : "";
                if (kind === "cylinder") {
                    const r = (a as { spec?: { geometry?: { radius?: unknown } } }).spec?.geometry?.radius;
                    parts.push(typeof r === "number" && Number.isFinite(r) ? `the cylinder with radius ${r}${reText}` : `the cylinder${reText}`);
                } else if (kind === "orifice") parts.push(`the orifice plate with gap opening 0.4${reText}, a narrower gap speeds the flow like a venturi`);
                else if (kind === "block") parts.push(`the rectangular section 0.5 by 0.5${reText}`);
                else if (kind === "naca4") parts.push(`the airfoil body${reText}`);
                else parts.push(`the ${String(kind ?? "body")}${reText}`);
            } else parts.push(describeAction(a).replace(/^body /, "the "));
        }
        if (parts.length === 0) return "Applying the requested case.";
        return `Applying ${parts.join(" and ")}.`;
    } catch {
        return "Applying the requested case.";
    }
}

function makeExtra(over: Partial<TurnExtra> = {}): TurnExtra {
    return {
        model: MODAL_MODEL_ID,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        streaming: false,
        stopped: false,
        applied: [],
        rejections: [],
        pendingRuns: [],
        ...over,
    };
}

/** Phase T2 frontend: GFM table repair for tutor prose. tutorRowsText emits
 *  a header line plus data rows with no delimiter row, which remark-gfm
 *  would leave as plain paragraphs. Inserting the delimiter once turns the
 *  Before vs after block into a real table. Idempotent, never throws. */
export function tutorProseToGfm(text: string): string {
    try {
        const header = "Metric | Before | After | Delta";
        if (typeof text !== "string" || !text.includes(header)) return text;
        if (text.includes("| --- | --- | --- | ---")) return text;
        return text.replace(header, `${header}\n| --- | --- | --- | ---`);
    } catch {
        return text;
    }
}

/** Dedupe: strip the Before vs after pipe block from tutor prose when the
 *  structured payload table will render. The live and local tutor paths
 *  both append tutorRowsText to the reply text, so rendering prose GFM plus
 *  the payload table shows the same numbers twice. With rows present the
 *  payload table is the single source of truth; prose keeps everything
 *  else (explanation, Try next, caveat). With no rows the prose table is
 *  the fallback and this function is never called. Never throws. */
export function stripTutorPipeTable(text: string): string {
    try {
        if (typeof text !== "string" || !text.includes("Metric | Before | After | Delta")) return text;
        const lines = text.split("\n");
        const headerIdx = lines.findIndex((line) => line.includes("Metric | Before | After | Delta"));
        if (headerIdx < 0) return text;
        let start = headerIdx;
        if (headerIdx > 0 && lines[headerIdx - 1]?.trim() === "Before vs after") start = headerIdx - 1;
        let end = headerIdx + 1;
        while (end < lines.length && lines[end]?.includes("|")) end += 1;
        const kept = [...lines.slice(0, start), ...lines.slice(end)];
        return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    } catch {
        return text;
    }
}

/** Tutor fence contract physics-only: the prompt answers with no action
 *  fence. The console still strips every action-json fence from the
 *  rendered prose and never applies it, so a stray fence cannot write
 *  the canvas. Never throws. */
const TUTOR_FENCE_RE = /```action-json\s*([\s\S]*?)```/g;

export function tutorFenceField(raw: unknown): { stripped: string; field: string | null; fenceCount: number } {
    try {
        if (typeof raw !== "string") return { stripped: "", field: null, fenceCount: 0 };
        let fenceCount = 0;
        let field: string | null = null;
        let sawOther = false;
        for (const match of raw.matchAll(TUTOR_FENCE_RE)) {
            fenceCount += 1;
            const body = (match[1] ?? "").trim();
            if (body.length === 0) {
                sawOther = true;
                continue;
            }
            try {
                const parsed = JSON.parse(body) as unknown;
                const rec = (parsed ?? {}) as Record<string, unknown>;
                if (rec.kind === "set_field" && typeof rec.field === "string" && rec.field.length > 0) {
                    if (field === null) field = rec.field;
                    else sawOther = true;
                } else {
                    sawOther = true;
                }
            } catch {
                sawOther = true;
            }
        }
        const stripped = raw.replace(TUTOR_FENCE_RE, "").replace(/\n{3,}/g, "\n\n").trim();
        if (fenceCount !== 1 || sawOther || field === null) return { stripped, field: null, fenceCount };
        return { stripped, field, fenceCount };
    } catch {
        return { stripped: typeof raw === "string" ? raw : "", field: null, fenceCount: 0 };
    }
}

/** Phase T2 frontend: markdown body for agent and tutor turns. GFM tables,
 *  lists, bold, and inline code render as real elements inside the quiet
 *  chat prose skin. Raw HTML is never parsed (no rehype plugins), links
 *  render as inert spans, images collapse to alt text, so model output
 *  cannot inject markup or leak network requests. Script text stays inert.
 *  User turns never use this component: they render as plain text. */
export function ChatMarkdown({ children }: { children: string }): React.JSX.Element {
    return (
        <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
                table: ({ children: tableChildren }) => (
                    <div className="chatTableWrap">
                        <table className="chatTable">{tableChildren}</table>
                    </div>
                ),
                a: ({ children: linkChildren }) => <span className="chatLink">{linkChildren}</span>,
                img: ({ alt }) => (
                    <span className="chatImgAlt">{typeof alt === "string" && alt.length > 0 ? alt : "image omitted"}</span>
                ),
                pre: ({ children: preChildren }) => <pre className="chatPre">{preChildren}</pre>,
            }}
        >
            {tutorProseToGfm(typeof children === "string" ? children : "")}
        </ReactMarkdown>
    );
}

export default function AgentConsole({
    spec = undefined,
    reynolds = Number.NaN,
    cl = Number.NaN,
    cpMin = Number.NaN,
    offline = false,
    onOfflineChange = undefined,
    onApplySpec = undefined,
    client = undefined,
    cache = undefined,
    posterUrl = undefined,
    onPosterUrl = undefined,
    offlineCases = undefined,
    agentContext = null,
    onAgentAction = undefined,
    onWhatIfSweep = undefined,
    onSweepAlpha = undefined,
    chatClient = null,
    evalSink = undefined,
    spendCapUsd = SPEND_SOFT_STOP_USD,
    initialTurns = undefined,
    initialBusy = undefined,
    initialExtras = undefined,
}: AgentConsoleProps) {
    void onApplySpec;
    void onOfflineChange;
    void client;
    void cache;
    void posterUrl;
    void onPosterUrl;
    void offlineCases;
    void spec;

    const [turns, setTurns] = useState<ChatTurn[]>(() => initialTurns ?? loadTurns());
    const [extras, setExtras] = useState<Record<string, TurnExtra>>(() => initialExtras ?? {});
    const [input, setInput] = useState("");
    const [busy, setBusy] = useState<boolean>(() => initialBusy ?? false);
    const [stopping, setStopping] = useState(false);
    const [spend, setSpend] = useState<SpendTotals>({ model: MODAL_MODEL_ID, inputTokens: 0, outputTokens: 0, costUsd: 0 });
    const busyRef = useRef<boolean>(initialBusy ?? false);
    const abortRef = useRef<AbortController | null>(null);
    // Phase T2 tutor hook state. pendingTutor captures the before snapshot
    // at apply time, the settle effect fires once the settled context moves
    // past the before key. firedKeys dedupes by after caseKey, suppressedKeys
    // records manual field changes that cancel the auto set_field.
    const [pendingTutor, setPendingTutor] = useState<PendingTutor | null>(null);
    const pendingRef = useRef<PendingTutor | null>(null);
    // P3 sweep gate: while a live staircase runs, per-step set_alpha applies
    // morph the canvas but must not arm per-step tutor turns. One summary
    // turn lands at the end, and its Apply chips fire tutors normally.
    const sweepingRef = useRef(false);
    const sweepCancelRef = useRef(false);
    const [sweeping, setSweeping] = useState(false);
    const [sweepProgress, setSweepProgress] = useState<{ done: number; total: number; current: number } | null>(null);
    const firedKeysRef = useRef<Set<string>>(new Set());
    const suppressedKeysRef = useRef<Set<string>>(new Set());
    const lastVariableRef = useRef<string | null>(null);
    const ctxRef = useRef<AgentContext | null>(agentContext ?? null);
    ctxRef.current = agentContext ?? null;
    const tutorRetryRef = useRef<Map<string, TutorRetry>>(new Map());
    const chatRetryRef = useRef<Map<string, { messages: ModalMessage[]; userText: string }>>(new Map());
    // Phase T2 frontend: transcript scroll anchor. Ref callbacks never run
    // in the effect-less test harness, so the ref stays null there and the
    // scroll effect below is a silent no-op.
    const logRef = useRef<HTMLDivElement | null>(null);

    const validationCtx = useMemo(() => validationContextFor(agentContext ?? null), [agentContext]);
    const softStopped = spendExceeded(spend.costUsd, spendCapUsd);
    const forcedLocal = offline || envOffline() || softStopped;
    const forcedRef = useRef(forcedLocal);
    forcedRef.current = forcedLocal;

    const port: ModalChatPort = useMemo(() => {
        if (chatClient !== null && chatClient !== undefined) return chatClient;
        const live = new ModalClient({
            timeoutMs: MODAL_TIMEOUT_MS,
            onEval: (p) => {
                try {
                    void g_evalLog.add({
                        feature: MODAL_FEATURE,
                        model: p.model,
                        latencyMs: p.latencyMs,
                        costUsd: p.costUsd,
                        costEstimated: true,
                        cached: p.cachedTokens > 0,
                        ok: p.ok,
                        fallback: p.ok ? null : "modal",
                        hash: MODAL_FEATURE,
                    });
                } catch {
                    // Eval sink faults never break the chat path.
                }
                try {
                    if (evalSink !== undefined && evalSink !== null) evalSink({ feature: MODAL_FEATURE, model: p.model });
                } catch {
                    // Optional test sink faults never break the chat path.
                }
            },
        });
        return live;
    }, [chatClient, evalSink]);

    function pushTurn(next: ChatTurn | ChatTurn[]): void {
        setTurns((prev) => appendTurns(prev, next));
    }

    function setExtra(id: string, patch: Partial<TurnExtra>): void {
        setExtras((prev) => ({ ...prev, [id]: makeExtra({ ...prev[id], ...patch }) }));
    }

    function recordSpend(result: { usage: { inputTokens: number; outputTokens: number }; costUsd: number; model: string }): void {
        setSpend((prev) => ({
            model: result.model,
            ...addSpend(prev, result.usage, result.costUsd),
        }));
    }

    function settleParsedEnvelope(id: string, envelope: { reply: string; actions: AgentAction[]; rejections: string[] }, userText?: string): void {
        const applied: string[] = [];
        const pending: AgentAction[] = [];
        const appliedActions: AgentAction[] = [];
        const navTopics: string[] = [];
        const rejections = [...envelope.rejections];
        // Atomic setup settle: a setup envelope carrying any rejection
        // applies nothing, so a half applied case can never land. The
        // rejections render with the canvas unchanged.
        const hasSetupEnvelope = envelope.actions.some((a) => typeof a.kind === "string" && a.kind.startsWith("setup_"));
        if (hasSetupEnvelope && rejections.length > 0) {
            const patchAtomic: Partial<TurnExtra> = { rejections };
            patchAtomic.streaming = false;
            setExtra(id, patchAtomic);
            if (envelope.reply.trim().length > 0) {
                const reply = firstSentenceReply(envelope.reply);
                setTurns((prev) => {
                    const merged = prev.map((t) => (t.id === id ? { ...t, text: reply } : t));
                    saveTurns(merged.slice(-TRANSCRIPT_CAP));
                    return merged.slice(-TRANSCRIPT_CAP);
                });
            }
            return;
        }
        for (const action of envelope.actions) {
            if (RUN_KINDS.has(action.kind)) {
                pending.push(action);
                continue;
            }
            // Phase 25C NAV branch: theory nav applies through the App
            // executor like setup, but records the anchor and never arms the
            // tutor hook (no canvas case change).
            if (NAV_KINDS.has(action.kind)) {
                try {
                    onAgentAction?.(action);
                    applied.push(`Applied: ${describeAction(action)}.`);
                    const topic = (action as { topic?: unknown }).topic;
                    if (typeof topic === "string" && topic.length > 0) navTopics.push(topic);
                } catch {
                    // Executor faults never claim an untouched canvas: an
                    // earlier apply in the same envelope may have landed,
                    // so the copy names the failure without the unchanged
                    // claim unless nothing applied yet.
                    rejections.push(executorFaultCopy(action.kind, applied.length));
                }
                continue;
            }
            if (SETUP_KINDS.has(action.kind)) {
                try {
                    onAgentAction?.(action);
                    applied.push(`Applied: ${describeAction(action)}.`);
                    appliedActions.push(action);
                } catch {
                    // Executor faults never claim an untouched canvas: an
                    // earlier apply in the same envelope may have landed,
                    // so the copy names the failure without the unchanged
                    // claim unless nothing applied yet.
                    rejections.push(executorFaultCopy(action.kind, applied.length));
                }
                continue;
            }
            rejections.push(`unknown action kind ${(action as { kind: string }).kind}, ignored`);
        }
        const patch: Partial<TurnExtra> = {};
        if (applied.length > 0) patch.applied = applied;
        if (rejections.length > 0) patch.rejections = rejections;
        if (pending.length > 0) patch.pendingRuns = pending;
        if (navTopics.length > 0) patch.navTopics = navTopics;
        // Explain turns that discuss a setup but applied nothing offer
        // follow-ups as confirm-style chips, never auto applies.
        if (appliedActions.length === 0 && pending.length === 0) {
            const suggested = suggestedPromptsFor(envelope.reply);
            if (suggested.length > 0) patch.suggestedPrompts = suggested;
        }
        patch.streaming = false;
        setExtra(id, patch);
        if (envelope.reply.trim().length > 0) {
            const reply = envelope.reply;
            setTurns((prev) => {
                const merged = prev.map((t) => (t.id === id ? { ...t, text: reply } : t));
                saveTurns(merged.slice(-TRANSCRIPT_CAP));
                return merged.slice(-TRANSCRIPT_CAP);
            });
        }
        // Phase 2 tutor capture: run-only envelopes stay on the confirm
        // chip with zero tutor, auto applied envelopes arm the pending hook.
        // Rejected setups never arm the hook: with zero applied actions no
        // capture is taken, so a rejected turn can never render a taught
        // before vs after table of the unapplied case. The rejection turn
        // states what was rejected, why (naming the bound), and the nearest
        // valid alternative, with the canvas unchanged.
        // Applied plus rejection lines stay on this action turn in the
        // extras receipt (never rendered), the tutor teaching appends to
        // the same turn in place (single agent response, never a second
        // tutor turn). P3 sweep gate: while the live staircase runs, per-step applies never arm the hook. The
        // triggering user text rides along for the tutor teaching.
        if (appliedActions.length > 0 && !sweepingRef.current) {
            try {
                const before = snapshotLiteFor(agentContext ?? null);
                const next: PendingTutor = {
                    turnId: id,
                    before,
                    caseKeyBefore: before.caseKey,
                    actionsSummary: appliedActions.map((a) => a.kind).join(", "),
                    startedAt: Date.now(),
                    beforeVariable: (agentContext?.field?.variable ?? "speed") as string,
                    triggerText: typeof userText === "string" ? userText.slice(0, 2000) : appliedActions.map((a) => a.kind).join(", "),
                    baseText: envelope.reply,
                };
                pendingRef.current = next;
                setPendingTutor(next);
            } catch {
                // Tutor capture never breaks the action settle path.
            }
        }
    }

    /** Live NACA code for relative parser edits, null off section. */
    function currentSectionCode(): string | null {
        try {
            const code = agentContext?.spec?.naca?.code;
            return typeof code === "string" && /^\d{4}$/.test(code) ? code : null;
        } catch {
            return null;
        }
    }

    /** Validate one parser apply into the shared settle shape. Zero valid
     *  actions means the caller falls through to the model path instead of
     *  applying half a reshape. */
    function settleParserApply(
        apply: AirfoilApply,
        extraRejections: string[] = []
    ): { reply: string; actions: AgentAction[]; rejections: string[] } {
        const built = buildAirfoilEnvelope(
            apply,
            { alphaDeg: agentContext?.alphaDeg ?? null, reynolds: agentContext?.reynolds ?? null }
        );
        const actions: AgentAction[] = [];
        const rejections = [...extraRejections];
        for (const candidate of built.candidates) {
            const checked = validateAgentAction(candidate, validationCtx);
            if (checked.ok && checked.action !== null) actions.push(checked.action);
            else rejections.push(checked.reason ?? "parser action rejected");
        }
        return { reply: built.reply, actions, rejections };
    }

    async function settleEnvelope(id: string, rawText: string, userText?: string): Promise<void> {
        // Sweep from chat always executes: a sweep-like kind in the model
        // reply (alpha_sweep_summary etc) maps to the sweep runner instead
        // of rejecting. Model sweep replies carry no fence by contract, so
        // this only fires on a stray sweep-like fence the model invented.
        try {
            if (typeof rawText === "string" && /alpha_sweep_summary|["']kind["']\s*:\s*["'][^"']*sweep[^"']*["']/i.test(rawText)) {
                const parsedSweep = parseAgentEnvelope(rawText, validationCtx);
                const reply = parsedSweep.reply.trim().length > 0 ? parsedSweep.reply : "Running the live alpha staircase now.";
                settleParsedEnvelope(id, { reply, actions: [], rejections: [] }, userText);
                await runSweepFlow(typeof userText === "string" && userText.length > 0 ? userText : rawText);
                return;
            }
        } catch {
            // Sweep mapping faults fall through to the normal envelope.
        }
        const parsed = parseAgentEnvelope(rawText, validationCtx);
        // Raw JSON never renders as reply text: an unfenced envelope that
        // parses to actions settles with a generated single-sentence
        // physics description instead of the raw JSON.
        if (parsed.actions.length > 0 && parsed.reply.trim().length === 0) {
            try {
                const trimmed = typeof rawText === "string" ? rawText.trim() : "";
                if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
                    settleParsedEnvelope(id, { reply: describeEnvelopeActions(parsed.actions), actions: parsed.actions, rejections: parsed.rejections }, userText);
                    return;
                }
            } catch {
                // Description faults fall through to the normal settle path.
            }
        }
        // Post-rescue: the model answered with no actionable envelope, but
        // the original request parses high confidence. Settle the parser
        // envelope on the same path instead of leaving the canvas stale.
        // Airfoil rescue runs first, block rescue second, orifice rescue
        // third; all stay on the post-model path only, never a pre-submit
        // fast path.
        if (parsed.actions.length === 0 && typeof userText === "string" && userText.length > 0) {
            let intent: ReturnType<typeof parseAirfoilIntent> = null;
            try {
                intent = parseAirfoilIntent(userText, { code: currentSectionCode() });
            } catch {
                intent = null;
            }
            if (intent !== null && intent.kind === "apply" && intent.confidence >= PARSER_APPLY_CONFIDENCE) {
                const rescued = settleParserApply(intent, parsed.rejections);
                // Zero-rejection gate matches the pre-intercept fast path:
                // a partial rescue with any rejection applies nothing, keeps
                // the model reply, surfaces the rejections, canvas unchanged.
                if (rescued.actions.length > 0 && rescued.rejections.length === 0) {
                    const reply = parsed.reply.trim().length > 0 ? firstSentenceReply(parsed.reply) : collapseToOneSentence(rescued.reply);
                    settleParsedEnvelope(id, { reply, actions: rescued.actions, rejections: rescued.rejections }, userText);
                    return;
                }
                if (rescued.rejections.length > 0) {
                    const reply = parsed.reply.trim().length > 0 ? firstSentenceReply(parsed.reply) : collapseToOneSentence(rescued.reply);
                    settleParsedEnvelope(id, { reply, actions: [], rejections: rescued.rejections }, userText);
                    return;
                }
            }
            // Phase 25E block rescue beside the airfoil rescue. A square,
            // rectangle, or block request with dimensions maps to one
            // validated set_spec, rechecked through the shared validator.
            try {
                const blockApply = parseBlockIntent(userText, {
                    alphaDeg: agentContext?.alphaDeg ?? null,
                    reynolds: agentContext?.reynolds ?? null,
                });
                if (blockApply !== null && blockApply.confidence >= PARSER_APPLY_CONFIDENCE) {
                    const built = buildBlockEnvelope(blockApply, {
                        alphaDeg: agentContext?.alphaDeg ?? null,
                        reynolds: agentContext?.reynolds ?? null,
                    });
                    const actions: AgentAction[] = [];
                    const rejections = [...parsed.rejections];
                    for (const candidate of built.candidates) {
                        const checked = validateAgentAction(candidate, validationCtx);
                        if (checked.ok && checked.action !== null) actions.push(checked.action);
                        else rejections.push(checked.reason ?? "parser block action rejected");
                    }
                    if (actions.length > 0 && rejections.length === parsed.rejections.length) {
                        const reply = parsed.reply.trim().length > 0 ? firstSentenceReply(parsed.reply) : collapseToOneSentence(built.reply);
                        settleParsedEnvelope(id, { reply, actions, rejections: [] }, userText);
                        return;
                    }
                    if (rejections.length > parsed.rejections.length) {
                        const reply = parsed.reply.trim().length > 0 ? firstSentenceReply(parsed.reply) : collapseToOneSentence(built.reply);
                        settleParsedEnvelope(id, { reply, actions: [], rejections }, userText);
                        return;
                    }
                }
            } catch {
                // Block rescue faults fall through to the model envelope.
            }
            // Orifice rescue beside the block rescue. Constriction,
            // venturi, throat, tunnel, or orifice language maps to one
            // validated orifice set_spec (gap plus plate defaults, alpha
            // always 0), rechecked through the shared validator.
            try {
                const orificeApply = parseOrificeIntent(userText, {
                    reynolds: agentContext?.reynolds ?? null,
                });
                if (orificeApply !== null && orificeApply.confidence >= PARSER_APPLY_CONFIDENCE) {
                    const built = buildOrificeEnvelope(orificeApply, {
                        reynolds: agentContext?.reynolds ?? null,
                    });
                    const actions: AgentAction[] = [];
                    const rejections = [...parsed.rejections];
                    for (const candidate of built.candidates) {
                        const checked = validateAgentAction(candidate, validationCtx);
                        if (checked.ok && checked.action !== null) actions.push(checked.action);
                        else rejections.push(checked.reason ?? "parser orifice action rejected");
                    }
                    if (actions.length > 0 && rejections.length === parsed.rejections.length) {
                        const reply = parsed.reply.trim().length > 0 ? firstSentenceReply(parsed.reply) : collapseToOneSentence(built.reply);
                        settleParsedEnvelope(id, { reply, actions, rejections: [] }, userText);
                        return;
                    }
                    if (rejections.length > parsed.rejections.length) {
                        const reply = parsed.reply.trim().length > 0 ? firstSentenceReply(parsed.reply) : collapseToOneSentence(built.reply);
                        settleParsedEnvelope(id, { reply, actions: [], rejections }, userText);
                        return;
                    }
                }
            } catch {
                // Orifice rescue faults fall through to the model envelope.
            }
            // Cylinder rescue beside the orifice rescue. Explicit radius or
            // diameter phrasing maps to one validated cylinder set_spec
            // (alpha always 0, radius in [0.05, 1], diameter halves), plus
            // the stated or live Re. Bare mentions with no size fall
            // through to the bare-body rescue below.
            try {
                const cylinderApply = parseCylinderIntent(userText, {
                    reynolds: agentContext?.reynolds ?? null,
                });
                if (cylinderApply !== null && cylinderApply.confidence >= PARSER_APPLY_CONFIDENCE) {
                    const built = buildCylinderEnvelope(cylinderApply, {
                        reynolds: agentContext?.reynolds ?? null,
                    });
                    const actions: AgentAction[] = [];
                    const rejections = [...parsed.rejections];
                    for (const candidate of built.candidates) {
                        const checked = validateAgentAction(candidate, validationCtx);
                        if (checked.ok && checked.action !== null) actions.push(checked.action);
                        else rejections.push(checked.reason ?? "parser cylinder action rejected");
                    }
                    if (actions.length > 0 && rejections.length === parsed.rejections.length) {
                        const reply = parsed.reply.trim().length > 0 ? firstSentenceReply(parsed.reply) : collapseToOneSentence(built.reply);
                        settleParsedEnvelope(id, { reply, actions, rejections: [] }, userText);
                        return;
                    }
                    if (rejections.length > parsed.rejections.length) {
                        const reply = parsed.reply.trim().length > 0 ? firstSentenceReply(parsed.reply) : collapseToOneSentence(built.reply);
                        settleParsedEnvelope(id, { reply, actions: [], rejections }, userText);
                        return;
                    }
                }
            } catch {
                // Cylinder rescue faults fall through to the model envelope.
            }
            // Bare body rescue: show me a cylinder (and block, orifice, NACA
            // equivalents) applies a setup atomically with the stated Re,
            // never an unknown set_preset (only setup_* kinds exist, any
            // other preset fence is strictly rejected). Runs only when the
            // envelope carried no valid actions, on the post-model path
            // only. Explain or teach plus a body noun applies that body
            // setup when it names a body other than the current one, then
            // teaches fully on the same combined turn; pure explain-this-run
            // text with no body noun never writes. What, why, and define
            // guards keep non-body questions on the canvas-unchanged path.
            // Physics-only single-sentence replies, Modal-only path,
            // orifice alpha always 0, no solver talk, never preset names.
            try {
                const lower = userText.toLowerCase();
                const hasVerb = /\b(set|setup|show|use|try|generate|run|switch|apply|make|test|simulate|change|display|put)\b/i.test(lower);
                const isQuestion = /\bwhat\s+is\b|\bwhat'?s\b|\bwhy\b|\bexplain\b|\bcompar\w*|\bversus\b|\bvs\.?(?!\w)/i.test(lower);
                const isDefinitional = /\bwhat\s+(a|an|the)\b[\s\S]*\bis\b/i.test(lower) || /\bdefine\b|\bmeaning of\b/i.test(lower);
                const namesBody = /cylinder|karman|shedding|vortex|airfoil|naca|block|square|rectangle|rectangular|orifice|venturi|throat|constriction|tunnel/i.test(lower);
                const isExplainTeach = /\bexplain\b|\bteach\b/i.test(lower);
                const isExplainBody = isExplainTeach && namesBody;
                const requestedKind: string | null = /orifice|venturi|throat|constriction|tunnel/i.test(lower)
                    ? "orifice"
                    : /square|rectangle|rectangular|block/i.test(lower)
                        ? "block"
                        : /airfoil|naca/i.test(lower)
                            ? "naca4"
                            : /cylinder|karman|shedding|vortex/i.test(lower)
                                ? "cylinder"
                                : null;
                const currentKind = (() => {
                    try {
                        const k = (agentContext as { spec?: { kind?: unknown } } | null | undefined)?.spec?.kind;
                        return typeof k === "string" ? k : null;
                    } catch {
                        return null;
                    }
                })();
                const isSameBody = requestedKind !== null && currentKind !== null && requestedKind === currentKind;
                // Declined requests never apply: a negation word anywhere
                // in the turn blocks the bare rescue, so do not show me a
                // cylinder and explain variants with not or never leave
                // the canvas untouched with zero actions.
                const isDeclined = /\bdo\s+not\b|\bdon'?t\b|\bnever\b|\bnot\b/i.test(lower);
                const mayRescue = (hasVerb || isExplainBody) && !isDeclined && !isDefinitional && !(isQuestion && !isExplainBody) && !(isExplainBody && isSameBody);
                if (mayRescue) {
                    // Atomic Re: a stated Re rides a validated set_reynolds
                    // after the setup preset, so body plus Re land together.
                    const statedRe = parseReynolds(userText);
                    const statedReValid = (() => {
                        if (statedRe === null) return null;
                        const checked = validateAgentAction({ kind: "set_reynolds", reynolds: statedRe }, validationCtx);
                        return checked.ok && checked.action !== null ? checked.action : null;
                    })();
                    if (statedRe !== null && statedReValid === null) {
                        const checked = validateAgentAction({ kind: "set_reynolds", reynolds: statedRe }, validationCtx);
                        settleParsedEnvelope(id, { reply: parsed.reply.trim().length > 0 ? parsed.reply : `The stated Reynolds number (Re) ${statedRe} sits outside [100, 1000000], so the canvas stays unchanged.`, actions: [], rejections: [checked.reason ?? `set_reynolds ${statedRe} outside [100, 1000000]`] }, userText);
                        return;
                    }
                    const withAtomicRe = (preset: AgentAction, baseRe: number): { actions: AgentAction[]; rejections: string[] } => {
                        const checkedPreset = validateAgentAction(preset, validationCtx);
                        if (!checkedPreset.ok || checkedPreset.action === null) {
                            return { actions: [], rejections: [checkedPreset.reason ?? "preset setup rejected"] };
                        }
                        const actions: AgentAction[] = [checkedPreset.action];
                        if (statedReValid !== null) {
                            const sameAsBase = Math.round(statedRe as number) === baseRe;
                            if (!sameAsBase) actions.push(statedReValid);
                        }
                        return { actions, rejections: [] };
                    };
                    let bareActions: AgentAction[] | null = null;
                    let bareReply = "";
                    if (/high\s*(reynolds|re)\s*wake|high.?re.?wake/i.test(lower)) {
                        const settled = withAtomicRe({ kind: "setup_high_re_wake" }, 700);
                        if (settled.rejections.length === 0) {
                            bareActions = settled.actions;
                            const reText = statedRe !== null ? Math.round(statedRe) : 700;
                            bareReply = `Applying the cylinder at angle of attack (alpha) 0 and Reynolds number (Re) ${reText}.`;
                        }
                    } else if (/karman|vortex shedding|vortex street|\bshedding\b|\bcylinder\b/i.test(lower)) {
                        // Explicit radius rides one set_spec so size plus Re
                        // land together; otherwise the preset plus atomic Re.
                        const sized = parseCylinderIntent(userText, { reynolds: agentContext?.reynolds ?? null });
                        if (sized !== null && sized.confidence >= PARSER_APPLY_CONFIDENCE) {
                            const built = buildCylinderEnvelope(sized, { reynolds: agentContext?.reynolds ?? null });
                            const checked = validateAgentAction(built.candidates[0], validationCtx);
                            if (checked.ok && checked.action !== null) {
                                bareActions = [checked.action];
                                bareReply = collapseToOneSentence(built.reply);
                            }
                        } else {
                            const settled = withAtomicRe({ kind: "setup_shedding" }, 100);
                            if (settled.rejections.length === 0) {
                                bareActions = settled.actions;
                                const reText = statedRe !== null ? Math.round(statedRe) : 100;
                                bareReply = `Applying the cylinder at angle of attack (alpha) 0 and Reynolds number (Re) ${reText}.`;
                            }
                        }
                    } else if (/\bairfoil\b|\bnaca\b/i.test(lower)) {
                        const codeMatch = userText.match(/naca\s*(\d{4})/i);
                        const alphaHere = parseAirfoilIntent(userText, { code: currentSectionCode() });
                        const alphaVal = alphaHere !== null && alphaHere.kind === "apply" ? alphaHere.alphaDeg : null;
                        if (codeMatch !== null) {
                            const token = `naca${codeMatch[1]}`;
                            const canonical = token === "naca0012" || token === "naca2412" || token === "naca4412";
                            if (canonical) {
                                const preset: AgentAction = { kind: "setup_airfoil", body: token } as AgentAction;
                                if (typeof alphaVal === "number" && Number.isFinite(alphaVal)) {
                                    (preset as { alphaDeg?: number }).alphaDeg = alphaVal;
                                }
                                const settled = withAtomicRe(preset, 1200);
                                if (settled.rejections.length === 0) {
                                    bareActions = settled.actions;
                                    const reText = statedRe !== null ? Math.round(statedRe) : 1200;
                                    const alphaText = typeof alphaVal === "number" && Number.isFinite(alphaVal) ? alphaVal : 6;
                                    bareReply = `Applying the ${token.toUpperCase()} body at angle of attack (alpha) ${alphaText} and Reynolds number (Re) ${reText}.`;
                                }
                            } else {
                                // Valid non-canonical code rides one set_spec
                                // with the full parametric geometry, so the
                                // body never applies without its flow
                                // condition. Invalid codes fall through to
                                // the model envelope with canvas unchanged.
                                try {
                                    const check = isSchemaValidCode(codeMatch[1]);
                                    if (check.ok) {
                                        const liveAlpha = typeof alphaVal === "number" && Number.isFinite(alphaVal)
                                            ? alphaVal
                                            : (typeof agentContext?.alphaDeg === "number" && Number.isFinite(agentContext.alphaDeg) ? agentContext.alphaDeg : 6);
                                        const liveRe = statedRe !== null
                                            ? Math.round(statedRe)
                                            : (typeof agentContext?.reynolds === "number" && Number.isFinite(agentContext.reynolds)
                                                ? Math.round(agentContext.reynolds)
                                                : 50000);
                                        const candidate = {
                                            kind: "set_spec",
                                            spec: {
                                                geometry: { kind: "naca4", naca: { code: check.code, m: check.m, p: check.p, t: check.t }, chord: 1, alphaDeg: liveAlpha, nPoints: 120 },
                                                reynolds: liveRe,
                                                rationale: `Agent setup NACA ${check.code} alpha ${liveAlpha}.`,
                                            },
                                        } as unknown as AgentAction;
                                        const checked = validateAgentAction(candidate, validationCtx);
                                        if (checked.ok && checked.action !== null) {
                                            bareActions = [checked.action];
                                            bareReply = `Applying the NACA ${check.code} body at angle of attack (alpha) ${liveAlpha} and Reynolds number (Re) ${liveRe}.`;
                                        }
                                    }
                                } catch {
                                    bareActions = null;
                                }
                            }
                        } else {
                            const preset: AgentAction = { kind: "setup_airfoil" };
                            if (typeof alphaVal === "number" && Number.isFinite(alphaVal)) {
                                (preset as { alphaDeg?: number }).alphaDeg = alphaVal;
                            }
                            const settled = withAtomicRe(preset, 1200);
                            if (settled.rejections.length === 0) {
                                bareActions = settled.actions;
                                const reText = statedRe !== null ? Math.round(statedRe) : 1200;
                                const bareAlpha = typeof alphaVal === "number" && Number.isFinite(alphaVal) ? alphaVal : 6;
                                bareReply = `Applying the airfoil body at angle of attack (alpha) ${bareAlpha} and Reynolds number (Re) ${reText}.`;
                            }
                        }
                    } else if (/\borifice\b|\bventuri\b|\bthroat\b|\bconstriction\b|\btunnel\b/i.test(lower)) {
                        const liveRe = statedRe !== null
                            ? Math.round(statedRe)
                            : (typeof agentContext?.reynolds === "number" && Number.isFinite(agentContext.reynolds)
                                ? Math.round(agentContext.reynolds)
                                : 1000);
                        const candidate = {
                            kind: "set_spec",
                            spec: {
                                geometry: { kind: "orifice", chord: 1, alphaDeg: 0, nPoints: 120, width: 0.08, height: 0.4, center: { x: 0.5, y: 0 } },
                                reynolds: liveRe,
                                rationale: "Agent setup Orifice gap 0.4 plate 0.08.",
                            },
                        } as unknown as AgentAction;
                        const checked = validateAgentAction(candidate, validationCtx);
                        if (checked.ok && checked.action !== null) {
                            bareActions = [checked.action];
                            bareReply = `Applying the orifice plate with gap opening 0.4 at Reynolds number (Re) ${liveRe}, a narrower gap speeds the flow like a venturi.`;
                        }
                    } else if (/\bsquare\b|\brectangle\b|\brectangular\b|\bblock\b/i.test(lower)) {
                        const liveAlpha = typeof agentContext?.alphaDeg === "number" && Number.isFinite(agentContext.alphaDeg)
                            ? agentContext.alphaDeg
                            : 0;
                        const liveRe = statedRe !== null
                            ? Math.round(statedRe)
                            : (typeof agentContext?.reynolds === "number" && Number.isFinite(agentContext.reynolds)
                                ? Math.round(agentContext.reynolds)
                                : 50000);
                        const candidate = {
                            kind: "set_spec",
                            spec: {
                                geometry: { kind: "block", chord: 1, alphaDeg: liveAlpha, nPoints: 120, width: 0.5, height: 0.5, center: { x: 0.5, y: 0 } },
                                reynolds: liveRe,
                                rationale: "Agent setup Rectangle 0.5 by 0.5.",
                            },
                        } as unknown as AgentAction;
                        const checked = validateAgentAction(candidate, validationCtx);
                        if (checked.ok && checked.action !== null) {
                            bareActions = [checked.action];
                            bareReply = `Applying the rectangular section 0.5 by 0.5 at angle of attack (alpha) ${liveAlpha} and Reynolds number (Re) ${liveRe}, a narrower section speeds the flow like a venturi.`;
                        }
                    }
                    if (bareActions !== null && bareActions.length > 0) {
                        const reply = parsed.reply.trim().length > 0 ? firstSentenceReply(parsed.reply) : collapseToOneSentence(bareReply);
                        settleParsedEnvelope(id, { reply, actions: bareActions, rejections: [] }, userText);
                        return;
                    }
                }
            } catch {
                // Bare body rescue faults fall through to the model envelope.
            }
        }
        // Pressure-effect questions set the field: how does this affect
        // pressure and equivalents emit set_field cp in addition to
        // teaching, with contours following the field. Runs on the settled
        // envelope so a missing fence still paints Cp. Sweep-question
        // guards stay intact: this never arms the staircase, it only
        // appends the Cp field when the text names a pressure effect.
        try {
            if (typeof userText === "string" && userText.length > 0) {
                const lower = userText.toLowerCase();
                const namesPressure = /\bpressure\b|\bcp\b|\bcpmin\b|\bsuction\b/i.test(lower);
                const namesEffect = /\baffect\b|\beffect\b|\bimpact\b|\bchange\b|\bchanges\b|\bhow\s+does\b|\bhow\s+do\b/i.test(lower);
                const isGlossary = /\bwhat\s+is\b|\bwhat'?s\b|\bdefine\b|\bmeaning of\b/i.test(lower);
                const isNegated = /\bdo\s+not\b|\bdon'?t\b|\bnever\b|\bnot\b/i.test(lower) || /\bno\s+(pressure|cp|cpmin|suction)\b/i.test(lower);
                if (namesPressure && namesEffect && !isGlossary && !isNegated) {
                    if (parsed.actions.length >= MAX_ENVELOPE_ACTIONS) {
                        settleParsedEnvelope(id, parsed, userText);
                        return;
                    }
                    const hasCp = parsed.actions.some((a) => a.kind === "set_field" && (a as { field?: unknown }).field === "cp");
                    if (!hasCp) {
                        const checked = validateAgentAction({ kind: "set_field", field: "cp" }, validationCtx);
                        if (checked.ok && checked.action !== null) {
                            const reply = parsed.reply.trim().length > 0
                                ? parsed.reply
                                : "Pressure view applied: minimum pressure coefficient marks the strongest suction peak.";
                            settleParsedEnvelope(id, { reply, actions: [...parsed.actions, checked.action], rejections: parsed.rejections }, userText);
                            return;
                        }
                    }
                }
            }
        } catch {
            // Pressure-effect faults fall through to the model envelope.
        }
        settleParsedEnvelope(id, parsed, userText);
    }

    /** Read the reasoning trace from a Modal result without ever feeding it
     *  to the action envelope. Empty string when absent. Never throws. */
    function tutorReasoningOf(result: ModalChatResult | null | undefined): string {
        try {
            const raw = (result as unknown as { reasoning?: unknown } | null | undefined)?.reasoning;
            if (typeof raw !== "string") return "";
            const t = raw.trim();
            if (t.length === 0) return "";
            return t.slice(0, 2000);
        } catch {
            return "";
        }
    }

    function tutorRowsPayload(rows: TutorTableRow[]) {
        return rows.slice(0, 12).map((r) => ({
            metric: String(r.metric).slice(0, 80),
            before: String(r.before).slice(0, 80),
            after: String(r.after).slice(0, 80),
            delta: String(r.delta).slice(0, 80),
        }));
    }

    /** Merge a tutor patch into turn extras without dropping the action
     *  turn lines. The combined single-agent turn keeps Applied,
     *  Rejections, and pendingRuns from the apply while the teaching adds
     *  reasoning plus tutorError. Never throws. */
    function patchTutorExtra(id: string, patch: Partial<TurnExtra>): void {
        try {
            setExtras((prev) => {
                const cur = prev[id] ?? makeExtra({});
                return { ...prev, [id]: { ...cur, ...patch } };
            });
        } catch {
            // Extra faults never break the tutor path.
        }
    }

    /** Phase 2 live tutor fire. Builds deterministic rows plus concept
     *  from the before/after snapshots, then fires one Modal call per
     *  after-caseKey with a 60 s budget. Single agent response: the
     *  teaching upserts into the original applied action turn in place
     *  (capture.turnId, base reply plus teaching text plus the structured
     *  rows payload), never a second tutor turn. Physics-only prose, no
     *  field suggestion and no canvas writes: fences are stripped and
     *  never applied. Failure renders rows plus an honest error plus
     *  Retry with zero canvas writes and never local prose.
     *  A retry reuses the same turn id so the turn updates instead of
     *  stacking. Never throws. */
    async function fireTutor(capture: PendingTutor, after: TutorSnapshotLite, timedOut: boolean, reuseTutorId?: string): Promise<void> {
        const isRetry = typeof reuseTutorId === "string" && reuseTutorId.length > 0;
        // Single agent response: the teaching lands on the applied action
        // turn in place (capture.turnId), never a second tutor turn. A
        // retry reuses the same id so the turn updates instead of stacking.
        const tutorId = isRetry ? (reuseTutorId as string) : capture.turnId;
        // P3 sweep gate: per-step canvas moves never render a tutor turn.
        // The sweep summary covers the run, so return silently with zero
        // extra writes: no tutorError patch (the action turn is not a tutor
        // turn and has no Retry) and no retry registration.
        if (sweepingRef.current) {
            pendingRef.current = null;
            setPendingTutor(null);
            return;
        }
        const key = after.caseKey;
        if (firedKeysRef.current.has(key) && !isRetry) {
            pendingRef.current = null;
            setPendingTutor(null);
            return;
        }
        firedKeysRef.current.add(key);
        pendingRef.current = null;
        setPendingTutor(null);
        let rows: TutorTableRow[] = [];
        try {
            rows = buildTutorTable(capture.before, after);
        } catch {
            rows = [];
        }
        const ctx = ctxRef.current;
        let concept: TutorConcept = "general";
        try {
            concept = detectConcept({
                alphaDeg: after.alpha,
                regime: after.regime,
                bodyLabel: after.bodyLabel,
                cpMin: after.cpMin,
            });
        } catch {
            concept = "general";
        }
        const suggestion: TutorFieldSuggestion = { primary: "speed", secondary: "cp" };
        void fieldForConcept;
        void suppressedKeysRef;
        const tableText = tutorRowsText(rows);
        const timedNote = timedOut ? `\n\n${TUTOR_LOADING_LINE}` : "";
        // Single agent response: base is the original applied reply from
        // capture time, so the teaching appends once and a retry replaces
        // the previous teaching instead of stacking it.
        const baseReply = typeof capture.baseText === "string" ? capture.baseText.trim() : "";
        function upsertTutorTurn(
            teaching: string,
            status: ChatTurn["status"],
        ): void {
            const payload = {
                concept,
                primary: suggestion.primary,
                secondary: suggestion.secondary,
                rows: tutorRowsPayload(rows),
                caseKey: key.slice(0, 80),
            };
            // Single slice on the final merged text so base plus teaching never exceeds CHAT_TEXT_MAX and reload keeps the turn.
            const mergedText = baseReply.length > 0 ? `${baseReply}\n\n${teaching}` : teaching;
            const text = mergedText.slice(0, CHAT_TEXT_MAX);
            setTurns((prev) => {
                const exists = prev.some((t) => t.id === tutorId);
                let merged: ChatTurn[];
                if (exists) {
                    merged = prev.map((t) =>
                        t.id === tutorId
                            ? { ...t, text, tool: "modal" as const, status, tutor: payload }
                            : t
                    );
                } else {
                    merged = [
                        ...prev,
                        { id: tutorId, role: "assistant" as const, at: nowIso(), text, tool: "modal" as const, status, tutor: payload },
                    ];
                }
                try {
                    saveTurns(merged.slice(-TRANSCRIPT_CAP));
                } catch {
                    // Persist faults never break the tutor path.
                }
                return merged.slice(-TRANSCRIPT_CAP);
            });
        }
        // Offline demo mode: zero network, rows plus an honest cached error
        // with Retry, canvas unchanged, never local prose. Reuses the
        // clicked turn id on retry so no dead Retry remains.
        if (forcedRef.current) {
            const detail = "offline demo mode, cached table only";
            upsertTutorTurn(
                `Tutor request failed (${detail}). Canvas unchanged.\n\nBefore vs after\n${tableText}${timedNote}`,
                "cached",
            );
            patchTutorExtra(tutorId, { streaming: false, model: MODAL_MODEL_ID, reasoning: "", tutorError: detail });
            try {
                tutorRetryRef.current.set(tutorId, { capture, after, timedOut });
            } catch {
                // Retry registration never breaks the tutor path.
            }
            try {
                await g_evalLog.add({
                    feature: TUTOR_FEATURE,
                    model: MODAL_MODEL_ID,
                    latencyMs: 0,
                    costUsd: 0,
                    costEstimated: true,
                    cached: true,
                    ok: false,
                    fallback: "modal",
                    hash: TUTOR_FEATURE,
                });
            } catch {
                // Eval faults never break the tutor path.
            }
            try {
                if (evalSink !== undefined && evalSink !== null) evalSink({ feature: TUTOR_FEATURE, model: MODAL_MODEL_ID });
            } catch {
                // Optional test sink faults never break the tutor path.
            }
            return;
        }
        let messages: ModalMessage[] = [];
        try {
            messages = buildTutorMessages({ after: ctx, rows, concept: concept as never, suggestion });
        } catch {
            messages = [];
        }
        try {
            const result = await port.chat(messages, { feature: TUTOR_FEATURE, timeoutMs: MODAL_TIMEOUT_MS });
            recordSpend(result);
            const reasoning = tutorReasoningOf(result);
            const fence = tutorFenceField(result.text);
            const prose = stripTutorPipeTable(fence.stripped);
            const text = `${prose}\n\nBefore vs after\n${tableText}${timedNote}`;
            const cached = (result.usage?.cachedTokens ?? 0) > 0;
            void fence;
            upsertTutorTurn(text, cached ? "cached" : "live");
            patchTutorExtra(tutorId, {
                streaming: false,
                model: result.model,
                inputTokens: result.usage?.inputTokens ?? 0,
                outputTokens: result.usage?.outputTokens ?? 0,
                costUsd: result.costUsd ?? 0,
                reasoning,
                tutorError: null,
            });
            try {
                tutorRetryRef.current.delete(tutorId);
            } catch {
                // Retry cleanup never breaks the tutor path.
            }
            try {
                await g_evalLog.add({
                    feature: TUTOR_FEATURE,
                    model: result.model,
                    latencyMs: result.latencyMs ?? 0,
                    costUsd: result.costUsd ?? 0,
                    costEstimated: true,
                    cached,
                    ok: true,
                    fallback: null,
                    hash: TUTOR_FEATURE,
                });
            } catch {
                // Eval faults never break the tutor path.
            }
            try {
                if (evalSink !== undefined && evalSink !== null) evalSink({ feature: TUTOR_FEATURE, model: result.model });
            } catch {
                // Optional test sink faults never break the tutor path.
            }
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            const detail = (reason.length > 0 ? reason : "unknown error").slice(0, 160);
            upsertTutorTurn(
                `Tutor request failed (${detail}). Canvas unchanged.\n\nBefore vs after\n${tableText}${timedNote}`,
                "fallback",
            );
            patchTutorExtra(tutorId, { streaming: false, model: MODAL_MODEL_ID, reasoning: "", tutorError: detail });
            try {
                tutorRetryRef.current.set(tutorId, { capture, after, timedOut });
            } catch {
                // Retry registration never breaks the tutor path.
            }
            try {
                await g_evalLog.add({
                    feature: TUTOR_FEATURE,
                    model: MODAL_MODEL_ID,
                    latencyMs: 0,
                    costUsd: 0,
                    costEstimated: true,
                    cached: false,
                    ok: false,
                    fallback: "modal",
                    hash: TUTOR_FEATURE,
                });
            } catch {
                // Eval faults never break the tutor path.
            }
            try {
                if (evalSink !== undefined && evalSink !== null) evalSink({ feature: TUTOR_FEATURE, model: MODAL_MODEL_ID });
            } catch {
                // Optional test sink faults never break the tutor path.
            }
        }
    }

    /** Retry one failed tutor turn through the live Modal port. Reuses the
     *  clicked turn id so the original Retry never orphans and exactly one
     *  live Retry exists: the button hides during the flight and returns
     *  on the same turn only if the retry fails. Never throws. */
    async function onRetryTutor(tutorId: string): Promise<void> {
        try {
            const saved = tutorRetryRef.current.get(tutorId);
            if (saved === undefined) return;
            try {
                firedKeysRef.current.delete(saved.after.caseKey);
            } catch {
                // Dedupe reset never breaks retry.
            }
            tutorRetryRef.current.delete(tutorId);
            try {
                patchTutorExtra(tutorId, { streaming: true, model: MODAL_MODEL_ID, reasoning: "", tutorError: null });
            } catch {
                // Retry marking never breaks the console.
            }
            await fireTutor(saved.capture, saved.after, saved.timedOut, tutorId);
        } catch {
            // Retry faults never break the console.
        }
    }

    // Phase T2 settle effect. Fires once the settled context moves past the
    // applied key, or after TUTOR_TIMEOUT_MS with the loading line. Dedupes
    // by after caseKey, never refires on rerender with the same key.
    useSafeEffect(() => {
        // P3 sweep gate: per-step canvas moves during the staircase never
        // fire the tutor, the single sweep summary covers the run.
        if (sweepingRef.current) return;
        const capture = pendingRef.current;
        if (capture === null) return;
        const ctx = ctxRef.current;
        try {
            const currentVar = typeof ctx?.field?.variable === "string" ? ctx.field.variable : null;
            if (lastVariableRef.current !== null && currentVar !== null && currentVar !== lastVariableRef.current) {
                const curKey = typeof ctx?.caseKey === "string" && ctx.caseKey.trim().length > 0
                    ? ctx.caseKey.trim()
                    : snapshotLiteFor(ctx).caseKey;
                suppressedKeysRef.current.add(curKey);
            }
            if (currentVar !== null) lastVariableRef.current = currentVar;
        } catch {
            // Manual tracking never breaks the effect.
        }
        const after = snapshotLiteFor(ctx);
        if (after.caseKey === capture.caseKeyBefore) {
            const elapsed = Date.now() - capture.startedAt;
            if (elapsed < TUTOR_TIMEOUT_MS) {
                const wait = TUTOR_TIMEOUT_MS - elapsed;
                const timer = setTimeout(() => {
                    try {
                        const cur = pendingRef.current;
                        if (cur === null) return;
                        const nowCtx = ctxRef.current;
                        const nowAfter = snapshotLiteFor(nowCtx);
                        // Timeout with a pending capture always fires with the
                        // loading line, even when the key never moved. Dedupe
                        // inside fireTutor still guards repeats.
                        void fireTutor(cur, nowAfter, true);
                    } catch {
                        // Timeout faults never break the console.
                    }
                }, wait);
                return () => clearTimeout(timer);
            }
            // Elapsed past the timeout with the key unmoved: fire with the
            // loading line instead of discarding, the contract at the top of
            // this effect.
            void fireTutor(capture, after, true);
            return;
        }
        if (firedKeysRef.current.has(after.caseKey)) {
            pendingRef.current = null;
            setPendingTutor(null);
            return;
        }
        const settled = ctx?.frameSettled === true;
        const elapsed = Date.now() - capture.startedAt;
        if (settled) {
            void fireTutor(capture, after, false);
            return;
        }
        if (elapsed >= TUTOR_TIMEOUT_MS) {
            void fireTutor(capture, after, true);
            return;
        }
        const wait = TUTOR_TIMEOUT_MS - elapsed;
        const timer = setTimeout(() => {
            try {
                const cur = pendingRef.current;
                if (cur === null) return;
                if (firedKeysRef.current.has(snapshotLiteFor(ctxRef.current).caseKey)) {
                    pendingRef.current = null;
                    setPendingTutor(null);
                    return;
                }
                void fireTutor(cur, snapshotLiteFor(ctxRef.current), true);
            } catch {
                // Timeout faults never break the console.
            }
        }, wait);
        return () => clearTimeout(timer);
    }, [agentContext, pendingTutor]);

    // Phase T2 frontend: keep the latest turn in view. Quiet instant jump,
    // no animation, so reduced motion needs no override. Runs on every
    // transcript change, streaming flushes included.
    useSafeEffect(() => {
        try {
            const el = logRef.current;
            if (el !== null && el !== undefined) el.scrollTop = el.scrollHeight;
        } catch {
            // Scroll faults never break the console.
        }
    }, [turns]);

    function pushOfflineAssistant(userText: string): void {
        const id = nextId();
        const safeText = userText.slice(0, 200);
        pushTurn({
            id,
            role: "assistant",
            at: nowIso(),
            text: `Offline demo mode, cached table only. You asked: ${safeText}. Canvas unchanged.`,
            tool: "modal",
            status: "cached",
        });
        setExtra(id, makeExtra({ streaming: false, model: MODAL_MODEL_ID, chatError: "offline demo mode" }));
        try {
            const ctx = agentContext ?? null;
            const contextJson = JSON.stringify(physicsViewFor(ctx)).slice(0, 3500);
            chatRetryRef.current.set(id, {
                messages: [
                    { role: "system", content: `You are the GearFlow tunnel assistant. Live context: ${contextJson}` },
                    { role: "user", content: userText.slice(0, 2000) },
                ],
                userText,
            });
        } catch {
            // Retry registration never breaks the offline path.
        }
    }

    /** Honest live failure turn with Retry. Reuses the pending turn id,
     *  names the failure reason, keeps zero canvas writes, and never falls
     *  back to local prose on the live path. */
    function settleLiveError(id: string, err: unknown, retry?: { messages: ModalMessage[]; userText: string }): void {
        const reason = err instanceof Error ? err.message : String(err);
        const detail = reason.length > 0 ? reason.slice(0, 160) : "unknown error";
        const honest = `Live request failed (${detail}). Canvas unchanged.`;
        setTurns((prev) => {
            const merged = prev.map((t) =>
                t.id === id ? { ...t, text: honest, tool: "modal" as const, status: "fallback" as const } : t
            );
            saveTurns(merged.slice(-TRANSCRIPT_CAP));
            return merged.slice(-TRANSCRIPT_CAP);
        });
        setExtra(id, { streaming: false, model: MODAL_MODEL_ID, chatError: detail });
        try {
            if (retry !== undefined) chatRetryRef.current.set(id, retry);
        } catch {
            // Retry registration never breaks the error path.
        }
    }

    /** Retry one failed live turn through the Modal port with the original
     *  messages. Never throws. */
    async function onRetryChat(turnId: string): Promise<void> {
        try {
            const saved = chatRetryRef.current.get(turnId);
            if (saved === undefined || busyRef.current) return;
            busyRef.current = true;
            setBusy(true);
            setStopping(false);
            const controller = new AbortController();
            abortRef.current = controller;
            setExtra(turnId, makeExtra({ streaming: true, model: MODAL_MODEL_ID, chatError: null }));
            setTurns((prev) => {
                const merged = prev.map((t) => (t.id === turnId ? { ...t, text: "", tool: "modal" as const, status: "live" as const } : t));
                saveTurns(merged.slice(-TRANSCRIPT_CAP));
                return merged.slice(-TRANSCRIPT_CAP);
            });
            try {
                await runStream(turnId, saved.messages, controller, saved.userText);
            } finally {
                abortRef.current = null;
                busyRef.current = false;
                setBusy(false);
                setStopping(false);
            }
        } catch {
            // Retry faults never break the console.
        }
    }

    async function runStream(id: string, messages: ModalMessage[], controller: AbortController, userText: string): Promise<void> {
        let fullText = "";
        let lastResult: ModalChatResult | null = null;
        let lastFlush = Date.now();
        try {
            const gen = port.streamChat(messages, { feature: MODAL_FEATURE, signal: controller.signal, timeoutMs: MODAL_TIMEOUT_MS });
            for (;;) {
                const step = await gen.next();
                if (step.done) {
                    lastResult = step.value;
                    fullText = step.value.text;
                    break;
                }
                fullText = step.value.text;
                const now = Date.now();
                if (now - lastFlush >= STREAM_FLUSH_MS) {
                    const snapshot = fullText;
                    lastFlush = now;
                    setTurns((prev) => {
                        const merged = prev.map((t) => (t.id === id ? { ...t, text: snapshot } : t));
                        saveTurns(merged.slice(-TRANSCRIPT_CAP));
                        return merged.slice(-TRANSCRIPT_CAP);
                    });
                }
            }
        } catch (e) {
            const aborted = controller.signal.aborted || (e instanceof Error && e.name === "AbortError");
            if (aborted) {
                const snapshot = fullText.length > 0 ? `${fullText} (stopped)` : "Stopped, partial reply discarded.";
                setTurns((prev) => {
                    const merged = prev.map((t) => (t.id === id ? { ...t, text: snapshot, status: "fallback" as const } : t));
                    saveTurns(merged.slice(-TRANSCRIPT_CAP));
                    return merged.slice(-TRANSCRIPT_CAP);
                });
                setExtra(id, { stopped: true, streaming: false });
                return;
            }
            // One direct non streaming retry on a stream failure, then an
            // honest error turn with Retry. No local prose fallback on the live path.
            try {
                const plain = await port.chat(messages, { feature: MODAL_FEATURE, signal: controller.signal, timeoutMs: MODAL_TIMEOUT_MS });
                lastResult = plain;
                fullText = plain.text;
            } catch (retryErr) {
                settleLiveError(id, retryErr, { messages, userText });
                return;
            }
        }
        if (fullText.trim().length === 0) {
            try {
                const plain = await port.chat(messages, { feature: MODAL_FEATURE, signal: controller.signal, timeoutMs: MODAL_TIMEOUT_MS });
                lastResult = plain;
                fullText = plain.text;
            } catch (retryErr) {
                settleLiveError(id, retryErr, { messages, userText });
                return;
            }
        }
        if (fullText.trim().length === 0) {
            settleLiveError(id, new Error("empty reply"), { messages, userText });
            return;
        }
        const cached = lastResult !== null && lastResult.usage.cachedTokens > 0;
        setTurns((prev) => {
            const merged = prev.map((t) =>
                t.id === id ? { ...t, text: fullText, tool: "modal" as const, status: (cached ? "cached" : "live") as ChatTurn["status"] } : t
            );
            saveTurns(merged.slice(-TRANSCRIPT_CAP));
            return merged.slice(-TRANSCRIPT_CAP);
        });
        if (lastResult !== null) {
            recordSpend(lastResult);
            setExtra(id, {
                model: lastResult.model,
                inputTokens: lastResult.usage.inputTokens,
                outputTokens: lastResult.usage.outputTokens,
                costUsd: lastResult.costUsd,
                streaming: false,
                reasoning: tutorReasoningOf(lastResult),
            });
        } else {
            setExtra(id, { streaming: false });
        }
        await settleEnvelope(id, fullText, userText);
    }

    /** P3 live what-if sweep. Analytic only, always runs the staircase:
     *  steps through the injected onWhatIfSweep stepper, morphs the
     *  canvas per point through onAgentAction set_alpha, suppresses
     *  per-step tutor turns, then lands one summary with the delta table
     *  plus per-point Apply chips. The summary and its teaching ride one
     *  Modal call when the network is up; when truly down the turn shows
     *  rows plus an honest error with zero local prose. Stop leaves the
     *  last applied alpha in place with an honest note. Never throws. */
    async function runSweepFlow(userText: string): Promise<void> {
        const bodyLabel = (() => {
            try {
                const label = agentContext?.bodyLabel;
                if (typeof label === "string" && label.trim().length > 0) return label.trim().slice(0, 80);
            } catch {
                // Body label faults fall back below.
            }
            return "current body";
        })();
        // Orifice gate: the plate has no angle of attack (alpha invariant
        // 0), so the staircase never runs and alpha is never written.
        // Teach the gap instead (venturi Try next style), canvas unchanged.
        const sweepBodyKind = (() => {
            try {
                const kind = (agentContext as { spec?: { kind?: unknown } } | null | undefined)?.spec?.kind;
                return typeof kind === "string" ? kind : "";
            } catch {
                return "";
            }
        })();
        if (isOrificeSweepBody(sweepBodyKind, bodyLabel)) {
            try {
                const gateId = nextId();
                pushTurn({
                    id: gateId,
                    role: "assistant",
                    at: nowIso(),
                    text: "The orifice plate has no angle of attack, alpha stays 0, so there is no stall staircase to run. Canvas unchanged. Try next: reason about the same plate with a narrower gap opening at the same Reynolds number (Re) and how the jet speed shifts minimum pressure coefficient, a narrower gap speeds the flow like a venturi.",
                    tool: "modal",
                    status: "offline",
                });
                setExtra(gateId, makeExtra({ streaming: false }));
            } catch {
                // Gate notice faults never break the console.
            }
            return;
        }
        sweepingRef.current = true;
        sweepCancelRef.current = false;
        setSweeping(true);
        setSweepProgress({ done: 0, total: SWEEP_ALPHAS.length, current: SWEEP_ALPHAS[0] });
        try {
            try {
                pendingRef.current = null;
                setPendingTutor(null);
            } catch {
                // Pending reset faults never break the sweep.
            }
            const runId = nextId();
            pushTurn({ id: runId, role: "assistant", at: nowIso(), text: "The agent runs the live alpha staircase now, canvas stepping through -4 to 12 deg.", tool: "modal", status: "offline" });
            setExtra(runId, makeExtra({ streaming: true, sweepProgress: { done: 0, total: SWEEP_ALPHAS.length, current: SWEEP_ALPHAS[0] } }));
            const startAlpha = (() => {
                try {
                    const v = agentContext?.alphaDeg;
                    return typeof v === "number" && Number.isFinite(v) ? v : null;
                } catch {
                    return null;
                }
            })();
            let result: { points: Array<{ alphaDeg: number; cl: number | null; cpMin: number | null; solveMs: number | null; dClVsPrev: number | null; dCpVsPrev: number | null }>; cancelled: boolean; startedFrom: number | null; finalAlpha: number | null };
            try {
                result = await runAlphaSweep({
                    stepAlpha: async (alphaDeg: number) => {
                        try {
                            if (typeof onWhatIfSweep === "function") return await onWhatIfSweep(alphaDeg);
                        } catch {
                            // Stepper faults land as n/a cells below.
                        }
                        return { cl: null, cpMin: null, solveMs: null };
                    },
                    onApply: async (alphaDeg: number) => {
                        try {
                            if (typeof onSweepAlpha === "function") {
                                await onSweepAlpha(alphaDeg);
                            } else {
                                onAgentAction?.({ kind: "set_alpha", alphaDeg });
                            }
                        } catch {
                            // Canvas faults stay local, samples still recorded.
                        }
                    },
                    isCancelled: () => sweepCancelRef.current,
                    onProgress: (done: number, total: number, current: number) => {
                        try {
                            setSweepProgress({ done, total, current });
                            setExtra(runId, { sweepProgress: { done, total, current } });
                        } catch {
                            // Progress faults never break the sweep.
                        }
                    },
                    // P3 sweep dwell: each intermediate alpha holds 5 s so
                    // frames load properly. The dwell polls the Stop flag
                    // in short slices, so Stop aborts the wait promptly
                    // mid-dwell and keeps the last applied alpha.
                    yieldPaint: () => sweepDwellYield(() => sweepCancelRef.current),
                    startAlpha,
                });
            } catch {
                result = { points: [], cancelled: true, startedFrom: startAlpha, finalAlpha: null };
            }
            let rows: Array<{ metric: string; before: string; after: string; delta: string }> = [];
            try {
                rows = sweepToTutorRows(result, bodyLabel);
            } catch {
                rows = [];
            }
            const tableText = tutorRowsText(rows);
            const summaryId = nextId();
            const unfinished = result.cancelled === true && result.points.length < SWEEP_ALPHAS.length;
            const caseKey = `sweep|a${SWEEP_ALPHAS[0]}-a${SWEEP_ALPHAS[SWEEP_ALPHAS.length - 1]}|n${result.points.length}${unfinished ? "|stopped" : ""}`;
            const payloadRows = rows.slice(0, 12).map((row) => ({
                metric: String(row.metric).slice(0, 80),
                before: String(row.before).slice(0, 80),
                after: String(row.after).slice(0, 80),
                delta: String(row.delta).slice(0, 80),
            }));
            const tutorPayload: NonNullable<ChatTurn["tutor"]> = {
                concept: "general",
                primary: "speed",
                secondary: "cp",
                rows: payloadRows,
                caseKey: caseKey.slice(0, 80),
            };
            const sweepExtra = makeExtra({
                streaming: false,
                sweepPoints: result.points.map((p) => ({ alphaDeg: p.alphaDeg, cl: p.cl, cpMin: p.cpMin })),
                sweepCancelled: result.cancelled,
            });
            // Truly down: rows plus an honest error, zero local prose. The
            // staircase effect stands apart from the missing summary: flow
            // stays held at the last applied alpha.
            if (forcedRef.current) {
                const detail = "offline demo mode, cached table only";
                const offlineText = result.points.length === 0
                    ? `Sweep summary unavailable offline (${detail}). No sweep points landed, canvas unchanged.`
                    : `Sweep summary unavailable offline (${detail}). Staircase effect kept: ${result.points.length} of ${SWEEP_ALPHAS.length} alphas sampled, flow held at the last applied alpha. Summary teaching is missing; per-point Apply chips below restage any alpha.`;
                pushTurn({
                    id: summaryId,
                    role: "assistant",
                    at: nowIso(),
                    text: `${offlineText}\n\nBefore vs after\n${tableText}`,
                    tool: "modal",
                    status: "offline",
                    tutor: tutorPayload,
                });
                setExtra(summaryId, { ...sweepExtra, chatError: detail });
            } else {
                // Network up: one Modal call carries the summary plus the
                // teaching, citing only the swept table numbers. A Modal
                // failure lands rows plus an honest error, never local prose.
                try {
                    const pointsText = result.points
                        .map((p) => `alpha ${p.alphaDeg} deg, Cl ${p.cl === null ? "n/a" : p.cl.toFixed(3)}, CpMin ${p.cpMin === null ? "n/a" : p.cpMin.toFixed(3)}`)
                        .join("\n");
                    let liveCtx = "{}";
                    try {
                        liveCtx = JSON.stringify(physicsViewFor(agentContext ?? null)).slice(0, 3500);
                    } catch {
                        liveCtx = "{}";
                    }
                    const messages: ModalMessage[] = [
                        {
                            role: "system",
                            content: [
                                "You are the GearFlow flow tutor.",
                                "Teach the sweep result in plain grade 8 to 10 language, like an interactive textbook.",
                                "First mention per turn expands each term, then symbols after: lift coefficient (Cl), pressure coefficient (Cp), angle of attack (alpha), Reynolds number (Re).",
                                "Cite only the Before vs after table and the swept points below, never invent numbers. When a value reads n/a, call it pending.",
                                "Final reply order: one sentence summary of the staircase, Why (one cause and effect), Try next (one physics-only thought experiment: nudge angle of attack (alpha) by 1 deg and compare). Never a field switch, never a view change, never a run.",
                                "No solver or tech stack talk: teach flow physics only. The potential flow picture omits separation and stall, so treat higher alpha lift past 12 deg as unvalidated.",
                                "Answer with no action fence and no field suggestion.",
                            ].join("\n"),
                        },
                        {
                            role: "user",
                            content: [
                                "Concept: alpha sweep",
                                `The user asked: ${userText.slice(0, 500)}`,
                                "Swept points:",
                                pointsText.length > 0 ? pointsText : "no points landed",
                                "Before vs after table:",
                                tableText,
                                `Live context: ${liveCtx}`,
                                "Summarize this sweep.",
                            ].join("\n"),
                        },
                    ];
                    const modalResult = await port.chat(messages, { feature: MODAL_FEATURE, timeoutMs: MODAL_TIMEOUT_MS });
                    recordSpend(modalResult);
                    try {
                        await g_evalLog.add({
                            feature: MODAL_FEATURE,
                            model: modalResult.model,
                            latencyMs: modalResult.latencyMs ?? 0,
                            costUsd: modalResult.costUsd ?? 0,
                            costEstimated: true,
                            cached: (modalResult.usage?.cachedTokens ?? 0) > 0,
                            ok: true,
                            fallback: null,
                            hash: MODAL_FEATURE,
                        });
                    } catch {
                        // Eval faults never break the sweep path.
                    }
                    try {
                        if (evalSink !== undefined && evalSink !== null) evalSink({ feature: MODAL_FEATURE, model: modalResult.model });
                    } catch {
                        // Optional test sink faults never break the sweep path.
                    }
                    const reasoning = tutorReasoningOf(modalResult);
                    const fence = tutorFenceField(modalResult.text);
                    void fence;
                    const prose = stripTutorPipeTable(fence.stripped);
                    const cached = (modalResult.usage?.cachedTokens ?? 0) > 0;
                    pushTurn({
                        id: summaryId,
                        role: "assistant",
                        at: nowIso(),
                        text: `${prose}\n\nBefore vs after\n${tableText}`,
                        tool: "modal",
                        status: cached ? "cached" : "live",
                        tutor: tutorPayload,
                    });
                    setExtra(summaryId, {
                        ...sweepExtra,
                        model: modalResult.model,
                        inputTokens: modalResult.usage?.inputTokens ?? 0,
                        outputTokens: modalResult.usage?.outputTokens ?? 0,
                        costUsd: modalResult.costUsd ?? 0,
                        reasoning,
                    });
                } catch (err) {
                    const reason = err instanceof Error ? err.message : String(err);
                    const detail = (reason.length > 0 ? reason : "unknown error").slice(0, 160);
                    const failText = `Sweep summary request failed (${detail}). Staircase effect kept: ${result.points.length} of ${SWEEP_ALPHAS.length} alphas sampled, flow held at the last applied alpha. Summary teaching is missing; per-point Apply chips below restage any alpha.`;
                    pushTurn({
                        id: summaryId,
                        role: "assistant",
                        at: nowIso(),
                        text: `${failText}\n\nBefore vs after\n${tableText}`,
                        tool: "modal",
                        status: "fallback",
                        tutor: tutorPayload,
                    });
                    setExtra(summaryId, { ...sweepExtra, chatError: detail });
                }
            }
            setTurns((prev) => {
                const stopped = result.cancelled === true && result.points.length < SWEEP_ALPHAS.length;
                const merged = prev.map((t) => (t.id === runId
                    ? { ...t, text: stopped ? `Sweep stopped at ${result.points.length} of ${SWEEP_ALPHAS.length} points, leaving the last applied alpha in place. Summary follows.` : `Sweep complete, ${result.points.length} of ${SWEEP_ALPHAS.length} points. Summary follows.` }
                    : t));
                try {
                    saveTurns(merged.slice(-TRANSCRIPT_CAP));
                } catch {
                    // Persist faults never break the sweep.
                }
                return merged.slice(-TRANSCRIPT_CAP);
            });
            setExtra(runId, { streaming: false });
        } finally {
            sweepingRef.current = false;
            setSweeping(false);
            setSweepProgress(null);
        }
    }

    async function onSubmit(raw: string): Promise<void> {
        const text = raw.trim();
        if (text.length === 0 || busyRef.current) return;
        busyRef.current = true;
        setBusy(true);
        setStopping(false);
        const userTurn: ChatTurn = { id: nextId(), role: "user", text: text.slice(0, 2000), at: nowIso() };
        pushTurn(userTurn);
        setInput("");
        // P3 sweep fast path: the sweep check sits before any
        // forcedLocal/offline branch, so the live analytic staircase with
        // canvas morph, Stop, and per-point Apply chips always runs. The
        // summary and its teaching ride Modal when the network is up and
        // land an honest error only when truly down.
        if (isAlphaSweepIntent(text)) {
            try {
                await runSweepFlow(text);
            } catch {
                // Sweep faults never break the console.
            } finally {
                busyRef.current = false;
                setBusy(false);
                setStopping(false);
            }
            return;
        }
        if (forcedLocal) {
            pushOfflineAssistant(text);
            busyRef.current = false;
            setBusy(false);
            return;
        }
        // R3 parser fast path is removed: every live turn goes through the
        // Modal port below so the model sees the full context. The shared
        // validator still gates every settled action in settleEnvelope.
        const controller = new AbortController();
        abortRef.current = controller;
        const id = nextId();
        pushTurn({ id, role: "assistant", at: nowIso(), text: "", tool: "modal", status: "live" });
        setExtra(id, makeExtra({ streaming: true }));
        try {
            const messages = buildModalMessages(text, agentContext ?? null, [...turns, userTurn]);
            await runStream(id, messages, controller, text);
        } finally {
            abortRef.current = null;
            busyRef.current = false;
            setBusy(false);
            setStopping(false);
        }
    }

    function onStop(): void {
        // P3 sweep Stop: the staircase polls this flag between points.
        if (sweepingRef.current) sweepCancelRef.current = true;
        try {
            abortRef.current?.abort();
            setStopping(true);
        } catch {
            // Abort faults never break the Stop control.
        }
    }

    /** P3 sweep Stop button on the progress row. Leaves the last applied
     *  alpha in place, the summary notes the early stop honestly. */
    function onStopSweep(): void {
        try {
            sweepCancelRef.current = true;
            setStopping(true);
        } catch {
            // Stop faults never break the sweep control.
        }
    }

    /** P3 per-point Apply chip. Rides the validated settle path so the tutor
     *  hook arms normally and rejections surface on a chip turn. Faults stay
     *  local to the chip control. */
    function onApplySweepAlpha(alphaDeg: number): void {
        try {
            // Orifice gate: per-point Apply chips never move alpha on the
            // plate (alpha invariant 0), canvas unchanged.
            try {
                const applyKind = (agentContext as { spec?: { kind?: unknown } } | null | undefined)?.spec?.kind;
                const applyLabel = typeof agentContext?.bodyLabel === "string" ? agentContext.bodyLabel : "";
                if (isOrificeSweepBody(applyKind, applyLabel)) {
                    const id = nextId();
                    pushTurn({ id, role: "assistant", at: nowIso(), text: "The orifice plate has no angle of attack, alpha stays 0, so sweep Apply leaves the plate unchanged. Canvas unchanged.", tool: "modal", status: "offline" });
                    setExtra(id, makeExtra({ streaming: false }));
                    return;
                }
            } catch {
                // Gate check faults fall through to validation below.
            }
            const checked = validateAgentAction({ kind: "set_alpha", alphaDeg }, validationCtx);
            if (!checked.ok || checked.action === null) {
                const reason = typeof checked.reason === "string" && checked.reason.length > 0
                    ? checked.reason
                    : `set_alpha alphaDeg ${String(alphaDeg)} rejected`;
                const id = nextId();
                pushTurn({ id, role: "assistant", at: nowIso(), text: `Sweep apply for angle of attack (alpha) ${alphaDeg} deg rejected: ${reason}`, tool: "modal", status: "offline" });
                setExtra(id, makeExtra({ streaming: false, rejections: [reason] }));
                return;
            }
            const id = nextId();
            const note = `Applying angle of attack (alpha) ${alphaDeg} deg from the sweep.`;
            pushTurn({ id, role: "assistant", at: nowIso(), text: note, tool: "modal", status: "offline" });
            setExtra(id, makeExtra({ streaming: false }));
            settleParsedEnvelope(id, { reply: note, actions: [checked.action], rejections: [] }, `Apply angle of attack (alpha) ${alphaDeg} deg from the sweep.`);
        } catch {
            // Validation faults never break the chip control.
        }
    }

    function onConfirmRun(turnId: string, action: AgentAction): void {
        try {
            onAgentAction?.(action);
        } catch {
            // Executor faults stay local to the confirm control.
        }
        setExtras((prev) => {
            const cur = prev[turnId] ?? makeExtra({});
            return {
                ...prev,
                [turnId]: {
                    ...cur,
                    pendingRuns: cur.pendingRuns.filter((p) => p !== action),
                    applied: [...cur.applied, `Applied after confirm: ${describeAction(action)}.`],
                },
            };
        });
    }

    /** Composer key handling for the chat terminal: Enter rides the
     *  native form submit to send, Escape stops a live stream or sweep and
     *  otherwise releases focus, Tab keeps its native cycle order through
     *  the prompt selects and the input. Never throws. */
    function onComposerKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
        try {
            if (e.key === "Enter") {
                // Native form submit sends. No preventDefault, no Stop.
                return;
            }
            if (e.key === "Tab") {
                // Native order through selects and input. Never intercepted.
                return;
            }
            if (e.key === "Escape") {
                if (busyRef.current || sweepingRef.current) {
                    e.preventDefault();
                    onStop();
                } else {
                    e.currentTarget.blur();
                }
            }
        } catch {
            // Key handling never breaks the composer.
        }
    }

    // Caret-following line cursor. A hidden mirror span measures the text
    // before the native selection, the 2px line parks there with a 90ms
    // transform transition. caret-color flips to transparent only after the
    // first measurement so SSR and no-JS keep the native caret.
    const inputRef = useRef<HTMLInputElement | null>(null);
    const mirrorRef = useRef<HTMLSpanElement | null>(null);
    const [caretX, setCaretX] = useState(0);
    const [caretMeasured, setCaretMeasured] = useState(false);

    function measureCaret(): void {
        try {
            const el = inputRef.current;
            const mirror = mirrorRef.current;
            if (el === null || mirror === null) return;
            const value = typeof el.value === "string" ? el.value : "";
            const rawPos = typeof el.selectionStart === "number" ? el.selectionStart : value.length;
            const pos = Number.isFinite(rawPos) ? Math.max(0, Math.min(value.length, rawPos as number)) : value.length;
            const head = value.slice(0, pos);
            mirror.textContent = head.length > 0 ? head : "\u00a0";
            const w = (mirror as unknown as { offsetWidth?: unknown }).offsetWidth;
            setCaretX(typeof w === "number" && Number.isFinite(w) ? w : 0);
            setCaretMeasured(true);
        } catch {
            // Measurement never breaks the composer.
        }
    }

    useSafeEffect(() => {
        try {
            measureCaret();
        } catch {
            // Measurement never breaks the composer.
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [input]);

    return (
        <div className="agentConsole tuiConsole">
            <div className="chatLog" ref={logRef} role="log" aria-label="Agent chat transcript" aria-live="polite">
                {turns.length === 0 && (
                    <p className="mSub">Ask to explain the run, set up NACA 2412, or change Reynolds number (Re).</p>
                )}
                {turns.map((t) => {
                    const extra = extras[t.id];
                    const isAssistant = t.role === "assistant";
                    const isTutor = isAssistant && t.tutor !== undefined && t.tutor !== null;
                    // Dedupe: when structured rows exist the payload table is
                    // the single table; the prose pipe block is stripped so
                    // Before vs after renders once. With no rows the prose
                    // GFM table stays as the fallback.
                    const tutorRows = isTutor ? (t.tutor?.rows ?? []) : [];
                    const hasTutorRows = isTutor && Array.isArray(tutorRows) && tutorRows.length > 0;
                    const proseText = hasTutorRows ? stripTutorPipeTable(t.text) : t.text;
                    const rawStatus = typeof t.status === "string" && t.status.length > 0 ? t.status : "error";
                    const statusText = rawStatus === "fallback" ? "error" : rawStatus;
                    const tutorErrorText = typeof extra?.tutorError === "string" ? extra.tutorError.trim() : "";
                    const chatErrorText = typeof extra?.chatError === "string" ? extra.chatError.trim() : "";
                    return (
                        <div key={t.id} className={`chatTurn tuiTurn ${t.role}${isTutor ? " tutorTurn" : ""}`}>
                            <div className="chatHead tuiHead">
                                <span className="mono tuiRole">{t.role === "user" ? "You" : "Tutor"}</span>
                                {isAssistant && statusText === "live" && (
                                    <span className="liveDotWrap">
                                        <span className="liveDot" aria-hidden="true" />
                                        <span className="visuallyHidden">live</span>
                                    </span>
                                )}
                                {isAssistant && statusText !== "live" && statusText !== "cached" && (
                                    <span className={`badge tuiPill status-${statusText === "offline" ? "warn" : "fail"}`}>{statusText}</span>
                                )}
                                {extra?.streaming === true && <span className="badge tuiPill status-info">streaming</span>}
                                {extra?.stopped === true && <span className="badge tuiPill status-warn">stopped</span>}
                            </div>
                            {t.role === "user" ? (
                                <p className="chatText">{t.text.length > 0 ? t.text : "Composing reply"}</p>
                            ) : t.text.length > 0 ? (
                                proseText.trim().length > 0 ? (
                                    <div className="chatProse">
                                        <ChatMarkdown>{proseText}</ChatMarkdown>
                                    </div>
                                ) : null
                            ) : (
                                <p className="chatText">Composing reply</p>
                            )}
                            {isAssistant && tutorErrorText.length > 0 && (
                                <p className="mSub mono" role="note">Tutor error: {tutorErrorText}. Canvas unchanged.</p>
                            )}
                            {isAssistant && isTutor && tutorErrorText.length > 0 && (
                                <button
                                    type="button"
                                    className="chip retryChip"
                                    onClick={() => void onRetryTutor(t.id)}
                                    aria-label="Retry tutor request"
                                >
                                    Retry
                                </button>
                            )}
                            {isAssistant && !isTutor && chatErrorText.length > 0 && (
                                <button
                                    type="button"
                                    className="chip retryChip"
                                    onClick={() => void onRetryChat(t.id)}
                                    aria-label="Retry chat request"
                                >
                                    Retry
                                </button>
                            )}
                            {(extra?.rejections ?? []).map((note, i) => (
                                <p key={`rejected-${i}`} className="mSub mono" role="note">Rejected: {note}</p>
                            ))}
                            {(extra?.pendingRuns ?? []).map((run, i) => (
                                <button
                                    key={`confirm-${i}`}
                                    type="button"
                                    className="mBtn mApply"
                                    onClick={() => onConfirmRun(t.id, run)}
                                    aria-label={run.kind === "run_lbm" ? "Confirm run" : "Cancel run"}
                                >
                                    {run.kind === "run_lbm" ? "Confirm run" : "Cancel run"}
                                </button>
                            ))}
                            {(extra?.suggestedPrompts ?? []).map((prompt, i) => (
                                <button
                                    key={`suggest-${i}`}
                                    type="button"
                                    className="mBtn mApply"
                                    onClick={() => void onSubmit(prompt)}
                                    disabled={busy}
                                    aria-label={`Ask: ${prompt}`}
                                >
                                    {prompt}
                                </button>
                            ))}
                            {t.tutor !== undefined && t.tutor !== null && (
                                <div className="tutorBlock" aria-label="Before versus after quantities">
                                    {hasTutorRows && (
                                    <div className="chatTableWrap tutorTableWrap">
                                        <table className="chatTable tutorTable">
                                            <caption className="visuallyHidden">Before versus after quantities</caption>
                                            <thead>
                                                <tr>
                                                    <th scope="col">Quantity</th>
                                                    <th scope="col">Before</th>
                                                    <th scope="col">After</th>
                                                    <th scope="col">Change</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {(t.tutor.rows ?? []).map((row, i) => (
                                                    <tr key={`tutor-row-${i}`}>
                                                        <th scope="row">{row.metric}</th>
                                                        <td>{row.before}</td>
                                                        <td>{row.after}</td>
                                                        <td>{row.delta}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                    )}
                                </div>
                            )}
                            {(extra?.sweepPoints !== undefined && extra.sweepPoints !== null && extra.sweepPoints.length > 0) && (
                                <div className="sweepPoints" role="group" aria-label="Sweep per-point apply chips">
                                    {extra.sweepCancelled === true && (
                                        <p className="mSub mono" role="note">Stopped early, leaving the last applied alpha in place.</p>
                                    )}
                                    {extra.sweepPoints.map((point) => (
                                        <button
                                            key={`sweep-apply-${point.alphaDeg}`}
                                            type="button"
                                            className="chip sweepChip"
                                            onClick={() => onApplySweepAlpha(point.alphaDeg)}
                                            aria-label={`Apply angle of attack (alpha) ${point.alphaDeg} degrees`}
                                        >
                                            Apply {point.alphaDeg} deg
                                        </button>
                                    ))}
                                </div>
                            )}
                            {(extra?.sweepProgress !== undefined && extra.sweepProgress !== null) && (
                                <p className="mSub mono" role="status">
                                    Sweep {extra.sweepProgress.done} of {extra.sweepProgress.total}, alpha {extra.sweepProgress.current} deg.
                                </p>
                            )}
                        </div>
                    );
                })}
            </div>
            <div className="promptBar">
                <div className="promptRow">
                    <label className="visuallyHidden" htmlFor="examplePrompts">Example prompts</label>
                    <select
                        id="examplePrompts"
                        className="promptSelect"
                        value=""
                        disabled={busy}
                        onChange={(e) => {
                            const found = EXAMPLE_PROMPTS.find((item) => item.id === e.target.value);
                            if (found !== undefined) void onSubmit(found.prompt);
                        }}
                        aria-label="Example prompts"
                    >
                        <option value="" disabled>Example prompts</option>
                        {EXAMPLE_PROMPTS.map((item) => (
                            <option key={item.id} value={item.id}>{item.label}</option>
                        ))}
                    </select>
                    <label className="visuallyHidden" htmlFor="tutorialPrompts">Tutorials</label>
                    <select
                        id="tutorialPrompts"
                        className="promptSelect"
                        value=""
                        disabled={busy}
                        onChange={(e) => {
                            const found = CURRICULUM_CHIPS.find((chip) => chip.id === e.target.value);
                            if (found !== undefined) void onSubmit(found.prompt);
                        }}
                        aria-label="Tutorials"
                    >
                        <option value="" disabled>Tutorials</option>
                        {CURRICULUM_CHIPS.map((chip) => (
                            <option key={chip.id} value={chip.id}>{chip.label}</option>
                        ))}
                    </select>
                </div>
                <form
                    className="composer"
                    onSubmit={(e) => {
                        e.preventDefault();
                        void onSubmit(input);
                    }}
                >
                    <label className="visuallyHidden" htmlFor="agentInput">Ask the agent</label>
                    <div className="composerBox">
                        <input
                            id="agentInput"
                            ref={inputRef}
                            className="chatInput"
                            type="text"
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            onSelect={measureCaret}
                            onKeyUp={measureCaret}
                            onClick={measureCaret}
                            onKeyDown={onComposerKeyDown}
                            placeholder="Explain this run, or set up NACA 2412"
                            maxLength={500}
                            aria-label="Ask the agent"
                            style={{ caretColor: caretMeasured ? "transparent" : "auto" }}
                        />
                        <span ref={mirrorRef} className="tuiMirror" aria-hidden="true" />
                        {caretMeasured ? (
                            <span
                                className="tuiCaret"
                                aria-hidden="true"
                                style={{ transform: `translate(${caretX}px, -50%)` }}
                            />
                        ) : null}
                    </div>
                    {busy ? (
                        <button type="button" className="mBtn chatSend" onClick={onStop} aria-label="Stop the streaming reply">
                            {stopping ? "Stopping" : "Stop"}
                        </button>
                    ) : (
                        <button type="submit" className="mBtn chatSend" disabled={input.trim().length === 0} aria-label="Send chat message">
                            Send
                        </button>
                    )}
                </form>
            </div>
            {sweeping && sweepProgress !== null && (
                <div className="sweepProgress" role="status" aria-label="Alpha sweep progress">
                    <p className="mSub mono">
                        Sweep {sweepProgress.done} of {sweepProgress.total}, alpha {sweepProgress.current} deg, canvas stepping live.
                    </p>
                    <button type="button" className="mBtn chatSend" onClick={onStopSweep} aria-label="Stop the alpha sweep">
                        Stop
                    </button>
                </div>
            )}
        </div>
    );
}
