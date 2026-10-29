// Agent console: Baseten Spark chat transcript over the live run context.
// Composer streams through BasetenClient with Stop plus a 15 s budget,
// falls back to plain chat on a streaming parse failure, and answers
// locally with an offline badge when the toggle, the env flag, the spend
// cap, or a network fault forces local mode. Setup actions auto apply
// through onAgentAction, run and cancel render as confirm chips only,
// rejections render as reason text. Transcript persists capped at 50.
// React plus plain CSS classes from the Zenith shell, react-markdown plus
// remark-gfm for agent and tutor prose (user turns stay plain text).
// Tutor turns carry a badge plus a real before vs after table.

import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentAction, ChatTurn, FieldMode } from "@/contracts/types";
import type { AgentContext } from "@/agent/agentContext";
import { BasetenClient, type BasetenChatResult, type BasetenMessage, type BasetenStreamChunk } from "@/agent/basetenClient";
import { BASETEN_MODEL_ID } from "@/agent/basetenGate";
import { actionContractSummary, parseAgentEnvelope, validateAgentAction, type AgentValidationContext } from "@/agent/agentActions";
import { buildTutorTable, tutorRowsText, type TutorSnapshotLite, type TutorTableRow } from "@/agent/tutorTable";
import { detectConcept, fieldForConcept, localTutorReply, type TutorConcept, type TutorFieldSuggestion } from "@/agent/tutorPolicy";
import { buildTutorMessages } from "@/agent/tutorPrompt";
import { buildAirfoilEnvelope, parseAirfoilIntent, type AirfoilApply } from "@/agent/airfoilIntent";
import { expandCasePreset } from "@/agent/casePresets";
import { cachedChat } from "@/agent/agentCache";
import { localReply } from "@/agent/localAssistant";
import { PROVISIONAL_NEURAL_ENVELOPE } from "@/flow/neuralDomain";
import { SESSION_SPEND_CAP_USD, addSpend, isSoftStopped } from "@/agent/sessionSpend";
import { appendTurns, loadTurns, saveTurns } from "@/agent/chatStore";
import { g_evalLog } from "@/meta/evalLog";

/** Minimal chat port so tests inject a fake with zero live calls. */
export interface BasetenChatPort {
    streamChat(
        messages: BasetenMessage[],
        opts?: { feature?: string; signal?: AbortSignal; timeoutMs?: number }
    ): AsyncGenerator<BasetenStreamChunk, BasetenChatResult, void>;
    chat(
        messages: BasetenMessage[],
        opts?: { feature?: string; signal?: AbortSignal; timeoutMs?: number }
    ): Promise<BasetenChatResult>;
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
    chatClient?: BasetenChatPort | null;
    evalSink?: ((payload: { feature: string; model: string }) => void) | null;
    spendCapUsd?: number;
    initialTurns?: ChatTurn[];
    initialBusy?: boolean;
    initialExtras?: Record<string, TurnExtra>;
}

export const BASETEN_FEATURE = "baseten-chat";
export const BASETEN_TIMEOUT_MS = 15000;
export const STREAM_FLUSH_MS = 50;
export const SPEND_SOFT_STOP_USD = SESSION_SPEND_CAP_USD;
export const TRANSCRIPT_CAP = 50;
/** Phase T2 tutor hook constants. The tutor fires once the settled case key
 *  moves past the applied key, or after the timeout with a loading line. */
export const TUTOR_FEATURE = "tutor";
export const TUTOR_TIMEOUT_MS = 2500;
export const TUTOR_LOADING_LINE = "Prediction still loading, showing the pending table.";
export const TUTOR_LOCAL_MODEL = "tutor-local";
/** Parser fast path floor: a high confidence apply (>= 0.9) skips Spark
 *  with zero credits and zero port calls. Clarify, invalid, question, and
 *  low confidence results fall through to the Baseten or local path. */
export const PARSER_APPLY_CONFIDENCE = 0.9;
/** Model attribution for zero credit parser turns. Spend stays untouched,
 *  the badge names the local path honestly. */
export const PARSER_LOCAL_MODEL = "parser-local";

export const PRESET_CHIPS: ReadonlyArray<string> = [
    "Explain this run",
    "Set up NACA 2412 alpha 6",
    "How do I change Re",
];

