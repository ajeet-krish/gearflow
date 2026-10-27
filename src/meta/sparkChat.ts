// Conversational Spark call for the agent console. One structured call
// returns a plain words reply plus optional proposedSpec and suggestedChange.
// Temperature 0, schema validated, HashCache backed, offline template fallback.

import { validateGeometrySpec, validateParametricSpec } from "@/contracts/schema";
import type { ParametricSpec, SuggestedChange } from "@/contracts/types";
import { META_DEFAULT_SPARK_MODEL, type MetaClient } from "@/meta/client";
import { TTL_SPARK_MS, hashKey, type HashCache } from "@/meta/cache";
import { templateSpec } from "@/meta/sparkSpec";

export interface ChatContext {
    spec: ParametricSpec;
    cl?: number;
    cpMin?: number;
}

export interface ChatReply {
    reply: string;
    proposedSpec?: ParametricSpec;
    suggestedChange?: SuggestedChange;
    cached: boolean;
}

const CHAT_SYSTEM = [
    "You are the GearFlow agent, a concise wind tunnel assistant.",
    "Reply with JSON only: { reply, proposedSpec?, suggestedChange? }.",
    "reply is one or two short sentences in plain words, no em dashes.",
    "proposedSpec is optional and follows { geometry, reynolds, rationale }.",
    "geometry follows { kind, chord, alphaDeg, nPoints, naca?, radius?, center?, width?, height? }.",
    "Rules: kind is naca4, cylinder, block, or duct. chord is 1. alphaDeg in [-4, 12].",
    "nPoints in [32, 160]. For naca4: naca.m in [0, 0.09], naca.p in [0.2, 0.8], naca.t in [0.06, 0.18].",
    "reynolds in [1000, 1000000]. rationale is one short sentence.",
    "suggestedChange is optional and follows { field, from, to, rationale, predictedEffect }.",
    "Only propose a spec or change when the user asks for a design move.",
].join(" ");

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null;
}

function toChatReply(raw: unknown): Omit<ChatReply, "cached"> {
    if (!isRecord(raw) || typeof raw.reply !== "string" || raw.reply.length === 0) {
        throw new Error("ChatReply.reply must be a non-empty string");
    }
    const out: Omit<ChatReply, "cached"> = { reply: raw.reply.slice(0, 2000) };
    if (raw.proposedSpec !== undefined) {
        const spec = raw.proposedSpec as ParametricSpec;
        validateParametricSpec(spec);
        validateGeometrySpec(spec.geometry);
        out.proposedSpec = spec;
    }
    if (raw.suggestedChange !== undefined) {
        const change = raw.suggestedChange as Record<string, unknown>;
        if (typeof change.field !== "string" || change.field.length === 0) {
            throw new Error("ChatReply.suggestedChange.field must be a non-empty string");
        }
        for (const f of ["from", "to"] as const) {
            if (typeof change[f] !== "number" || !Number.isFinite(change[f])) {
                throw new Error(`ChatReply.suggestedChange.${f} must be finite`);
            }
        }
        for (const f of ["rationale", "predictedEffect"] as const) {
            if (typeof change[f] !== "string" || (change[f] as string).length === 0) {
                throw new Error(`ChatReply.suggestedChange.${f} must be a non-empty string`);
            }
        }
        out.suggestedChange = {
            field: change.field,
            from: change.from as number,
            to: change.to as number,
            rationale: change.rationale as string,
            predictedEffect: change.predictedEffect as string,
        };
    }
    return out;
}

function offlineReply(history: string[], ctx: ChatContext): ChatReply {
    const last = history.length > 0 ? history[history.length - 1] : "";
    const lower = last.toLowerCase();
    if (lower.includes("thicken") || lower.includes("camber") || lower.includes("alpha") || lower.includes("propose")) {
        const fallback = templateSpec();
        return {
            reply: `Offline: keeping it local with a template high lift spec, ${fallback.geometry.kind} at alpha ${fallback.geometry.alphaDeg}. Apply it to see the field move.`,
            proposedSpec: fallback,
            cached: false,
        };
    }
    if (lower.includes("explain") || lower.includes("why")) {
        const cl = Number.isFinite(ctx.cl) ? (ctx.cl as number).toFixed(3) : "n/a";
        return { reply: `Offline read: Cl ${cl} on the current shape, 2D potential flow plus wake overlay. Nudge alpha for more lift.`, cached: false };
    }
    return { reply: "Offline: local only. Ask me to explain the run, propose a spec, or render a poster.", cached: false };
}

/**
 * Single structured Spark call over the recent transcript plus the current
 * run context. Cached by content hash, stale cache served on failure,
 * offline template when the client is offline.
 */
export async function chatReply(
    client: MetaClient,
    cache: HashCache,
    history: string[],
    ctx: ChatContext
): Promise<ChatReply> {
    const key = `spark-chat:${await hashKey({ history: history.slice(-8), ctx })}`;
    const hit = cache.get<Omit<ChatReply, "cached">>(key, { allowStale: true });
    if (hit !== null && !hit.stale) {
        client.reportCacheHit("spark-chat", META_DEFAULT_SPARK_MODEL, key);
        return { ...hit.value, cached: true };
    }
    const stale = hit !== null ? hit.value : null;
    const metricsLine =
        Number.isFinite(ctx.cl) && Number.isFinite(ctx.cpMin)
            ? `Computed Cl ${(ctx.cl as number).toFixed(3)}, CpMin ${(ctx.cpMin as number).toFixed(3)}.`
            : "No solved metrics yet.";
    const user = [
        `Current spec: ${JSON.stringify(ctx.spec)}`,
        metricsLine,
        "Transcript (oldest first):",
        ...history.slice(-8).map((h, i) => `${i + 1}. ${h}`),
    ].join("\n");
    try {
        const result = await client.chatJson("spark-chat", CHAT_SYSTEM, user, toChatReply, {
            model: META_DEFAULT_SPARK_MODEL,
            temperature: 0,
            reasoningEffort: "low",
            hash: key,
        });
        cache.set(key, result, TTL_SPARK_MS);
        return { ...result, cached: false };
    } catch (e) {
        if (stale !== null) {
            client.reportCacheHit("spark-chat", META_DEFAULT_SPARK_MODEL, key);
            return { ...stale, cached: true };
        }
        const reason = e instanceof Error ? e.message : String(e);
        if (reason.includes("offline")) return offlineReply(history, ctx);
        return offlineReply(history, ctx);
    }
}
