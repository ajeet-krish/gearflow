// Phase B3 local assistant. Pure deterministic replies with zero network.
// localReply mirrors the Baseten envelope shape (reply plus actions plus
// rejections) so the console settles local and remote envelopes through one
// path. Covers explainers that cite Cl, CpMin, Re, and regime with one
// suggested change plus a caveat, tool help naming the SOLVER, FIELD, and
// TELEMETRY bars plus the GEOMETRY and DISPLAY windows, setup parsing for
// NACA codes plus alpha plus Re plus body tokens with schema clamps, and
// engine plus field plus run intents with gating. Run requests return a
// run_lbm action for the confirm chip and never auto run. Every candidate
// action is rechecked through validateAgentAction, so local envelopes carry
// the same validity as Baseten envelopes. Never throws.

import { ALPHA_HARD_MAX, ALPHA_HARD_MIN, ALPHA_MAX, ALPHA_MIN, RE_MAX, RE_MIN } from "@/contracts/schema";
import type { AgentContext } from "./agentContext";
import {
    BODY_TOKENS,
    REPLY_MAX,
    validateAgentAction,
    type AgentEnvelope,
    type AgentValidationContext,
} from "./agentActions";
import type { AgentAction, BodyToken } from "@/contracts/types";

const NACA_RE = /naca[\s_]*(\d{4})/i;
const ALPHA_KEY_RE = /alpha[^-\d]{0,8}(-?\d+(?:\.\d+)?)/i;
const ALPHA_DEG_RE = /(-?\d+(?:\.\d+)?)\s*(?:deg|°)/i;
const RE_RE = /\bre(?:ynolds)?\s*(?:number|value|of|at|to|=|:)?\s*(\d[\d,]*(?:\.\d+)?(?:e[+-]?\d+)?)/i;
const ENGINE_RE = /\b(analytic|wasm|lbm|surrogate)\b/;
const ENGINE_VERB_RE = /(switch|change|use|set|engine|mode)/;
const FIELD_TRIGGER_RE = /(field|quantity|show|display|switch|view|overlay|channel|plot)\b/;
const FIELD_NAMES: ReadonlyArray<string> = ["speed", "cp", "omega", "u", "v", "k", "recirc"];
const EXPLAIN_RE = /(explain|why\b|what happened|interpret|read the run|engineer|walk me through)/;
const HELP_RE = /(how do i|how to|how do you|where is|where do|help|what can you|which bar|which window|solver bar|field bar|telemetry|geometry window|display window|change re\b)/;
const SETUP_WORD_RE = /(set\s*up|setup|redesign|reconfig|propos|thicker|thinner|camber|design point|high lift|suggest a change)/;

