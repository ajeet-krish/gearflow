// Agent console: conversational front end over the existing Meta tools.
// Free text routes through routeIntent to Spark spec, engineer explain, SAM
// sketch, poster render, or plain chat. Turns persist locally (cap 50).
// Nothing writes to the canvas except explicit Apply buttons.

import { useRef, useState } from "react";
import type {
    ChatAction,
    ChatTurn,
    GeometrySpec,
    OfflineCase,
    ParametricSpec,
} from "@/contracts/types";
import type { HashCache } from "@/meta/cache";
import type { MetaClient } from "@/meta/client";
import { promptToSpec } from "@/meta/sparkSpec";
import { explainRun } from "@/meta/sparkEngineer";
import { sketchToSpec } from "@/meta/samSegment";
import { generatePoster, createPosterSession, type PosterSession } from "@/meta/poster";
import { appendTurns, clearTurns, loadChatState, saveChatActions, saveTurns } from "@/agent/chatStore";
import { routeIntent, OFFLINE_TEMPLATES } from "@/agent/intents";
import { chatReply } from "@/meta/sparkChat";

export interface AgentConsoleProps {
    spec: GeometrySpec;
    reynolds: number;
    cl: number;
    cpMin: number;
    offline: boolean;
    onOfflineChange: (next: boolean) => void;
    onApplySpec: (next: ParametricSpec) => void;
    client: MetaClient;
    cache: HashCache;
    posterUrl: string | null;
    onPosterUrl: (url: string | null) => void;
    offlineCases?: OfflineCase[] | null;
}

let turnCounter = 0;

function nextId(): string {
    turnCounter += 1;
    return `chat-${Date.now().toString(36)}-${turnCounter.toString(36)}`;
}

function nowIso(): string {
    return new Date().toISOString();
}

function describeError(e: unknown): string {
    const raw = e instanceof Error ? e.message : String(e);
    return raw.length > 220 ? `${raw.slice(0, 217)}...` : raw;
}

function statusFor(client: MetaClient, cached: boolean): ChatTurn["status"] {
    if (client.offlineMode) return "offline";
    return cached ? "cached" : "live";
}

function shortSpec(spec: ParametricSpec): string {
    try {
        const g = (spec as Partial<ParametricSpec> | null)?.geometry as GeometrySpec | undefined;
        if (!g || typeof g.kind !== "string") return "invalid spec";
        const re = (spec as Partial<ParametricSpec>).reynolds;
        const reLabel = Number.isFinite(re) ? ` Re${re}` : "";
        const alpha = Number.isFinite(g.alphaDeg) ? ` a${g.alphaDeg}` : "";
        const name = g.kind === "naca4" && g.naca ? `NACA ${g.naca.code}` : g.kind;
        return `${name}${alpha}${reLabel}`;
    } catch {
        return "invalid spec";
    }
}

/** Map an engineer suggested field onto canvas controls. Null means no control. */
function mapSuggestedChange(
    current: GeometrySpec,
    currentRe: number,
    field: string,
    to: number
): { spec: GeometrySpec; reynolds: number } | null {
    const f = field.trim().toLowerCase();
    if (f === "alphadeg" || f === "alpha" || f === "aoa") {
        return { spec: { ...current, alphaDeg: Math.min(12, Math.max(-4, to)) }, reynolds: currentRe };
    }
    if (f === "reynolds" || f === "re" || f === "rey") {
        return { spec: current, reynolds: Math.min(1_000_000, Math.max(1000, Math.round(to))) };
    }
    const naca = current.naca;
    if (naca === undefined) return null;
    if (f === "camber" || f === "m") {
        return { spec: { ...current, naca: { ...naca, m: Math.min(0.09, Math.max(0, to)) } }, reynolds: currentRe };
    }
    if (f === "camberposition" || f === "camber position" || f === "p") {
        return { spec: { ...current, naca: { ...naca, p: Math.min(0.8, Math.max(0.2, to)) } }, reynolds: currentRe };
    }
    if (f === "thickness" || f === "t") {
        return { spec: { ...current, naca: { ...naca, t: Math.min(0.18, Math.max(0.06, to)) } }, reynolds: currentRe };
    }
    return null;
}

