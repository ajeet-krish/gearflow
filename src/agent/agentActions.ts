// Phase B2 agent actions. Pure envelope parsing plus per context
// validation. Never throws: malformed envelopes fall back to a reply with
// a rejection reason. Bounds match the canvas controls. Each envelope
// accepts at most five actions, extras are rejected with a note.

import type { AgentAction, BodyToken, FieldMode, ParametricSpec } from "@/contracts/types";
import { ALPHA_HARD_MAX, ALPHA_HARD_MIN, RE_MAX, RE_MIN, validateParametricSpec } from "@/contracts/schema";
import { expandCasePreset } from "./casePresets";
import { PROVISIONAL_NEURAL_ENVELOPE, classifyNeuralDomain, type NeuralEnvelope } from "@/flow/neuralDomain";

export const BODY_TOKENS: ReadonlyArray<string> = ["naca0012", "naca2412", "naca4412", "cylinder", "block", "orifice"];
export const ENGINE_TOKENS: ReadonlyArray<string> = ["analytic", "wasm", "lbm", "surrogate"];
export const FIELD_TOKENS: ReadonlyArray<string> = ["speed", "cp", "omega", "u", "v", "k", "recirc"];
export const REPLY_MAX = 2000;
/** Upper bound on actions accepted from one envelope, so a rambling model
 *  reply cannot queue unbounded canvas writes. */
export const MAX_ENVELOPE_ACTIONS = 5;

/** Minimal live state the validator needs. Kept small so App can build it
 *  from existing flags without new data plumbing. Neural fields are
 *  additive: absent means the analytic path serves the case. */
export interface AgentValidationContext {
    lbmEffective: boolean;
    statsReady: boolean;
    hasTke: boolean;
    hasRecirc: boolean;
    /** True while the neural surrogate can serve a frame. */
    neuralAvailable?: boolean;
    /** Override envelope for tests, defaults to the provisional envelope. */
    neuralEnvelope?: NeuralEnvelope | null;
}

export interface ValidatedAction {
    ok: boolean;
    reason: string | null;
    action: AgentAction | null;
}

export interface AgentEnvelope {
    reply: string;
    actions: AgentAction[];
    rejections: string[];
}

const ACTION_FENCE_RE = /```action-json\s*([\s\S]*?)```/g;

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

function capReply(v: unknown): string {
    if (typeof v !== "string") return "";
    const t = v.trim();
    return t.length > REPLY_MAX ? t.slice(0, REPLY_MAX) : t;
}

/** Normalize a parsed payload into candidate action objects. Accepts a
 *  single action, an array of actions, or an envelope with reply/actions. */
function payloadToCandidates(payload: unknown): unknown[] {
    if (Array.isArray(payload)) return payload;
    if (isRecord(payload)) {
        const inner = payload.actions;
        if (Array.isArray(inner)) return inner;
        if (typeof payload.kind === "string") return [payload];
        if (typeof payload.reply === "string" && !Array.isArray(inner)) return [];
    }
    return [payload];
}

function envelopeReply(payload: unknown): string | null {
    if (isRecord(payload) && typeof payload.reply === "string") return payload.reply;
    return null;
}

/** Nearest in-domain alternative for an honest rejection. Clamps alpha
 *  and Re into the envelope and names the first allowlisted body when the
 *  requested body is outside, quoting only real bounds, never invented. */
function nearestCaseNote(envelope: NeuralEnvelope, body: string, alphaDeg: number, reynolds: number): string {
    const first = envelope.kinds.length > 0 ? String(envelope.kinds[0]) : body;
    const nearBody = envelope.kinds.includes(body as (typeof envelope.kinds)[number]) ? body : first;
    const nearAlpha = Math.min(Math.max(alphaDeg, envelope.alphaMin), envelope.alphaMax);
    const nearRe = Math.round(Math.min(Math.max(reynolds, envelope.reMin), envelope.reMax));
    return `nearest in-domain case is ${nearBody} alpha ${nearAlpha} Re ${nearRe}`;
}

