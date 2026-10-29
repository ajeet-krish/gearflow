// Phase B3 local assistant. Pure deterministic replies with zero network.
// localReply mirrors the Baseten envelope shape (reply plus actions plus
// rejections) so the console settles local and remote envelopes through one
// path. NACA plus alpha plus Re resolve through the shared R1 airfoil intent
// parser (parseAirfoilIntent), so offline setup agrees with the tested
// corpus; only non NACA body tokens resolve locally. Covers explainers that cite Cl, CpMin, Re, and regime with one
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
import { parseAirfoilIntent, parseAlphaDeg, parseReynolds } from "./airfoilIntent";
import { isSchemaValidCode, nearestValidCode, parseNacaLoose } from "./nacaParse";
import { localTutorReply } from "./tutorPolicy";
import type { TutorSnapshotLite } from "./tutorTable";
import type { AgentAction, BodyToken } from "@/contracts/types";

/** Lite tutor snapshot from the live agent context, mirroring the console
 *  snapshotLiteFor mapping without the React layer. Never throws. */
function tutorLiteFromCtx(ctx: AgentContext): TutorSnapshotLite {
    try {
        const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
        const text = (v: unknown, fallback: string): string => {
            if (typeof v !== "string") return fallback;
            const t = v.trim().replace(/\s+/g, " ");
            return t.length > 0 ? t : fallback;
        };
        const spec = (ctx.spec ?? {}) as { kind?: unknown; alphaDeg?: unknown };
        const kind = typeof spec.kind === "string" ? spec.kind : "unknown";
        const alpha = num(ctx.alphaDeg ?? spec.alphaDeg);
        const reynolds = num(ctx.reynolds);
        const fieldVar = (() => {
            const f = (ctx.field ?? {}) as { variable?: unknown; effective?: unknown };
            if (typeof f.variable === "string" && f.variable.trim().length > 0) return f.variable.trim();
            if (typeof f.effective === "string" && f.effective.trim().length > 0) return f.effective.trim();
            return "speed";
        })();
        const fieldToken = `f${fieldVar}`;
        const key = typeof ctx.caseKey === "string" && ctx.caseKey.trim().length > 0
            ? ctx.caseKey.trim()
            : `${kind}|a${alpha === null ? "?" : alpha}|Re${reynolds === null ? "?" : Math.round(reynolds)}|${text(ctx.neural?.path, "analytic")}|${fieldToken}`;
        const keyWithField = key.includes("|f") ? key : `${key}|${fieldToken}`;
        return {
            caseKey: keyWithField,
            bodyLabel: text(ctx.bodyLabel, "unknown body"),
            alpha,
            reynolds,
            cl: num(ctx.cl),
            cpMin: num(ctx.cpMin),
            regime: text(ctx.regime, "unknown regime"),
            pathLabel: text(ctx.provenanceLabel, "") !== "" ? text(ctx.provenanceLabel, "analytic") : text(ctx.neural?.path, "analytic"),
            strouhal: num(ctx.surrogate?.strouhal ?? ctx.lbm?.stats?.strouhal ?? null),
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

/** Canonical console bodies. Anything else valid goes through set_spec. */
const CANONICAL_NACA: ReadonlySet<string> = new Set(["naca0012", "naca2412", "naca4412"]);
const ENGINE_RE = /\b(analytic|wasm|lbm|surrogate)\b/;
const ENGINE_VERB_RE = /(switch|change|use|set|engine|mode)/;
const FIELD_TRIGGER_RE = /(field|quantity|show|display|switch|view|overlay|channel|plot)\b/;
const FIELD_NAMES: ReadonlyArray<string> = ["speed", "cp", "omega", "u", "v", "k", "recirc"];
/** Bare mentions only stage with an action verb, mirroring R1 verb gating. */
const VERB_GATE_RE = /\b(set|setup|show|use|try|generate|run|switch|apply|make|test|simulate|change|display|put)\b/i;
const EXPLAIN_RE = /(explain|why\b|what happened|interpret|read the run|engineer|walk me through)/;
const HELP_RE = /(how do i|how to|how do you|where is|where do|help|what can you|which bar|which window|solver bar|field bar|telemetry|geometry window|display window|change re\b)/;
const SETUP_WORD_RE = /(set\s*up|setup|redesign|reconfig|propos|thicker|thinner|camber|design point|high lift|suggest a change)/;
/** Phenomenological case triggers. Each maps to one trusted setup preset. */
const SHEDDING_RE = /(karman|vortex shedding|vortex street|shedding)/;
const HIGH_PRESSURE_PHENOM_RE = /(high pressure|stagnation)/;
const AIRFOIL_WORD_RE = /\bairfoil\b/;
/** Honest cannot do triggers. The tunnel is 2D incompressible analytic plus
 *  low speed LBM, so these answer with zero actions, canvas unchanged. */
const CANNOT_3D_RE = /(3d|three dimensional)/;
const CANNOT_COMPRESSIBLE_RE = /(supersonic|compressible|transonic|mach\s*\d)/;
const SEPARATION_RE = /(viscous separation|flow separation|separation bubble|\bstall\b)/;
/** Glossary questions name a physics term, never a setup action. */
const GLOSSARY_Q_RE = /\bwhat\s+(is|are|does|do)\b|\bwhat's\b|\bdefine\b|\bmeaning of\b/;

function finiteOrNull(v: unknown): number | null {
    return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function cleanText(v: unknown, fallback: string): string {
    if (typeof v !== "string") return fallback;
    const t = v.trim().replace(/\s+/g, " ");
    return t.length > 0 ? t : fallback;
}

/** Live validation context mirrored from the console helper, so gating
 *  matches the Baseten path: k and recirc need stats, run needs LBM live,
 *  setup presets gate on the neural envelope only while it can serve. */
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
    const neural = (ctx as unknown as { neural?: { available?: unknown } }).neural;
    return {
        lbmEffective,
        statsReady: ctx.lbm?.statsReady === true,
        hasTke: ctx.field?.hasTke === true,
        hasRecirc: ctx.field?.hasRecirc === true,
        neuralAvailable: neural?.available === true,
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
    if (a.kind === "setup_shedding") return "vortex shedding case (cylinder, alpha 0, Re 100, speed field)";
    if (a.kind === "setup_high_re_wake") return "high Re wake case (cylinder, alpha 0, Re 700, speed field)";
    if (a.kind === "setup_high_pressure") return "retired high pressure case (use setup_high_re_wake instead)";
    if (a.kind === "setup_airfoil") return "airfoil case (NACA, speed field)";
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

/** Non-canonical code the console cannot carry as a body token. Null when
 *  the shared parser resolved no code or a canonical console body matched. */
function unknownNacaHere(code: string | null, bodyTok: string | null): string | null {
    if (code === null) return null;
    if (bodyTok !== null && CANONICAL_NACA.has(bodyTok)) return null;
    return code;
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

/** Any-airfoil set_spec candidate mirroring the online buildAirfoilEnvelope
 *  single set_spec shape: full naca4 parametrics carrying alpha and Re, so
 *  the body never applies without its flow condition. Never throws. */
function anyAirfoilSpec(code: string, m: number, p: number, t: number, alpha: number, reynolds: number): AgentAction {
    return {
        kind: "set_spec",
        spec: {
            geometry: {
                kind: "naca4",
                naca: { code, m, p, t },
                chord: 1,
                alphaDeg: alpha,
                nPoints: 120,
            },
            reynolds,
            rationale: `Parser apply for NACA ${code}.`,
        },
    };
}

/** Plain physics definitions with current case numbers when the context
 *  carries them. Zero actions, questions never auto-apply. Never throws. */
function buildGlossary(lower: string, ctx: AgentContext | null): string | null {
    try {
        if (!GLOSSARY_Q_RE.test(lower)) return null;
        const parts: string[] = [];
        if (/\blift\b|\bcl\b/.test(lower)) {
            const cl = ctx === null ? null : finiteOrNull(ctx.cl);
            parts.push(
                "Cl is the lift coefficient, lift divided by dynamic pressure times chord. Higher means more lift for the same size and speed." +
                (cl === null ? "" : ` Current case: Cl ${cl.toFixed(3)}.`)
            );
        }
        if (/\bcpmin\b|\bpressure\b|\bcp\b/.test(lower)) {
            const cp = ctx === null ? null : finiteOrNull(ctx.cpMin);
            parts.push(
                "Cp is the pressure coefficient, local pressure minus freestream over dynamic pressure. Negative means suction, and CpMin is the lowest value, the strongest suction peak." +
                (cp === null ? "" : ` Current case: CpMin ${cp.toFixed(3)}.`)
            );
        }
        if (/\bvorticity\b|\bomega\b|\bswirl\b/.test(lower)) {
            parts.push(
                "Vorticity (omega) is the local swirl of the flow, the curl of velocity. Positive spins one way and negative the other, marking shear layers and the wake."
            );
        }
        if (/\breynolds\b|\bre\b/.test(lower)) {
            const re = ctx === null ? null : finiteOrNull(ctx.reynolds);
            parts.push(
                "Re is the Reynolds number, inertial over viscous forces. Higher means a thinner boundary layer and more tendency to unsteadiness." +
                (re === null ? "" : ` Current case: Re ${Math.round(re)}.`)
            );
        }
        if (/\balpha\b|\bangle of attack\b|\baoa\b/.test(lower)) {
            const alpha = ctx === null ? null : finiteOrNull(ctx.alphaDeg);
            parts.push(
                "Alpha is the angle of attack in degrees, nose up positive. More alpha means more lift until stall." +
                (alpha === null ? "" : ` Current case: alpha ${alpha.toFixed(1)} deg.`)
            );
        }
        if (parts.length === 0) return null;
        return `Local definition, no network. ${parts.join(" ")}`;
    } catch {
        return null;
    }
}

/**
 * Deterministic local reply with the Baseten envelope shape. Zero network,
 * never throws: malformed or empty input falls back to a plain note with no
 * actions. Phenomenological triggers (shedding, high pressure, airfoil)
 * expand to trusted setup presets. Setup values clamp to the schema
 * envelopes with a notice, an ambiguous setup asks one clarifying question
 * with canvas unchanged, honest cannot do topics answer with zero actions,
 * gated fields and runs without a live LBM come back as rejections.
 * At most five actions per envelope, extras are rejected with a note.
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
        if (CANNOT_3D_RE.test(lower)) {
            return {
                reply: "Cannot do 3D: the tunnel is 2D only (chord normalized, y-up). Set up a 2D body (NACA 0012, 2412, 4412, cylinder, block, orifice) instead. Canvas unchanged.",
                actions: [],
                rejections: [],
            };
        }
        if (CANNOT_COMPRESSIBLE_RE.test(lower)) {
            return {
                reply: "Cannot do compressible or supersonic flow: the solver is incompressible analytic plus low speed LBM. Stay subsonic and set an Re in [1000, 1000000] instead. Canvas unchanged.",
                actions: [],
                rejections: [],
            };
        }
        if (EXPLAIN_RE.test(lower)) {
            if (safe !== null) {
                try {
                    const snap = tutorLiteFromCtx(safe);
                    const table = localTutorReply(snap, snap);
                    return { reply: `${buildExplainer(safe)}\n\n${table}`.slice(0, REPLY_MAX), actions: [], rejections: [] };
                } catch {
                    return { reply: buildExplainer(safe), actions: [], rejections: [] };
                }
            }
            return { reply: buildExplainer(safe), actions: [], rejections: [] };
        }
        if (SEPARATION_RE.test(lower) && vctx.lbmEffective !== true) {
            return {
                reply: "Cannot show viscous separation on the analytic path: the potential model omits separation and stall. Press Run for the viscous LBM solve to see the separated wake. Canvas unchanged.",
                actions: [],
                rejections: [],
            };
        }
        const actions: AgentAction[] = [];
        const rejections: string[] = [];
        const sections: string[] = [];
        const glossary = buildGlossary(lower, safe);
        if (glossary !== null) {
            return { reply: `${glossary} Canvas unchanged.`, actions: [], rejections: [] };
        }
        const accept = (candidate: AgentAction): boolean => {
            if (actions.length >= 5) {
                rejections.push("extra actions beyond 5 ignored");
                return false;
            }
            const checked = validateAgentAction(candidate, vctx);
            if (checked.ok && checked.action !== null) {
                actions.push(checked.action);
                return true;
            } else {
                rejections.push(checked.reason ?? `rejected ${describeAction(candidate)}`);
                return false;
            }
        };
        let presetHandled = false;
        let suppressFieldStage = false;
        if (SHEDDING_RE.test(lower)) {
            presetHandled = true;
            const staged = accept({ kind: "setup_shedding" });
            sections.push(
                staged
                    ? "Local setup note, no network. Applying the vortex shedding case (cylinder, alpha 0, Re 100, speed field). Canvas updates on apply."
                    : `Local setup note, no network. Staying on ${bodyLabel}; the shedding case is outside the serving envelope. Canvas unchanged.`
            );
        } else if (HIGH_PRESSURE_PHENOM_RE.test(lower)) {
            presetHandled = true;
            if (lower.includes("cylinder")) {
                suppressFieldStage = true;
                const staged = accept({ kind: "setup_high_re_wake" });
                sections.push(
                    staged
                        ? "Local setup note, no network. Applying the high Re wake case (cylinder, alpha 0, Re 700, speed field). Stagnation tutor note: Cp nears 1 at the nose where the flow stops, then falls around the shoulders. Canvas updates on apply."
                        : `Local setup note, no network. Staying on ${bodyLabel}; the high Re wake case is outside the serving envelope. Canvas unchanged.`
                );
            } else {
                const wantsBlock = /\bblock\b/.test(lower);
                const staged = accept(wantsBlock ? { kind: "setup_high_pressure", body: "block" } : { kind: "setup_high_pressure" });
                sections.push(
                    staged
                        ? `Local setup note, no network. Applying the high Re wake case (cylinder, alpha 0, Re 700, speed field). Canvas updates on apply.`
                        : `Local setup note, no network. Staying on ${bodyLabel}; the high pressure case is outside the serving envelope. Nearest alternative: the high Re wake case (cylinder, alpha 0, Re 700). Canvas unchanged.`
                );
            }
        } else if (AIRFOIL_WORD_RE.test(lower)) {
            presetHandled = true;
            const parsed = parseNacaLoose(raw);
            const alphaHere = parseAlphaDeg(raw);
            if (parsed.status === "ambiguous") {
                sections.push(`Local setup note, no network. ${parsed.question} Canvas unchanged.`);
            } else if (parsed.status === "invalid") {
                const label = parsed.code === null ? "That code" : `NACA ${parsed.code}`;
                const hint = parsed.nearest !== null ? ` Did you mean NACA ${parsed.nearest}?` : "";
                sections.push(
                    `Local setup note, no network. ${label} is not a valid 4-digit section (${parsed.reason}).${hint} ` +
                    `Reply with a valid 4-digit code (try 0012, 2412, or 4412). Canvas unchanged.`
                );
            } else if (parsed.status === "none") {
                const candidate: AgentAction = { kind: "setup_airfoil" };
                if (alphaHere !== null) (candidate as { alphaDeg?: number }).alphaDeg = alphaHere;
                const staged = accept(candidate);
                if (staged) {
                    sections.push("Local setup note, no network. Applying the airfoil case (NACA, speed field). Canvas updates on apply.");
                } else {
                    sections.push(
                        `Local setup note, no network. Staying on ${bodyLabel}; the airfoil case is outside the serving envelope. Canvas unchanged.`
                    );
                }
            } else {
                const check = isSchemaValidCode(parsed.code);
                if (!check.ok) {
                    let nearest: string | null = null;
                    try {
                        nearest = nearestValidCode(parsed.code);
                    } catch {
                        nearest = null;
                    }
                    const hint = nearest !== null ? ` Did you mean NACA ${nearest}?` : "";
                    sections.push(
                        `Local setup note, no network. NACA ${parsed.code} is not a valid 4-digit section (${check.reason ?? "outside the schema envelope"}).${hint} ` +
                        `Reply with a valid 4-digit code (try 0012, 2412, or 4412). Canvas unchanged.`
                    );
                } else if (CANONICAL_NACA.has(`naca${check.code}`)) {
                    const candidate: AgentAction = { kind: "setup_airfoil" };
                    (candidate as { body?: BodyToken }).body = `naca${check.code}` as BodyToken;
                    if (alphaHere !== null) (candidate as { alphaDeg?: number }).alphaDeg = alphaHere;
                    const staged = accept(candidate);
                    if (staged) {
                        sections.push("Local setup note, no network. Applying the airfoil case (NACA, speed field). Canvas updates on apply.");
                    } else {
                        sections.push(
                            `Local setup note, no network. Staying on ${bodyLabel}; the airfoil case is outside the serving envelope. Canvas unchanged.`
                        );
                    }
                } else {
                    // Valid non-canonical code: ride one set_spec like the
                    // online fast path, carrying alpha and Re inside so the
                    // body never applies without its flow condition. Only
                    // invalid or ambiguous codes fall back to rejection.
                    const reHere = parseReynolds(raw);
                    const ctxAlpha = finiteOrNull(safe?.alphaDeg);
                    const ctxRe = finiteOrNull(safe?.reynolds);
                    let alpha = alphaHere ?? ctxAlpha ?? 6;
                    let reynolds = reHere === null ? (ctxRe === null ? 50000 : Math.round(ctxRe)) : Math.round(reHere);
                    const specNotes: string[] = [];
                    const clampedAlpha = Math.min(Math.max(alpha, ALPHA_HARD_MIN), ALPHA_HARD_MAX);
                    if (clampedAlpha !== alpha) specNotes.push(`Note: alpha ${alpha} clamped to ${clampedAlpha} (envelope [${ALPHA_HARD_MIN}, ${ALPHA_HARD_MAX}]).`);
                    alpha = clampedAlpha;
                    const clampedRe = Math.min(Math.max(Math.round(reynolds), RE_MIN), RE_MAX);
                    if (clampedRe !== Math.round(reynolds)) specNotes.push(`Note: Re ${Math.round(reynolds)} clamped to ${clampedRe} (envelope [${RE_MIN}, ${RE_MAX}]).`);
                    reynolds = clampedRe;
                    const staged = accept(anyAirfoilSpec(check.code, check.m, check.p, check.t, alpha, reynolds));
                    if (staged) {
                        const tutor = parsed.note ?? check.note;
                        sections.push(
                            `Local setup note, no network. Applying body naca${check.code} (NACA ${check.code}, alpha ${alpha}, Re ${reynolds}). Canvas updates on apply.` +
                            (specNotes.length > 0 ? ` ${specNotes.join(" ")}` : "") +
                            (tutor !== null ? ` ${tutor}` : "")
                        );
                    } else {
                        sections.push(
                            `Local setup note, no network. Staying on ${bodyLabel}; NACA ${check.code} with alpha ${alpha} and Re ${reynolds} is outside the serving envelope. Canvas unchanged.`
                        );
                    }
                }
            }
        }
        // NACA plus alpha plus Re come from the shared airfoil intent parser
        // so offline setup agrees with the tested corpus. The live section
        // code in the context snapshot grounds relative edits, the body
        // label is the fallback for older snapshots. Non NACA bodies
        // (cylinder, block, orifice) still resolve from the body tokens.
        const sectionCode = (() => {
            try {
                const snap = safe?.spec?.naca?.code;
                if (typeof snap === "string" && /\d{4}/.test(snap)) return snap;
            } catch {
                // Fall through to the body label below.
            }
            return safe === null ? null : cleanText(safe.bodyLabel, "current body");
        })();
        const intent = presetHandled ? null : parseAirfoilIntent(raw, { code: sectionCode });
        const clarified = intent !== null && intent.kind === "clarify";
        if (clarified) {
            sections.push(`Local note, no network. ${intent.question} Canvas unchanged.`);
            if (intent.corrections.length > 0) sections.push(`Note: ${intent.corrections.join("; ")}.`);
        }
        const applyIntent = intent !== null && intent.kind === "apply" ? intent : null;
        const intentCode = applyIntent?.code ?? null;
        let bodyTok = presetHandled ? null : findBodyToken(lower);
        // Multi-code ambiguity bypasses parseAirfoilIntent (it returns null
        // for "A and B"), but findBodyToken would still stage the first body
        // under the verb gate. Suppress the token whenever the loose parser
        // reports ambiguous so ambiguous text never auto applies.
        if (bodyTok !== null && !presetHandled) {
            try {
                if (parseNacaLoose(raw).status === "ambiguous") bodyTok = null;
            } catch {
                bodyTok = null;
            }
        }
        if (bodyTok === null && intentCode !== null && CANONICAL_NACA.has(`naca${intentCode}`)) {
            bodyTok = `naca${intentCode}`;
        }
        // R1 verb gating for pure mentions: a named body with no parsed
        // action (no code, alpha, Re, or reshape) only stages when the text
        // carries an action verb, so questions and mentions ("what is NACA
        // 2412") leave the canvas alone. Parsed intents bypass the gate.
        if (bodyTok !== null && applyIntent === null && intentCode === null && !VERB_GATE_RE.test(lower)) {
            bodyTok = null;
        }
        const unknownNaca = presetHandled ? null : unknownNacaHere(intentCode, bodyTok);
        const alphaVal = presetHandled ? null : (applyIntent?.alphaDeg ?? null);
        const reVal = presetHandled ? null : (applyIntent?.reynolds ?? null);
        const tutorNote = applyIntent !== null && applyIntent.notes.length > 0 ? applyIntent.notes.join(" ") : null;
        const typoNotes = applyIntent !== null && applyIntent.corrections.length > 0 ? applyIntent.corrections.join("; ") : null;
        const hasSetupValues = !clarified && (bodyTok !== null || unknownNaca !== null || alphaVal !== null || reVal !== null);
        if (hasSetupValues) {
            const applied: string[] = [];
            const notices: string[] = [];
            let carriedBySpec = false;
            if (bodyTok !== null) {
                if (accept({ kind: "set_body", body: bodyTok as BodyToken })) {
                    applied.push(`body ${bodyTok}`);
                }
            } else if (unknownNaca !== null) {
                // Valid non-canonical code: ride one set_spec like the online
                // fast path, carrying alpha and Re inside so the body never
                // applies without its flow condition. Only invalid codes
                // fall back to the console body rejection.
                const check = isSchemaValidCode(unknownNaca);
                if (check.ok) {
                    const ctxAlpha = finiteOrNull(safe?.alphaDeg);
                    const ctxRe = finiteOrNull(safe?.reynolds);
                    const rawAlpha = alphaVal ?? ctxAlpha ?? 6;
                    const clampedAlpha = Math.min(Math.max(rawAlpha, ALPHA_HARD_MIN), ALPHA_HARD_MAX);
                    if (clampedAlpha !== rawAlpha) {
                        notices.push(`Note: alpha ${rawAlpha} clamped to ${clampedAlpha} (envelope [${ALPHA_HARD_MIN}, ${ALPHA_HARD_MAX}]).`);
                    }
                    const rawRe = reVal === null ? (ctxRe === null ? 50000 : Math.round(ctxRe)) : Math.round(reVal);
                    const clampedRe = Math.min(Math.max(rawRe, RE_MIN), RE_MAX);
                    if (clampedRe !== rawRe) {
                        notices.push(`Note: Re ${rawRe} clamped to ${clampedRe} (envelope [${RE_MIN}, ${RE_MAX}]).`);
                    }
                    if (accept(anyAirfoilSpec(check.code, check.m, check.p, check.t, clampedAlpha, clampedRe))) {
                        applied.push(`body naca${check.code}`);
                        carriedBySpec = true;
                    }
                } else {
                    rejections.push(
                        `naca ${unknownNaca} is not a console body, staying on ${bodyLabel}; bodies are [${BODY_TOKENS.join(", ")}]`
                    );
                }
            }
            if (alphaVal !== null && !carriedBySpec) {
                const clamped = Math.min(Math.max(alphaVal, ALPHA_HARD_MIN), ALPHA_HARD_MAX);
                if (accept({ kind: "set_alpha", alphaDeg: clamped })) {
                    applied.push(`alpha ${clamped}`);
                }
                if (clamped !== alphaVal) {
                    notices.push(`Note: alpha ${alphaVal} clamped to ${clamped} (envelope [${ALPHA_HARD_MIN}, ${ALPHA_HARD_MAX}]).`);
                }
            }
            if (reVal !== null && !carriedBySpec) {
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
            if (tutorNote !== null) sections.push(tutorNote);
            if (typoNotes !== null) sections.push(`Note: ${typoNotes}.`);
            if (bodyTok === null && !carriedBySpec && applied.length > 0) {
                sections.push(
                    `Staying on ${bodyLabel}; name a body (NACA 0012, 2412, 4412, cylinder, block, orifice) to switch.`
                );
            }
        } else if (HELP_RE.test(lower)) {
            if (presetHandled || clarified) {
                // Phenomenon preset or clarify question already staged above,
                // help copy would contradict it, so keep the staged line only.
            } else {
                return { reply: buildHelp(), actions: [], rejections: [] };
            }
        } else if (SETUP_WORD_RE.test(lower)) {
            if (!presetHandled && !clarified) {
                sections.push(
                    `Local setup note, no network. Staying on ${bodyLabel}; tell me which body ` +
                    `(NACA 0012, 2412, 4412, cylinder, block, orifice), alpha, and Re to use.`
                );
            }
        }
        const engineMatch = lower.match(ENGINE_RE);
        if (engineMatch !== null && ENGINE_VERB_RE.test(lower)) {
            const token = engineMatch[1];
            const staged = accept({ kind: "set_engine", engine: token as AgentAction extends { kind: "set_engine"; engine: infer E } ? E : never });
            sections.push(
                staged
                    ? `Local engine note, no network. Switching engine to ${token}. Canvas updates on apply.`
                    : `Local engine note, no network. Engine ${token} is not a console engine, staying on ${bodyLabel}; engines are [analytic, lbm]. Canvas unchanged.`
            );
        }
        const fieldName = findField(lower);
        if (!suppressFieldStage && fieldName !== null && (FIELD_TRIGGER_RE.test(lower) || lower.includes(`field ${fieldName}`))) {
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
        const joined = sections.join(" ");
        const reply = actions.length === 0
            ? `${joined} Canvas unchanged.`.replace(/Canvas unchanged\. Canvas unchanged\./g, "Canvas unchanged.")
            : joined;
        return {
            reply: reply.length > REPLY_MAX ? reply.slice(0, REPLY_MAX) : reply,
            actions,
            rejections,
        };
    } catch {
        return { reply: buildGeneric(), actions: [], rejections: [] };
    }
}