/** Auto apply kinds plus confirm chip kinds, derived from the validator
 *  contract so the console, the prompt, and the validator cannot drift.
 *  Retired setup_high_pressure is in neither set: the validator rejects
 *  it with the honest divergence reason before it could apply. */
export const SETUP_KINDS: ReadonlySet<string> = new Set(actionContractSummary().setupKinds);

export const RUN_KINDS: ReadonlySet<string> = new Set(actionContractSummary().runKinds);

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
        const alpha = num(c.alphaDeg ?? spec.alphaDeg);
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
        };
    }
}

/** Pending tutor capture: the turn that applied plus the before snapshot.
 *  The effect fires once the settled context moves past caseKeyBefore. */
export interface PendingTutor {
    turnId: string;
    before: TutorSnapshotLite;
    caseKeyBefore: string;
    actionsSummary: string;
    startedAt: number;
    beforeVariable: string;
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
 *  neural envelope carried when the snapshot names it. */
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
    };
}

/** Prompt lines for the setup presets, derived from the validator
 *  contract plus live expandCasePreset output so expansions and Re values
 *  in the prompt can never drift from what the App executor applies.
 *  Retired setup_high_pressure is labeled retired with its honest reason
 *  plus the redirect, never a live example. */
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
        let field = "";
        for (const a of expanded.actions) {
            if (a.kind === "set_body") body = a.body;
            else if (a.kind === "set_alpha") alpha = a.alphaDeg;
            else if (a.kind === "set_reynolds") re = a.reynolds;
            else if (a.kind === "set_field") field = a.field;
        }
        if (preset.id === "airfoil") {
            parts.push(
                `airfoil (${preset.actionKind}) is ${body} at alpha ${alpha} Re ${re} ${field} field, honoring a named NACA body (0012, 2412, 4412) plus alpha`
            );
        } else {
            parts.push(`${preset.id} (${preset.actionKind}) is ${body} alpha ${alpha} Re ${re} ${field} field`);
        }
    }
    const retiredPreset = contract.presets.find((p) => p.retired);
    const retired = retiredPreset !== undefined && retiredPreset.note !== null
        ? `${retiredPreset.actionKind} is retired: ${retiredPreset.note}`
        : "setup_high_pressure is retired (orifice diverges in the LBM solver), use setup_high_re_wake instead";
    return { live: parts.join(", "), retired };
}

/** Prompt messages: system instruction plus bounded context plus recent history.
 *  Setup presets auto apply through the App executor, run and cancel render
 *  as confirm chips only, at most five validated actions per envelope. */
export function buildBasetenMessages(
    input: string,
    ctx: AgentContext | null | undefined,
    history: ChatTurn[]
): BasetenMessage[] {
    const contract = actionContractSummary();
    const presetLines = presetPromptLines();
    const contextJson = ctx === null || ctx === undefined ? "{}" : JSON.stringify(ctx).slice(0, 3500);
    const system: BasetenMessage = {
        role: "system",
        content: [
            "You are the GearFlow tunnel assistant. Answer briefly about the run.",
            "To change the canvas, append one fenced block per action, at most five:",
            "```action-json",
            '{"kind":"set_alpha","alphaDeg":6}',
            "```",
            `Valid kinds: ${contract.kinds.join(", ")}.`,
            `Setup presets expand atomically: ${presetLines.live}.`,
            presetLines.retired,
            "For NACA codes outside 0012, 2412, and 4412, set_body cannot carry them: send one set_spec with the full parametric geometry plus reynolds plus rationale instead.",
            "Tutor voice: when a NACA section is valid but unrealistically thick or cambered (outside 6 to 18% thickness or 0 to 9% camber), add one physics explainer sentence naming the draggy unvalidated coefficients and pointing at 12 to 15% thickness with 2 to 4% camber, then keep the applied case.",
            "Bounds: alpha in [-180, 180] hard ([-4, 12] characterized), reynolds in [1000, 1000000].",
            "set_engine accepts analytic or lbm only. set_field k needs TKE ready, recirc needs the mask ready. run_lbm needs LBM live and renders as a confirm chip, never auto runs.",
            "Never invent bodies, Re, or alpha: quote the envelope bounds and name the nearest in-domain case on rejection. Out of domain cases stay on the analytic path.",
            `Live context: ${contextJson}`,
        ].join("\n"),
    };
    const tail = history.slice(-8).map((t): BasetenMessage => ({
        role: t.role === "user" ? "user" : "assistant",
        content: t.text.slice(0, 2000),
    }));
    return [system, ...tail, { role: "user", content: input.slice(0, 2000) }];
}