/** Envelope gate for trusted setup presets. The analytic path always
 *  serves the expanded case; the neural path rejects out of domain with
 *  the bound plus the nearest alternative, never a hallucinated case. */
function setupDomainRejection(
    presetKind: string,
    body: string,
    alphaDeg: number,
    reynolds: number,
    ctx: Partial<AgentValidationContext>,
): string | null {
    if (ctx.neuralAvailable !== true) return null;
    const envelope = ctx.neuralEnvelope ?? PROVISIONAL_NEURAL_ENVELOPE;
    const verdict = classifyNeuralDomain(body, alphaDeg, reynolds, envelope);
    if (verdict.inDomain) return null;
    const bound = verdict.reason ?? `outside [${envelope.kinds.join(", ")}], alpha [${envelope.alphaMin}, ${envelope.alphaMax}], Re [${envelope.reMin}, ${envelope.reMax}]`;
    return `${presetKind} expands to ${body} alpha ${alphaDeg} Re ${reynolds}, outside the provisional neural envelope (${bound}); ${nearestCaseNote(envelope, body, alphaDeg, reynolds)}. Analytic path serves this case instead.`;
}

/** Pull the expanded body, alpha, and Re for the domain gate. */
function expandedCasePoint(actions: AgentAction[]): { body: string; alphaDeg: number; reynolds: number } | null {
    let body: string | null = null;
    let alphaDeg: number | null = null;
    let reynolds: number | null = null;
    for (const a of actions) {
        if (a.kind === "set_body") body = a.body;
        else if (a.kind === "set_alpha") alphaDeg = a.alphaDeg;
        else if (a.kind === "set_reynolds") reynolds = a.reynolds;
    }
    if (body === null || alphaDeg === null || reynolds === null) return null;
    return { body, alphaDeg, reynolds };
}

/**
 * Validate one action against the live context. Envelopes accept the hard
 * alpha envelope [-180, 180] with the characterized band flagged downstream,
 * and reynolds in [1000, 1000000]. Trusted setup_* preset actions bypass
 * that Re floor on the preset path (shedding carries its own validated Re
 * 100). Gated k and recirc fields need
 * the channel plus the first stats sample. run_lbm needs the LBM engine
 * effective. Trusted setup presets expand through expandCasePreset and the
 * neural envelope gates them only while neuralAvailable is true, with an
 * honest bound plus nearest alternative on rejection. set_engine accepts
 * analytic or lbm only. Never throws.
 */
