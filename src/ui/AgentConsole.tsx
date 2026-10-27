// Agent console: Baseten Spark chat transcript over the live run context.
// Composer streams through BasetenClient with Stop plus a 15 s budget,
// falls back to plain chat on a streaming parse failure, and answers
// locally with an offline badge when the toggle, the env flag, the spend
// cap, or a network fault forces local mode. Setup actions auto apply
// through onAgentAction, run and cancel render as confirm chips only,
// rejections render as reason text. Transcript persists capped at 50.
// React plus plain CSS classes from the Zenith shell, no new styling deps.

import { useMemo, useRef, useState } from "react";
import type { AgentAction, ChatTurn } from "@/contracts/types";
import type { AgentContext } from "@/agent/agentContext";
import { BasetenClient, type BasetenChatResult, type BasetenMessage, type BasetenStreamChunk } from "@/agent/basetenClient";
import { BASETEN_MODEL_ID } from "@/agent/basetenGate";
import { parseAgentEnvelope, type AgentValidationContext } from "@/agent/agentActions";
import { cachedChat } from "@/agent/agentCache";
import { localReply } from "@/agent/localAssistant";
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

export const PRESET_CHIPS: ReadonlyArray<string> = [
    "Explain this run",
    "Set up NACA 2412 alpha 6",
    "How do I change Re",
];

const SETUP_KINDS: ReadonlySet<string> = new Set([
    "set_body",
    "set_alpha",
    "set_reynolds",
    "set_engine",
    "set_field",
    "set_spec",
]);

const RUN_KINDS: ReadonlySet<string> = new Set(["run_lbm", "cancel_lbm"]);

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

/** Validation context derived from the agent snapshot, engine flag first. */
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
    };
}

/** Prompt messages: system instruction plus bounded context plus recent history. */
export function buildBasetenMessages(
    input: string,
    ctx: AgentContext | null | undefined,
    history: ChatTurn[]
): BasetenMessage[] {
    const contextJson = ctx === null || ctx === undefined ? "{}" : JSON.stringify(ctx).slice(0, 3500);
    const system: BasetenMessage = {
        role: "system",
        content: [
            "You are the GearFlow tunnel assistant. Answer briefly about the run.",
            "To change the canvas, append one fenced block per action:",
            "```action-json",
            '{"kind":"set_alpha","alphaDeg":6}',
            "```",
            "Valid kinds: set_body, set_alpha, set_reynolds, set_engine, set_field, run_lbm, cancel_lbm, set_spec.",
            "Bounds: alpha in [-4, 12], reynolds in [1000, 1000000].",
            "set_field k needs TKE ready, recirc needs the mask ready. run_lbm needs LBM live.",
            `Live context: ${contextJson}`,
        ].join("\n"),
    };
    const tail = history.slice(-8).map((t): BasetenMessage => ({
        role: t.role === "user" ? "user" : "assistant",
        content: t.text.slice(0, 2000),
    }));
    return [system, ...tail, { role: "user", content: input.slice(0, 2000) }];
}

/** Minimal context for the metrics only offline path, so the shared local
 *  assistant cites the same numbers the embedded reply used to cite. */
function metricsContext(metrics: { cl: number; cpMin: number; reynolds: number }): AgentContext {
    const safe = (metrics ?? {}) as { cl?: unknown; cpMin?: unknown; reynolds?: unknown };
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const re = num(safe.reynolds);
    return {
        spec: { kind: "unknown", alphaDeg: null, reynolds: re === null ? null : Math.round(re) },
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
    }

    function settleEnvelope(id: string, rawText: string): void {
        settleParsedEnvelope(id, parseAgentEnvelope(rawText, validationCtx));
    }

    function pushOfflineAssistant(userText: string): void {
        const id = nextId();
        const envelope = localReply(userText, agentContext ?? null);
        pushTurn({ id, role: "assistant", at: nowIso(), text: envelope.reply, tool: "baseten", status: "offline" });
        setExtra(id, makeExtra({ streaming: false }));
        settleParsedEnvelope(id, { reply: "", actions: envelope.actions, rejections: envelope.rejections });
    }

    async function runStream(id: string, messages: BasetenMessage[], controller: AbortController): Promise<void> {
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
        settleEnvelope(id, fullText);
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
        const controller = new AbortController();
        abortRef.current = controller;
        const id = nextId();
        pushTurn({ id, role: "assistant", at: nowIso(), text: "", tool: "baseten", status: "live" });
        setExtra(id, makeExtra({ streaming: true }));
        try {
            const messages = buildBasetenMessages(text, agentContext ?? null, [...turns, userTurn]);
            await runStream(id, messages, controller);
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
            <div className="chatLog" role="log" aria-label="Agent chat transcript" aria-live="polite">
                {turns.length === 0 && (
                    <p className="mSub">Ask to explain the run, set up NACA 2412, or change Re.</p>
                )}
                {turns.map((t) => {
                    const extra = extras[t.id];
                    const isAssistant = t.role === "assistant";
                    const toolText = typeof t.tool === "string" && t.tool.length > 0 ? t.tool : "legacy";
                    const statusText = typeof t.status === "string" && t.status.length > 0 ? t.status : "fallback";
                    return (
                        <div key={t.id} className={`chatTurn ${t.role}`}>
                            <div className="chatHead">
                                <span className="mono">{t.role === "user" ? "You" : "Agent"}</span>
                                {isAssistant && <span className="badge status-info">{toolText}</span>}
                                {isAssistant && (
                                    <span className={`badge status-${statusText === "live" ? "pass" : statusText === "cached" ? "info" : "warn"}`}>{statusText}</span>
                                )}
                                {isAssistant && <span className="badge status-info mono">{extra?.model ?? BASETEN_MODEL_ID}</span>}
                                {extra?.streaming === true && <span className="badge status-info">streaming</span>}
                                {extra?.stopped === true && <span className="badge status-warn">stopped</span>}
                                {(extra?.applied.length ?? 0) > 0 && <span className="badge status-pass">applied</span>}
                            </div>
                            <p className="chatText">{t.text.length > 0 ? t.text : "Composing reply"}</p>
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