/** Offline envelope label derived from the provisional envelope so copy
 *  cannot drift from the domain the app actually exposes. */
function neuralEnvelopeLabel(): string {
    const env = PROVISIONAL_NEURAL_ENVELOPE;
    return `provisional neural envelope [${env.kinds.join(", ")}], alpha [${env.alphaMin}, ${env.alphaMax}], Re [${env.reMin}, ${env.reMax}], no weights yet`;
}

/** Minimal context for the metrics only offline path, so the shared local
 *  assistant cites the same numbers the embedded reply used to cite. */
function metricsContext(metrics: { cl: number; cpMin: number; reynolds: number }): AgentContext {
    const safe = (metrics ?? {}) as { cl?: unknown; cpMin?: unknown; reynolds?: unknown };
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const re = num(safe.reynolds);
    return {
        spec: { kind: "unknown", alphaDeg: null, reynolds: re === null ? null : Math.round(re), naca: null },
        reynolds: re === null ? null : Math.round(re),
        regime: "unknown regime",
        bodyLabel: "current body",
        alphaDeg: null,
        backend: "unknown backend",
        engine: "analytic",
        gridLabel: "unknown grid",
        cl: num(safe.cl),
        cpMin: num(safe.cpMin),
        lbm: { status: "idle", hasSnapshot: false, effective: false, statsReady: false, stats: null },
        field: { variable: "speed", effective: "speed", hasTke: false, hasRecirc: false },
        validation: { pass: 0, warn: 0, fail: 0, info: 0 },
        provenanceLabel: "unknown provenance",
        offline: true,
        honesty: [],
        neural: {
            available: false,
            envelope: neuralEnvelopeLabel(),
            path: "analytic",
        },
    };
}

/** Deterministic local reply. Zero network, zero canvas writes. Delegates to
 *  the shared local assistant so offline copy matches the console path. */
export function localOfflineReply(input: string, metrics: { cl: number; cpMin: number; reynolds: number }): string {
    return localReply(input, metricsContext(metrics)).reply;
}

function describeAction(a: AgentAction): string {
    if (a.kind === "set_body") return `body ${a.body}`;
    if (a.kind === "set_alpha") return `alpha ${a.alphaDeg}`;
    if (a.kind === "set_reynolds") return `Re ${a.reynolds}`;
    if (a.kind === "set_engine") return `engine ${a.engine}`;
    if (a.kind === "set_field") return `field ${a.field}`;
    if (a.kind === "run_lbm") return "Run LBM";
    if (a.kind === "cancel_lbm") return "Cancel LBM";
    if (a.kind === "setup_shedding") return "vortex shedding case (cylinder, alpha 0, Re 100, speed field)";
    if (a.kind === "setup_high_re_wake") return "high Re wake case (cylinder, alpha 0, Re 700, speed field)";
    if (a.kind === "setup_high_pressure") return "retired high pressure case (use setup_high_re_wake instead)";
    if (a.kind === "setup_airfoil") return "airfoil case (NACA, speed field)";
    return "custom spec";
}