function finiteOrNull(v: unknown): number | null {
    return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function cleanText(v: unknown, fallback: string): string {
    if (typeof v !== "string") return fallback;
    const t = v.trim().replace(/\s+/g, " ");
    return t.length > 0 ? t : fallback;
}

/** Live validation context mirrored from the console helper, so gating
 *  matches the Baseten path: k and recirc need stats, run needs LBM live. */
function validationFor(ctx: AgentContext | null): AgentValidationContext {
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

function findBodyToken(lower: string): string | null {
    for (const tok of BODY_TOKENS) {
        if (tok.startsWith("naca")) {
            const digits = tok.slice(4);
            if (new RegExp(`naca\\s*${digits}\\b`).test(lower)) return tok;
        } else if (new RegExp(`\\b${tok}\\b`).test(lower)) {
            return tok;
        }
    }
    return null;
}

function findAlpha(lower: string): number | null {
    const keyed = lower.match(ALPHA_KEY_RE);
    if (keyed !== null) {
        const v = Number(keyed[1]);
        return Number.isFinite(v) ? v : null;
    }
    const deg = lower.match(ALPHA_DEG_RE);
    if (deg !== null) {
        const v = Number(deg[1]);
        return Number.isFinite(v) ? v : null;
    }
    return null;
}

function findRe(lower: string): number | null {
    const m = lower.match(RE_RE);
    if (m === null) return null;
    const v = Number(m[1].replace(/,/g, ""));
    return Number.isFinite(v) ? v : null;
}

function findField(lower: string): string | null {
    if (/\bvorticity\b/.test(lower)) return "omega";
    for (const name of FIELD_NAMES) {
        if (new RegExp(`\\b${name}\\b`).test(lower)) return name;
    }
    if (/\bpressure\b/.test(lower)) return "cp";
    return null;
}

function detectRun(lower: string): "run_lbm" | "cancel_lbm" | null {
    if (lower.includes("cancel") && lower.includes("lbm")) return "cancel_lbm";
    if (/\bpress\s+run\b/.test(lower)) return "run_lbm";
    if (/\bstart\s+the\s+(lbm\s+)?solve\b/.test(lower)) return "run_lbm";
    if (/\brerun\b/.test(lower) && /(lbm|solve|simulation|solver)/.test(lower)) return "run_lbm";
    if (/\brun\b/.test(lower) && /(lbm|solve|simulation|solver)/.test(lower)) return "run_lbm";
    return null;
}

function buildExplainer(ctx: AgentContext | null): string {
    const cl = ctx === null ? null : finiteOrNull(ctx.cl);
    const cp = ctx === null ? null : finiteOrNull(ctx.cpMin);
    const re = ctx === null ? null : finiteOrNull(ctx.reynolds);
    const alpha = ctx === null ? null : finiteOrNull(ctx.alphaDeg);
    const body = ctx === null ? "current body" : cleanText(ctx.bodyLabel, "current body");
    const regime = ctx === null ? "unknown regime" : cleanText(ctx.regime, "unknown regime");
    const clText = cl === null ? "Cl pending a clean solve" : `Cl ${cl.toFixed(3)}`;
    const cpText = cp === null ? "CpMin pending a clean solve" : `CpMin ${cp.toFixed(3)}`;
    const reText = re === null ? "Re unset" : `Re ${Math.round(re)}`;
    const alphaText = alpha === null ? "alpha unset" : `alpha ${alpha.toFixed(1)} deg`;
    let suggestion: string;
    if (alpha !== null && alpha < ALPHA_MAX) {
        suggestion = "raise alpha by 1 deg for more lift, watching CpMin for suction peak growth";
    } else if (alpha !== null) {
        suggestion = `alpha is at the top of the [${ALPHA_MIN}, ${ALPHA_MAX}] envelope, raise Re toward ${RE_MAX} for a thinner boundary layer instead`;
    } else {
        suggestion = `set an alpha inside [${ALPHA_MIN}, ${ALPHA_MAX}] deg, then raise it a touch for more lift`;
    }
    return (
        `Local engineer note, local only. ${body} at ${alphaText}, ${reText}, ${regime}: ` +
        `${clText}, ${cpText}. Suggested change: ${suggestion}. ` +
        `Caveat: analytic estimate only, press Run for the viscous solve. Canvas unchanged.`
    );
}

function buildHelp(): string {
    return (
        "Local help, no network. The solver bar, field bar, and telemetry bar (SOLVER, FIELD, TELEMETRY) " +
        "hold BODY plus alpha plus RE plus engine plus Run, the field quantity, and Cl plus CpMin plus validation. " +
        "The geometry window (GEOMETRY) edits the shape preset and the display window (DISPLAY) edits colormap plus " +
        "particles. Canvas unchanged."
    );
}

function buildGeneric(): string {
    return (
        "Local note, no network. Ask to explain the run, set up a body (NACA 0012, 2412, 4412, cylinder, block, orifice), " +
        "switch engine or field, or run LBM, and the console answers from local state. Canvas unchanged."
    );
}

/**
 * Deterministic local reply with the Baseten envelope shape. Zero network,
 * never throws: malformed or empty input falls back to a plain note with no
 * actions. Setup values clamp to the schema envelopes with a notice, an
 * ambiguous setup defaults to the current body with one clarifying line,
 * gated fields and runs without a live LBM come back as rejections.
 */
export function localReply(text: unknown, ctx: AgentContext | null | undefined): AgentEnvelope {
    try {
        const safe = ctx ?? null;
        const vctx = validationFor(safe);
        const raw = typeof text === "string" ? text : "";
        const lower = raw.toLowerCase();
        const bodyLabel = safe === null ? "current body" : cleanText(safe.bodyLabel, "current body");
        if (lower.trim().length === 0) {
            return { reply: buildGeneric(), actions: [], rejections: [] };
        }
        if (EXPLAIN_RE.test(lower)) {
            return { reply: buildExplainer(safe), actions: [], rejections: [] };
        }
        const actions: AgentAction[] = [];
        const rejections: string[] = [];
        const sections: string[] = [];
        const accept = (candidate: AgentAction): boolean => {
            const checked = validateAgentAction(candidate, vctx);
            if (checked.ok && checked.action !== null) {
                actions.push(checked.action);
                return true;
            } else {
                rejections.push(checked.reason ?? `rejected ${describeAction(candidate)}`);
                return false;
            }
        };
        const bodyTok = findBodyToken(lower);
        const nacaMatch = lower.match(NACA_RE);
        const unknownNaca = nacaMatch !== null && bodyTok === null ? nacaMatch[1] : null;
        const alphaVal = findAlpha(lower);
        const reVal = findRe(lower);
        const hasSetupValues = bodyTok !== null || unknownNaca !== null || alphaVal !== null || reVal !== null;
        if (hasSetupValues) {
            const applied: string[] = [];
            const notices: string[] = [];
            if (bodyTok !== null) {
                if (accept({ kind: "set_body", body: bodyTok as BodyToken })) {
                    applied.push(`body ${bodyTok}`);
                }
            } else if (unknownNaca !== null) {
                rejections.push(
                    `naca ${unknownNaca} is not a console body, staying on ${bodyLabel}; bodies are [${BODY_TOKENS.join(", ")}]`
                );
            }
            if (alphaVal !== null) {
                const clamped = Math.min(Math.max(alphaVal, ALPHA_HARD_MIN), ALPHA_HARD_MAX);
                if (accept({ kind: "set_alpha", alphaDeg: clamped })) {
                    applied.push(`alpha ${clamped}`);
                }
                if (clamped !== alphaVal) {
                    notices.push(`Note: alpha ${alphaVal} clamped to ${clamped} (envelope [${ALPHA_HARD_MIN}, ${ALPHA_HARD_MAX}]).`);
                }
            }
            if (reVal !== null) {
                const rounded = Math.round(reVal);
                const clamped = Math.min(Math.max(rounded, RE_MIN), RE_MAX);
                if (accept({ kind: "set_reynolds", reynolds: clamped })) {
                    applied.push(`Re ${clamped}`);
                }
                if (clamped !== rounded) {
                    notices.push(`Note: Re ${rounded} clamped to ${clamped} (envelope [${RE_MIN}, ${RE_MAX}]).`);
                }
            }
            if (applied.length > 0) {
                sections.push(`Local setup note, no network. Applying ${applied.join(", ")}.`);
            } else {
                sections.push(
                    `Local setup note, no network. Staying on ${bodyLabel}; tell me which body ` +
                    `(NACA 0012, 2412, 4412, cylinder, block, orifice), alpha, and Re to use.`
                );
            }
            if (notices.length > 0) sections.push(notices.join(" "));
            if (bodyTok === null && applied.length > 0) {
                sections.push(
                    `Staying on ${bodyLabel}; name a body (NACA 0012, 2412, 4412, cylinder, block, orifice) to switch.`
                );
            }
        } else if (HELP_RE.test(lower)) {
            return { reply: buildHelp(), actions: [], rejections: [] };
        } else if (SETUP_WORD_RE.test(lower)) {
            sections.push(
                `Local setup note, no network. Staying on ${bodyLabel}; tell me which body ` +
                `(NACA 0012, 2412, 4412, cylinder, block, orifice), alpha, and Re to use.`
            );
        }
        const engineMatch = lower.match(ENGINE_RE);
        if (engineMatch !== null && ENGINE_VERB_RE.test(lower)) {
            const token = engineMatch[1];
            accept({ kind: "set_engine", engine: token as AgentAction extends { kind: "set_engine"; engine: infer E } ? E : never });
            sections.push(`Local engine note, no network. Switching engine to ${token}. Canvas updates on apply.`);
        }
        const fieldName = findField(lower);
        if (fieldName !== null && (FIELD_TRIGGER_RE.test(lower) || lower.includes(`field ${fieldName}`))) {
            accept({
                kind: "set_field",
                field: fieldName as AgentAction extends { kind: "set_field"; field: infer F } ? F : never,
            });
            const wasAccepted = actions.some((a) => a.kind === "set_field");
            sections.push(
                wasAccepted
                    ? `Local field note, no network. Switching field to ${fieldName}. Canvas updates on apply.`
                    : `Local field note, no network. Field ${fieldName} stays gated until the first LBM statistics sample. Canvas unchanged.`
            );
        }
        const runKind = detectRun(lower);
        if (runKind !== null) {
            accept(runKind === "run_lbm" ? { kind: "run_lbm" } : { kind: "cancel_lbm" });
            const staged = actions.some((a) => a.kind === "run_lbm" || a.kind === "cancel_lbm");
            sections.push(
                staged
                    ? runKind === "run_lbm"
                        ? "Local run note, no network. Run staged: confirm with the Run LBM chip to start the viscous solve. Canvas unchanged until confirm."
                        : "Local run note, no network. Cancel staged: confirm with the Cancel LBM chip. Nothing runs until confirm."
                    : "Local run note, no network. Run stays gated until the LBM engine is live. Canvas unchanged."
            );
        }
        if (sections.length === 0) {
            return { reply: buildGeneric(), actions, rejections };
        }
        const reply = `${sections.join(" ")} Canvas unchanged.`.replace(/Canvas unchanged\. Canvas unchanged\./g, "Canvas unchanged.");
        return {
            reply: reply.length > REPLY_MAX ? reply.slice(0, REPLY_MAX) : reply,
            actions,
            rejections,
        };
    } catch {
        return { reply: buildGeneric(), actions: [], rejections: [] };
    }
}