const PRESET_CHIPS = [
    "Explain this run",
    "Propose a high lift spec",
    "Thicken the section",
    "Render a poster",
];

export default function AgentConsole({
    spec,
    reynolds,
    cl,
    cpMin,
    offline,
    onOfflineChange,
    onApplySpec,
    client,
    cache,
    posterUrl,
    onPosterUrl,
    offlineCases = null,
}: AgentConsoleProps) {
    const [turns, setTurns] = useState<ChatTurn[]>(() => loadChatState().turns);
    const [actions, setActions] = useState<Record<string, ChatAction>>(() => loadChatState().actions);
    const [input, setInput] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [samArmed, setSamArmed] = useState(false);
    const fileRef = useRef<HTMLInputElement | null>(null);
    const posterSessionRef = useRef<PosterSession | null>(null);
    if (posterSessionRef.current === null) posterSessionRef.current = createPosterSession();

    function pushTurns(next: ChatTurn | ChatTurn[]): void {
        setTurns((prev) => appendTurns(prev, next));
    }

    function markApplied(id: string): void {
        setTurns((prev) => {
            const merged = prev.map((t) => (t.id === id ? { ...t, applied: true } : t));
            saveTurns(merged);
            return merged;
        });
    }

    function onApplyTurn(id: string): void {
        const action = actions[id];
        if (action === undefined) return;
        if (action.kind === "spec" && action.spec !== undefined) {
            onApplySpec(action.spec);
            markApplied(id);
            return;
        }
        if (action.kind === "explain" && action.engineer !== undefined) {
            const mapped = mapSuggestedChange(spec, reynolds, action.engineer.suggestedChange.field, action.engineer.suggestedChange.to);
            if (mapped === null) return;
            onApplySpec({ geometry: mapped.spec, reynolds: mapped.reynolds, rationale: action.engineer.suggestedChange.rationale });
            markApplied(id);
            return;
        }
        if (action.kind === "sam" && action.sam !== undefined) {
            onApplySpec({
                geometry: { kind: "custom", chord: 1, alphaDeg: 4, nPoints: action.sam.polygon.length, polygon: action.sam.polygon },
                reynolds,
                rationale: "SAM sketch polygon from agent console.",
            });
            markApplied(id);
        }
    }

    async function handleSpec(text: string, userId: string): Promise<void> {
        void userId;
        try {
            const result = await promptToSpec(client, cache, text);
            const id = nextId();
            pushTurns({
                id, role: "assistant", at: nowIso(),
                text: `Proposed ${shortSpec(result.spec)}: ${result.spec.rationale}`,
                tool: "spark-spec", status: statusFor(client, result.cached), specSnapshot: result.spec,
            });
            setActions((prev) => {
                const next = { ...prev, [id]: { kind: "spec", spec: result.spec } as ChatAction };
                saveChatActions(next);
                return next;
            });
        } catch (e) {
            pushTurns({
                id: nextId(), role: "assistant", at: nowIso(),
                text: `${OFFLINE_TEMPLATES.spec} (${describeError(e)})`,
                tool: "spark-spec", status: "fallback",
            });
        }
    }

    async function handleExplain(): Promise<void> {
        const metricsReady = Number.isFinite(cl) && Number.isFinite(cpMin);
        if (!metricsReady) {
            pushTurns({
                id: nextId(), role: "assistant", at: nowIso(),
                text: "Needs a solved run with finite Cl and CpMin before I can read it.",
                tool: "spark-engineer", status: "fallback",
            });
            return;
        }
        try {
            const current: ParametricSpec = { geometry: spec, reynolds, rationale: "Current canvas run." };
            const result = await explainRun(client, cache, current, { cl, cpMin, reynolds });
            const id = nextId();
            pushTurns({
                id, role: "assistant", at: nowIso(),
                text: `${result.headline} ${result.explanation} Suggests ${result.suggestedChange.field} ${result.suggestedChange.from} to ${result.suggestedChange.to}. Caveat: ${result.caveats}`,
                tool: "spark-engineer", status: statusFor(client, false),
            });
            setActions((prev) => {
                const next = { ...prev, [id]: { kind: "explain", engineer: result } as ChatAction };
                saveChatActions(next);
                return next;
            });
        } catch (e) {
            pushTurns({
                id: nextId(), role: "assistant", at: nowIso(),
                text: `${OFFLINE_TEMPLATES.explain} (${describeError(e)})`,
                tool: "spark-engineer", status: "fallback",
            });
        }
    }

    async function handleSamFile(file: File): Promise<void> {
        setBusy(true);
        setError(null);
        try {
            const result = await sketchToSpec(client, cache, file);
            const id = nextId();
            pushTurns({
                id, role: "assistant", at: nowIso(),
                text: `Segmented sketch: IoU ${result.sam.maskIou.toFixed(2)}, confidence ${result.sam.confidence.toFixed(2)}${result.sam.usedFallback ? ", bbox fallback (mask missing)" : ", mask polygon"}.`,
                tool: "sam", status: statusFor(client, false),
            });
            setActions((prev) => {
                const next = { ...prev, [id]: { kind: "sam", sam: result.sam } as ChatAction };
                saveChatActions(next);
                return next;
            });
            setSamArmed(false);
        } catch (e) {
            setError(describeError(e));
        } finally {
            setBusy(false);
        }
    }

    async function handlePoster(): Promise<void> {
        if (offline && offlineCases !== null && offlineCases.length > 0) {
            onPosterUrl(offlineCases[0].poster);
            const id = nextId();
            pushTurns({
                id, role: "assistant", at: nowIso(),
                text: "Offline poster: reused the baked offline render, no network.",
                tool: "poster", status: "offline",
            });
            setActions((prev) => {
                const next = { ...prev, [id]: { kind: "poster", posterUrl: offlineCases[0].poster } as ChatAction };
                saveChatActions(next);
                return next;
            });
            return;
        }
        try {
            const current: ParametricSpec = { geometry: spec, reynolds, rationale: "Current canvas run." };
            const { url, cached } = await generatePoster(client, cache, current, posterSessionRef.current!);
            onPosterUrl(url);
            const id = nextId();
            pushTurns({
                id, role: "assistant", at: nowIso(), text: "Poster rendered, illustrative only, not physics.",
                tool: "poster", status: statusFor(client, cached),
            });
            setActions((prev) => {
                const next = { ...prev, [id]: { kind: "poster", posterUrl: url } as ChatAction };
                saveChatActions(next);
                return next;
            });
        } catch (e) {
            pushTurns({
                id: nextId(), role: "assistant", at: nowIso(),
                text: `${OFFLINE_TEMPLATES.poster} (${describeError(e)})`,
                tool: "poster", status: "fallback",
            });
        }
    }

    async function handleChat(text: string): Promise<void> {
        const history = [...turns.slice(-8).map((t) => `${t.role}: ${t.text}`), `user: ${text}`];
        const current: ParametricSpec = { geometry: spec, reynolds, rationale: "Current canvas run." };
        const reply = await chatReply(client, cache, history, { spec: current, cl, cpMin });
        const id = nextId();
        pushTurns({
            id, role: "assistant", at: nowIso(), text: reply.reply,
            tool: "chat", status: client.offlineMode ? "offline" : reply.cached ? "cached" : "live",
            specSnapshot: reply.proposedSpec,
        });
        if (reply.proposedSpec !== undefined) {
            const proposed = reply.proposedSpec;
            setActions((prev) => {
                const next = { ...prev, [id]: { kind: "spec", spec: proposed } as ChatAction };
                saveChatActions(next);
                return next;
            });
        }
    }

    async function onSubmit(raw: string): Promise<void> {
        const text = raw.trim();
        if (text.length === 0 || busy) return;
        setBusy(true);
        setError(null);
        const userTurn: ChatTurn = { id: nextId(), role: "user", text, at: nowIso() };
        pushTurns(userTurn);
        setInput("");
        try {
            const intent = routeIntent(text);
            if (intent.kind === "spec") await handleSpec(text, userTurn.id);
            else if (intent.kind === "explain") await handleExplain();
            else if (intent.kind === "sam") {
                setSamArmed(true);
                pushTurns({
                    id: nextId(), role: "assistant", at: nowIso(),
                    text: "Attach a planform sketch below (PNG or JPEG, max 5 MiB) and I will segment it.",
                    tool: "sam", status: client.offlineMode ? "offline" : "live",
                });
            } else if (intent.kind === "poster") await handlePoster();
            else await handleChat(text);
        } catch (e) {
            pushTurns({
                id: nextId(), role: "assistant", at: nowIso(),
                text: `${OFFLINE_TEMPLATES.chat} (${describeError(e)})`,
                tool: "chat", status: "fallback",
            });
        } finally {
            setBusy(false);
        }
    }

    function onClear(): void {
        clearTurns();
        setTurns([]);
        setActions({});
    }

    return (
        <div className="agentConsole">
            <div className="chatBar">
                <div className="mToggleRow">
                    <input
                        id="agentOffline"
                        type="checkbox"
                        checked={offline}
                        onChange={(e) => onOfflineChange(e.target.checked)}
                        aria-label="Go offline, disable Meta network calls"
                    />
                    <label htmlFor="agentOffline">
                        Go offline
                        <span className="mSub">Local only, served from cache or templates.</span>
                    </label>
                    <span className={`mDot ${offline ? "off" : "on"}`} aria-hidden="true" />
                </div>
                <button type="button" className="mBtn chatClear" onClick={onClear} aria-label="Clear chat transcript">
                    Clear chat
                </button>
            </div>
            <div className="chatLog" role="log" aria-label="Agent chat transcript" aria-live="polite">
                {turns.length === 0 && (
                    <p className="mSub">Ask to explain the run, propose a spec, segment a sketch, or render a poster.</p>
                )}
                {turns.map((t) => {
                    const action = actions[t.id];
                    const canApply =
                        action !== undefined &&
                        ((action.kind === "spec" && action.spec !== undefined) ||
                            (action.kind === "explain" && action.engineer !== undefined &&
                                mapSuggestedChange(spec, reynolds, action.engineer.suggestedChange.field, action.engineer.suggestedChange.to) !== null) ||
                            (action.kind === "sam" && action.sam !== undefined));
                    return (
                        <div key={t.id} className={`chatTurn ${t.role}`}>
                            <div className="chatHead">
                                <span className="mono">{t.role === "user" ? "You" : "Agent"}</span>
                                {t.tool !== undefined && <span className="badge status-info">{t.tool}</span>}
                                {t.status !== undefined && <span className={`badge status-${t.status === "live" ? "pass" : t.status === "cached" ? "info" : "warn"}`}>{t.status}</span>}
                                {t.applied === true && <span className="badge status-pass">applied</span>}
                            </div>
                            <p className="chatText">{t.text}</p>
                            {t.specSnapshot !== undefined && action === undefined && (
                                <p className="mono mSub">{shortSpec(t.specSnapshot)}</p>
                            )}
                            {canApply && (
                                <button type="button" className="mBtn mApply" onClick={() => onApplyTurn(t.id)}>
                                    Apply to canvas
                                </button>
                            )}
                        </div>
                    );
                })}
            </div>
            {samArmed && (
                <div className="chatSam">
                    <label className="mLabel" htmlFor="agentSamFile">Sketch upload (PNG or JPEG, max 5 MiB)</label>
                    <input
                        id="agentSamFile"
                        ref={fileRef}
                        type="file"
                        accept="image/png,image/jpeg"
                        className="mFile"
                        aria-label="Upload a planform sketch for SAM segmentation"
                    />
                    <button
                        type="button"
                        className="mBtn"
                        disabled={busy}
                        onClick={() => {
                            const file = fileRef.current?.files?.[0];
                            if (file) void handleSamFile(file);
                        }}
                    >
                        {busy ? "Segmenting" : "Segment sketch"}
                    </button>
                </div>
            )}
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
                    placeholder="Explain this run, or propose a thicker section"
                    maxLength={500}
                    aria-label="Ask the agent"
                />
                <button type="submit" className="mBtn chatSend" disabled={busy || input.trim().length === 0}>
                    {busy ? "Working" : "Send"}
                </button>
            </form>
            {error !== null && <p className="mError" role="alert">{error}</p>}
            {posterUrl !== null && (
                <p className="mSub mono">Poster session render active, illustrative only.</p>
            )}
        </div>
    );
}