export function validateAgentAction(action: unknown, ctx: AgentValidationContext | null | undefined): ValidatedAction {
    try {
        const live = (ctx ?? {}) as Partial<AgentValidationContext>;
        if (!isRecord(action) || typeof action.kind !== "string") {
            return { ok: false, reason: "action needs a kind string", action: null };
        }
        const kind = action.kind;
        if (kind === "set_body") {
            if (typeof action.body !== "string" || !BODY_TOKENS.includes(action.body)) {
                return { ok: false, reason: `set_body needs body in [${BODY_TOKENS.join(", ")}]`, action: null };
            }
            return { ok: true, reason: null, action: { kind: "set_body", body: action.body as AgentAction extends { kind: "set_body"; body: infer B } ? B : never } };
        }
        if (kind === "set_alpha") {
            const v = action.alphaDeg;
            if (typeof v !== "number" || !Number.isFinite(v)) {
                return { ok: false, reason: "set_alpha needs a finite alphaDeg", action: null };
            }
            if (v < ALPHA_HARD_MIN || v > ALPHA_HARD_MAX) {
                return { ok: false, reason: `set_alpha alphaDeg ${v} outside [${ALPHA_HARD_MIN}, ${ALPHA_HARD_MAX}]`, action: null };
            }
            return { ok: true, reason: null, action: { kind: "set_alpha", alphaDeg: v } };
        }
        if (kind === "set_reynolds") {
            const v = action.reynolds;
            if (typeof v !== "number" || !Number.isFinite(v)) {
                return { ok: false, reason: "set_reynolds needs a finite reynolds", action: null };
            }
            if (Math.round(v) < RE_MIN || Math.round(v) > RE_MAX) {
                return { ok: false, reason: `set_reynolds ${v} outside [${RE_MIN}, ${RE_MAX}]`, action: null };
            }
            return { ok: true, reason: null, action: { kind: "set_reynolds", reynolds: Math.round(v) } };
        }
        if (kind === "set_engine") {
            if (action.engine === "analytic" || action.engine === "lbm") {
                return { ok: true, reason: null, action: { kind: "set_engine", engine: action.engine } };
            }
            return { ok: false, reason: `set_engine needs engine in [analytic, lbm] (envelope tokens: ${ENGINE_TOKENS.join(", ")})`, action: null };
        }
        if (kind === "set_field") {
            if (typeof action.field !== "string" || !FIELD_TOKENS.includes(action.field)) {
                return { ok: false, reason: `set_field needs field in [${FIELD_TOKENS.join(", ")}]`, action: null };
            }
            const field = action.field as FieldMode;
            if (field === "k" && !(live.hasTke === true && live.statsReady === true)) {
                return { ok: false, reason: "set_field k gated until the first LBM statistics sample", action: null };
            }
            if (field === "recirc" && !(live.hasRecirc === true && live.statsReady === true)) {
                return { ok: false, reason: "set_field recirc gated until the first LBM statistics sample", action: null };
            }
            return { ok: true, reason: null, action: { kind: "set_field", field } };
        }
        if (kind === "run_lbm") {
            if (live.lbmEffective !== true) {
                return { ok: false, reason: "run_lbm needs the LBM engine effective", action: null };
            }
            return { ok: true, reason: null, action: { kind: "run_lbm" } };
        }
        if (kind === "cancel_lbm") {
            return { ok: true, reason: null, action: { kind: "cancel_lbm" } };
        }
        if (kind === "set_spec") {
            if (!isRecord(action.spec)) {
                return { ok: false, reason: "set_spec needs a spec object", action: null };
            }
            try {
                validateParametricSpec(action.spec as unknown as ParametricSpec);
            } catch (e) {
                const why = e instanceof Error ? e.message : String(e);
                return { ok: false, reason: `set_spec invalid: ${why}`, action: null };
            }
            return { ok: true, reason: null, action: { kind: "set_spec", spec: action.spec as unknown as ParametricSpec } };
        }
        // Trusted preset entry points. The setup_* actions expand through
        // expandCasePreset and carry their own validated Re (shedding uses
        // Re 100), so they bypass the per-action envelope Re floor above.
        // The App executor must apply the expansion, not the bare primitive.
        // While neuralAvailable is true the expanded point is also gated by
        // classifyNeuralDomain with an honest bound plus nearest alternative.
        if (kind === "setup_shedding" || kind === "setup_high_pressure" || kind === "setup_airfoil") {
            const request = kind === "setup_shedding"
                ? { preset: "shedding" as const }
                : kind === "setup_high_pressure"
                    ? { preset: "high_pressure" as const, body: action.body as string | undefined }
                    : { preset: "airfoil" as const, body: action.body as string | undefined, alphaDeg: action.alphaDeg as number | undefined };
            const expanded = expandCasePreset(request);
            if (!expanded.ok) {
                return { ok: false, reason: expanded.reason ?? "preset setup rejected", action: null };
            }
            const point = expandedCasePoint(expanded.actions);
            if (point !== null) {
                const gated = setupDomainRejection(kind, point.body, point.alphaDeg, point.reynolds, live);
                if (gated !== null) return { ok: false, reason: gated, action: null };
            }
            if (kind === "setup_shedding") return { ok: true, reason: null, action: { kind: "setup_shedding" } };
            if (kind === "setup_high_pressure") {
                const out: AgentAction = action.body === undefined
                    ? { kind: "setup_high_pressure" }
                    : { kind: "setup_high_pressure", body: action.body as BodyToken };
                return { ok: true, reason: null, action: out };
            }
            const out: AgentAction = { kind: "setup_airfoil" };
            if (action.body !== undefined) (out as { body?: BodyToken }).body = action.body as BodyToken;
            if (action.alphaDeg !== undefined) (out as { alphaDeg?: number }).alphaDeg = action.alphaDeg as number;
            return { ok: true, reason: null, action: out };
        }
        return { ok: false, reason: `unknown action kind ${kind}`, action: null };
    } catch {
        return { ok: false, reason: "action validation failed", action: null };
    }
}