function makeExtra(over: Partial<TurnExtra> = {}): TurnExtra {
    return {
        model: BASETEN_MODEL_ID,
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
    chatClient = null,
    evalSink = undefined,
    spendCapUsd = SPEND_SOFT_STOP_USD,
    initialTurns = undefined,
    initialBusy = undefined,
    initialExtras = undefined,
}: AgentConsoleProps) {
    void onApplySpec;
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
    const [samNote, setSamNote] = useState(false);
    const [spend, setSpend] = useState<SpendTotals>({ model: BASETEN_MODEL_ID, inputTokens: 0, outputTokens: 0, costUsd: 0 });
    const busyRef = useRef<boolean>(initialBusy ?? false);
    const abortRef = useRef<AbortController | null>(null);
    // Phase T2 tutor hook state. pendingTutor captures the before snapshot
    // at apply time, the settle effect fires once the settled context moves
    // past the before key. firedKeys dedupes by after caseKey, suppressedKeys
    // records manual field changes that cancel the auto set_field.
    const [pendingTutor, setPendingTutor] = useState<PendingTutor | null>(null);
    const pendingRef = useRef<PendingTutor | null>(null);
    const firedKeysRef = useRef<Set<string>>(new Set());
    const suppressedKeysRef = useRef<Set<string>>(new Set());
    const lastVariableRef = useRef<string | null>(null);
    const ctxRef = useRef<AgentContext | null>(agentContext ?? null);
    ctxRef.current = agentContext ?? null;
    // Phase T2 frontend: transcript scroll anchor. Ref callbacks never run
    // in the effect-less test harness, so the ref stays null there and the
    // scroll effect below is a silent no-op.
    const logRef = useRef<HTMLDivElement | null>(null);

    const validationCtx = useMemo(() => validationContextFor(agentContext ?? null), [agentContext]);
    const softStopped = spendExceeded(spend.costUsd, spendCapUsd);
    const forcedLocal = offline || envOffline() || softStopped;

    const port: BasetenChatPort = useMemo(() => {
        if (chatClient !== null && chatClient !== undefined) return chatClient;
        const live = new BasetenClient({
            timeoutMs: BASETEN_TIMEOUT_MS,
            onEval: (p) => {
                try {
                    void g_evalLog.add({
                        feature: BASETEN_FEATURE,
                        model: p.model,
                        latencyMs: p.latencyMs,
                        costUsd: p.costUsd,
                        costEstimated: false,
                        cached: p.cachedTokens > 0,
                        ok: p.ok,
                        fallback: p.ok ? null : "baseten",
                        hash: BASETEN_FEATURE,
                    });
                } catch {
                    // Eval sink faults never break the chat path.
                }
                try {
                    if (evalSink !== undefined && evalSink !== null) evalSink({ feature: BASETEN_FEATURE, model: p.model });
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

    function settleParsedEnvelope(id: string, envelope: { reply: string; actions: AgentAction[]; rejections: string[] }): void {
        const applied: string[] = [];
        const pending: AgentAction[] = [];
        const appliedActions: AgentAction[] = [];
        const rejections = [...envelope.rejections];
        for (const action of envelope.actions) {
            if (RUN_KINDS.has(action.kind)) {
                pending.push(action);
                continue;
            }
            if (SETUP_KINDS.has(action.kind)) {
                try {
                    onAgentAction?.(action);
                    applied.push(`Applied: ${describeAction(action)}.`);
                    appliedActions.push(action);
                } catch {
                    // Executor faults render as a rejection line, never throw.
                    rejections.push(`apply failed for ${action.kind}, canvas unchanged`);
                }
                continue;
            }
            rejections.push(`unknown action kind ${(action as { kind: string }).kind}, ignored`);
        }
        const patch: Partial<TurnExtra> = {};
        if (applied.length > 0) patch.applied = applied;
        if (rejections.length > 0) patch.rejections = rejections;
        if (pending.length > 0) patch.pendingRuns = pending;
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
        // Phase T2 tutor capture: run-only envelopes stay on the confirm
        // chip with zero tutor, auto applied envelopes arm the pending hook.
        // Applied plus rejection lines stay on this action turn, the tutor
        // renders later as its own assistant turn.
        if (appliedActions.length > 0) {
            try {
                const before = snapshotLiteFor(agentContext ?? null);
                const next: PendingTutor = {
                    turnId: id,
                    before,
                    caseKeyBefore: before.caseKey,
                    actionsSummary: appliedActions.map((a) => a.kind).join(", "),
                    startedAt: Date.now(),
                    beforeVariable: (agentContext?.field?.variable ?? "speed") as string,
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

    function settleEnvelope(id: string, rawText: string, userText?: string): void {
        const parsed = parseAgentEnvelope(rawText, validationCtx);
        // Post-rescue: the model answered with no actionable envelope, but
        // the original request parses high confidence. Settle the parser
        // envelope on the same path instead of leaving the canvas stale.
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
                    const reply = parsed.reply.trim().length > 0 ? parsed.reply : rescued.reply;
                    settleParsedEnvelope(id, { reply, actions: rescued.actions, rejections: rescued.rejections });
                    return;
                }
                if (rescued.rejections.length > 0) {
                    const reply = parsed.reply.trim().length > 0 ? parsed.reply : rescued.reply;
                    settleParsedEnvelope(id, { reply, actions: [], rejections: rescued.rejections });
                    return;
                }
            }
        }
        settleParsedEnvelope(id, parsed);
    }

    /** Phase T2 tutor fire. Builds rows plus concept plus suggestion from the
     *  before/after snapshots, renders one assistant turn with the tutor
     *  payload, and rides at most one primary set_field through the same
     *  validated settle path. Secondary stays chip data. Never throws. */
    async function fireTutor(capture: PendingTutor, after: TutorSnapshotLite, timedOut: boolean): Promise<void> {
        const key = after.caseKey;
        if (firedKeysRef.current.has(key)) {
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
                strouhal: after.strouhal,
                cpMin: after.cpMin,
            });
        } catch {
            concept = "general";
        }
        let suggestion: TutorFieldSuggestion = { primary: "speed", secondary: "cp" };
        try {
            suggestion = fieldForConcept(concept, {
                current: (ctx?.field?.variable ?? "speed") as FieldMode,
                tkeReady: ctx?.field?.hasTke === true,
                recircReady: ctx?.field?.hasRecirc === true,
            });
        } catch {
            suggestion = { primary: "speed", secondary: "cp" };
        }
        // Manual field change suppresses the auto set_field for this key.
        // The tutor still renders with the table, only the canvas write is
        // skipped. An already current primary is also a no-op.
        let suppressed = suppressedKeysRef.current.has(key);
        try {
            const beforeVar = capture.beforeVariable;
            const afterVar = typeof ctx?.field?.variable === "string" ? ctx.field.variable : "speed";
            if (beforeVar !== afterVar) {
                suppressed = true;
                suppressedKeysRef.current.add(key);
            }
        } catch {
            // Suppression checks never break the tutor turn.
        }
        if (!suppressed) {
            try {
                const currentVar = typeof ctx?.field?.variable === "string" ? ctx.field.variable : "speed";
                if (suggestion.primary !== currentVar) {
                    const checked = validateAgentAction({ kind: "set_field", field: suggestion.primary }, validationCtx);
                    if (checked.ok && checked.action !== null) {
                        try {
                            onAgentAction?.(checked.action);
                        } catch {
                            // Tutor auto faults stay silent, the table still renders.
                        }
                    }
                }
            } catch {
                // Tutor auto apply never breaks the tutor turn.
            }
        }
        const tableText = tutorRowsText(rows);
        const timedNote = timedOut ? `\n\n${TUTOR_LOADING_LINE}` : "";
        const useLocal = forcedLocal || timedOut;
        let text: string;
        let model = TUTOR_LOCAL_MODEL;
        if (useLocal) {
            let local = "";
            try {
                local = localTutorReply(capture.before, after);
            } catch {
                local = "Local tutor note, local only. The run is pending, press Run for a clean solve.\n\nCaveat: pending, press Run for a clean solve.";
            }
            text = timedOut ? `${local}${timedNote}` : local;
        } else {
            try {
                const messages = buildTutorMessages({ after: ctx, rows, concept: concept as never, suggestion });
                const result = await port.chat(messages, { feature: TUTOR_FEATURE, timeoutMs: BASETEN_TIMEOUT_MS });
                model = result.model;
                recordSpend(result);
                text = `${result.text}\n\nBefore vs after\n${tableText}${timedNote}`;
            } catch {
                let local = "";
                try {
                    local = localTutorReply(capture.before, after);
                } catch {
                    local = "Local tutor note, local only. The run is pending, press Run for a clean solve.\n\nCaveat: pending, press Run for a clean solve.";
                }
                text = timedOut ? `${local}${timedNote}` : local;
                model = TUTOR_LOCAL_MODEL;
            }
        }
        const tutorId = nextId();
        pushTurn({
            id: tutorId,
            role: "assistant",
            at: nowIso(),
            text: text.slice(0, 2000),
            tool: "baseten",
            status: useLocal ? "offline" : "live",
            tutor: {
                concept,
                primary: suggestion.primary,
                secondary: suggestion.secondary,
                rows: rows.slice(0, 12).map((r) => ({
                    metric: String(r.metric).slice(0, 80),
                    before: String(r.before).slice(0, 80),
                    after: String(r.after).slice(0, 80),
                    delta: String(r.delta).slice(0, 80),
                })),
                caseKey: key.slice(0, 80),
            },
        });
        setExtra(tutorId, makeExtra({ streaming: false, model }));
        try {
            await g_evalLog.add({
                feature: TUTOR_FEATURE,
                model,
                latencyMs: 0,
                costUsd: 0,
                costEstimated: true,
                cached: false,
                ok: true,
                fallback: useLocal ? "tutor-local" : null,
                hash: TUTOR_FEATURE,
            });
        } catch {
            // Eval faults never break the tutor path.
        }
        try {
            if (evalSink !== undefined && evalSink !== null) evalSink({ feature: TUTOR_FEATURE, model });
        } catch {
            // Optional test sink faults never break the tutor path.
        }
    }

    // Phase T2 settle effect. Fires once the settled context moves past the
    // applied key, or after TUTOR_TIMEOUT_MS with the loading line. Dedupes
    // by after caseKey, never refires on rerender with the same key.
    useSafeEffect(() => {
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
        const envelope = localReply(userText, agentContext ?? null);
        pushTurn({ id, role: "assistant", at: nowIso(), text: envelope.reply, tool: "baseten", status: "offline" });
        setExtra(id, makeExtra({ streaming: false }));
        settleParsedEnvelope(id, { reply: "", actions: envelope.actions, rejections: envelope.rejections });
    }

    async function runStream(id: string, messages: BasetenMessage[], controller: AbortController, userText: string): Promise<void> {
        let fullText = "";
        let lastResult: BasetenChatResult | null = null;
        let lastFlush = Date.now();
        try {
            const gen = port.streamChat(messages, { feature: BASETEN_FEATURE, signal: controller.signal, timeoutMs: BASETEN_TIMEOUT_MS });
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
            const failed = e instanceof Error ? e : new Error(String(e));
            const needsFallback = failed.message.toLowerCase().includes("json") || failed.message.toLowerCase().includes("valid") || fullText.length === 0;
            if (needsFallback) {
                try {
                    const plain = await cachedChat(port, messages, { feature: BASETEN_FEATURE, signal: controller.signal, timeoutMs: BASETEN_TIMEOUT_MS });
                    lastResult = plain;
                    fullText = plain.text;
                } catch {
                    pushTurn({ id: nextId(), role: "assistant", at: nowIso(), text: "Baseten unreachable, local mode. Canvas unchanged.", tool: "baseten", status: "offline" });
                    setTurns((prev) => {
                        const merged = prev.filter((t) => t.id !== id);
                        saveTurns(merged.slice(-TRANSCRIPT_CAP));
                        return merged.slice(-TRANSCRIPT_CAP);
                    });
                    setExtras((prev) => {
                        const next = { ...prev };
                        delete next[id];
                        return next;
                    });
                    return;
                }
            } else {
                pushTurn({ id: nextId(), role: "assistant", at: nowIso(), text: "Baseten unreachable, local mode. Canvas unchanged.", tool: "baseten", status: "offline" });
                setTurns((prev) => {
                    const merged = prev.filter((t) => t.id !== id);
                    saveTurns(merged.slice(-TRANSCRIPT_CAP));
                    return merged.slice(-TRANSCRIPT_CAP);
                });
                setExtras((prev) => {
                    const next = { ...prev };
                    delete next[id];
                    return next;
                });
                return;
            }
        }
        if (fullText.trim().length === 0) {
            try {
                const plain = await port.chat(messages, { feature: BASETEN_FEATURE, signal: controller.signal, timeoutMs: BASETEN_TIMEOUT_MS });
                lastResult = plain;
                fullText = plain.text;
            } catch {
                fullText = "Empty reply, local mode. Canvas unchanged.";
            }
        }
        const cached = lastResult !== null && lastResult.usage.cachedTokens > 0;
        setTurns((prev) => {
            const merged = prev.map((t) =>
                t.id === id ? { ...t, text: fullText, tool: "baseten" as const, status: (cached ? "cached" : "live") as ChatTurn["status"] } : t
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
            });
        } else {
            setExtra(id, { streaming: false });
        }
        settleEnvelope(id, fullText, userText);
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
        if (forcedLocal) {
            pushOfflineAssistant(text);
            busyRef.current = false;
            setBusy(false);
            return;
        }
        // R3 parser fast path: a high confidence apply that validates cleanly
        // settles locally with zero credits and zero port calls. Clarify,
        // invalid, question, low confidence, and partially rejected envelopes
        // fall through to the model path below (an empty model reply there
        // surfaces the parser rejections with zero applies in settleEnvelope).
        let fastIntent: ReturnType<typeof parseAirfoilIntent> = null;
        try {
            fastIntent = parseAirfoilIntent(text, { code: currentSectionCode() });
        } catch {
            fastIntent = null;
        }
        if (fastIntent !== null && fastIntent.kind === "apply" && fastIntent.confidence >= PARSER_APPLY_CONFIDENCE) {
            const fast = settleParserApply(fastIntent);
            if (fast.actions.length > 0 && fast.rejections.length === 0) {
                const id = nextId();
                pushTurn({ id, role: "assistant", at: nowIso(), text: "", tool: "baseten", status: "live" });
                setExtra(id, makeExtra({ streaming: false, model: PARSER_LOCAL_MODEL, inputTokens: 0, outputTokens: 0, costUsd: 0 }));
                settleParsedEnvelope(id, { reply: fast.reply, actions: fast.actions, rejections: fast.rejections });
                busyRef.current = false;
                setBusy(false);
                return;
            }
        }
        const controller = new AbortController();
        abortRef.current = controller;
        const id = nextId();
        pushTurn({ id, role: "assistant", at: nowIso(), text: "", tool: "baseten", status: "live" });
        setExtra(id, makeExtra({ streaming: true }));
        try {
            const messages = buildBasetenMessages(text, agentContext ?? null, [...turns, userTurn]);
            await runStream(id, messages, controller, text);
        } finally {
            abortRef.current = null;
            busyRef.current = false;
            setBusy(false);
            setStopping(false);
        }
    }

    function onStop(): void {
        try {
            abortRef.current?.abort();
            setStopping(true);
        } catch {
            // Abort faults never break the Stop control.
        }
    }

    function onClear(): void {
        try {
            localStorage.removeItem("gearflow:chat:v1");
            localStorage.removeItem("gearflow:chat-actions:v1");
        } catch {
            // Private mode: memory state still clears below.
        }
        setTurns([]);
        setExtras({});
        pendingRef.current = null;
        setPendingTutor(null);
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

    /** Phase T2 secondary field chip. Rides the same validated settle path
     *  as the primary auto, gated k/recirc respected, faults stay local. */
    function onApplyTutorField(field: FieldMode): void {
        try {
            const checked = validateAgentAction({ kind: "set_field", field }, validationCtx);
            if (!checked.ok || checked.action === null) return;
            try {
                onAgentAction?.(checked.action);
            } catch {
                // Executor faults stay local to the chip control.
            }
        } catch {
            // Validation faults never break the chip control.
        }
    }

    return (
        <div className="agentConsole">
            <div className="chatBar">
                <div className="mToggleRow">
                    <input
                        id="agentOffline"
                        type="checkbox"
                        checked={offline}
                        onChange={(e) => onOfflineChange?.(e.target.checked)}
                        aria-label="Go offline, disable Baseten network calls"
                    />
                    <label htmlFor="agentOffline">
                        Go offline
                        <span className="mSub">Local only, zero network, canvas unchanged.</span>
                    </label>
                    <span className={`mDot ${offline ? "off" : "on"}`} aria-hidden="true" />
                </div>
                <button type="button" className="mBtn chatClear" onClick={onClear} aria-label="Clear chat transcript">
                    Clear chat
                </button>
            </div>
            <div className="chatLog" ref={logRef} role="log" aria-label="Agent chat transcript" aria-live="polite">
                {turns.length === 0 && (
                    <p className="mSub">Ask to explain the run, set up NACA 2412, or change Re.</p>
                )}
                {turns.map((t) => {
                    const extra = extras[t.id];
                    const isAssistant = t.role === "assistant";
                    const isTutor = isAssistant && t.tutor !== undefined && t.tutor !== null;
                    const toolText = typeof t.tool === "string" && t.tool.length > 0 ? t.tool : "legacy";
                    const statusText = typeof t.status === "string" && t.status.length > 0 ? t.status : "fallback";
                    return (
                        <div key={t.id} className={`chatTurn ${t.role} ${t.role === "user" ? "chatRight" : "chatLeft"}${isTutor ? " tutorTurn" : ""}`}>
                            <div className="chatHead">
                                <span className="mono">{t.role === "user" ? "You" : isTutor ? "Tutor" : "Agent"}</span>
                                {isTutor && <span className="badge tutorBadge">tutor</span>}
                                {isAssistant && <span className="badge status-info">{toolText}</span>}
                                {isAssistant && (
                                    <span className={`badge status-${statusText === "live" ? "pass" : statusText === "cached" ? "info" : "warn"}`}>{statusText}</span>
                                )}
                                {isAssistant && <span className="badge status-info mono">{extra?.model ?? BASETEN_MODEL_ID}</span>}
                                {extra?.streaming === true && <span className="badge status-info">streaming</span>}
                                {extra?.stopped === true && <span className="badge status-warn">stopped</span>}
                                {(extra?.applied.length ?? 0) > 0 && <span className="badge status-pass">applied</span>}
                            </div>
                            {t.role === "user" ? (
                                <p className="chatText">{t.text.length > 0 ? t.text : "Composing reply"}</p>
                            ) : t.text.length > 0 ? (
                                <div className="chatProse">
                                    <ChatMarkdown>{t.text}</ChatMarkdown>
                                </div>
                            ) : (
                                <p className="chatText">Composing reply</p>
                            )}
                            {(extra?.applied ?? []).map((note, i) => (
                                <p key={`applied-${i}`} className="mSub mono">{note}</p>
                            ))}
                            {(extra?.rejections ?? []).map((note, i) => (
                                <p key={`rejected-${i}`} className="mSub mono" role="note">Rejected: {note}</p>
                            ))}
                            {(extra?.pendingRuns ?? []).map((run, i) => (
                                <button
                                    key={`confirm-${i}`}
                                    type="button"
                                    className="mBtn mApply"
                                    onClick={() => onConfirmRun(t.id, run)}
                                    aria-label={`Confirm ${run.kind === "run_lbm" ? "Run LBM solve" : "Cancel LBM solve"}`}
                                >
                                    Confirm {run.kind === "run_lbm" ? "Run LBM" : "Cancel LBM"}
                                </button>
                            ))}
                            {t.tutor !== undefined && t.tutor !== null && (
                                <div className="tutorBlock" aria-label={`Tutor note on ${t.tutor.concept}`}>
                                    <p className="mSub mono tutorLine">Tutor: {t.tutor.concept}, suggested field {t.tutor.primary}</p>
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
                                    {t.tutor.secondary !== null && t.tutor.secondary !== t.tutor.primary && (
                                        <button
                                            key="tutor-secondary"
                                            type="button"
                                            className="chip tutorChip"
                                            onClick={() => onApplyTutorField(t.tutor?.secondary as FieldMode)}
                                            aria-label={`Show ${t.tutor.secondary} field`}
                                        >
                                            Show {t.tutor.secondary}
                                        </button>
                                    )}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
            <div className="chipRow" role="group" aria-label="Preset prompts">
                {PRESET_CHIPS.map((chip) => (
                    <button key={chip} type="button" className="chip" disabled={busy} onClick={() => void onSubmit(chip)}>
                        {chip}
                    </button>
                ))}
            </div>
            <form
                className="composer"
                onSubmit={(e) => {
                    e.preventDefault();
                    void onSubmit(input);
                }}
            >
                <label className="visuallyHidden" htmlFor="agentInput">Ask the agent</label>
                <input
                    id="agentInput"
                    className="chatInput"
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="Explain this run, or set up NACA 2412"
                    maxLength={500}
                    aria-label="Ask the agent"
                />
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
            <div className="chatFoot" role="status" aria-label="Session spend meter">
                <p className="mSub mono">
                    Session {spend.model} in {spend.inputTokens} out {spend.outputTokens} est ${spend.costUsd.toFixed(4)}.
                </p>
                {softStopped && (
                    <p className="mSub mono">Spend cap ${spendCapUsd.toFixed(2)} reached, local mode until reset.</p>
                )}
                {forcedLocal && !softStopped && (
                    <p className="mSub mono">Local mode, zero network, canvas unchanged.</p>
                )}
            </div>
            <div className="chatSam">
                <button
                    type="button"
                    className="chip"
                    onClick={() => setSamNote((v) => !v)}
                    aria-label="SAM sketch entry point, cached and offline"
                    aria-expanded={samNote}
                >
                    SAM sketch (cached, offline)
                </button>
                {samNote && (
                    <p className="mSub">Sketch segmentation stays cached and offline. SAM runs outside this chat and never routes through Baseten from here.</p>
                )}
            </div>
        </div>
    );
}