/**
 * Parse a model reply into display text plus validated actions. Reads
 * fenced action-json blocks first, else plain JSON, else plain chat text.
 * Malformed fences fall back to the reply with a rejection. Never throws.
 */
export function parseAgentEnvelope(raw: unknown, ctx: AgentValidationContext | null | undefined): AgentEnvelope {
    try {
        const live = (ctx ?? {}) as Partial<AgentValidationContext>;
        const safeCtx: AgentValidationContext = {
            lbmEffective: live.lbmEffective === true,
            statsReady: live.statsReady === true,
            hasTke: live.hasTke === true,
            hasRecirc: live.hasRecirc === true,
            neuralAvailable: live.neuralAvailable === true,
            neuralEnvelope: live.neuralEnvelope ?? null,
        };
        if (typeof raw !== "string") {
            return { reply: "", actions: [], rejections: ["envelope not text, ignored"] };
        }
        const fenced: unknown[] = [];
        let malformed = false;
        let fenceCount = 0;
        for (const match of raw.matchAll(ACTION_FENCE_RE)) {
            fenceCount += 1;
            const body = (match[1] ?? "").trim();
            if (body.length === 0) {
                malformed = true;
                continue;
            }
            try {
                const parsed: unknown = JSON.parse(body);
                for (const cand of payloadToCandidates(parsed)) fenced.push(cand);
            } catch {
                malformed = true;
            }
        }
        if (fenceCount > 0) {
            const stripped = raw.replace(ACTION_FENCE_RE, "").trim();
            const replyText = capReply(stripped.length > 0 ? stripped : raw.trim());
            if (fenced.length === 0) {
                return { reply: replyText, actions: [], rejections: ["action envelope malformed, ignored"] };
            }
            const actions: AgentAction[] = [];
            const rejections: string[] = [];
            if (malformed) rejections.push("one action fence malformed, skipped");
            const cappedFences = fenced.slice(0, MAX_ENVELOPE_ACTIONS);
            if (fenced.length > cappedFences.length) rejections.push(`extra actions beyond ${MAX_ENVELOPE_ACTIONS} ignored`);
            for (const cand of cappedFences) {
                const checked = validateAgentAction(cand, safeCtx);
                if (checked.ok && checked.action !== null) actions.push(checked.action);
                else rejections.push(checked.reason ?? "action rejected");
            }
            return { reply: replyText, actions, rejections };
        }
        const trimmed = raw.trim();
        if (trimmed.length === 0) return { reply: "", actions: [], rejections: [] };
        let parsed: unknown = null;
        try {
            parsed = JSON.parse(trimmed);
        } catch {
            return { reply: capReply(raw), actions: [], rejections: [] };
        }
        if (!isRecord(parsed) && !Array.isArray(parsed)) {
            return { reply: capReply(raw), actions: [], rejections: [] };
        }
        const reply = envelopeReply(parsed);
        const actions: AgentAction[] = [];
        const rejections: string[] = [];
        const cands = payloadToCandidates(parsed);
        const cappedCands = cands.slice(0, MAX_ENVELOPE_ACTIONS);
        if (cands.length > cappedCands.length) rejections.push(`extra actions beyond ${MAX_ENVELOPE_ACTIONS} ignored`);
        for (const cand of cappedCands) {
            const checked = validateAgentAction(cand, safeCtx);
            if (checked.ok && checked.action !== null) actions.push(checked.action);
            else rejections.push(checked.reason ?? "action rejected");
        }
        return { reply: reply === null ? capReply("") : capReply(reply), actions, rejections };
    } catch {
        return { reply: "", actions: [], rejections: ["envelope unreadable, ignored"] };
    }
}
