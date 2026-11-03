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
import { resolveAgentFirst } from "@/config/agentFirst";
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
/** Constriction language maps to the orifice body with the live orifice
 *  gap and width defaults. Tunnel, venturi, throat, and constriction all
 *  name the narrowed passage the orifice plate carries; the reply stays
 *  purely physical (a narrower gap speeds the flow like a venturi) with
 *  no canvas limit talk. */
const ORIFICE_TRIGGER_RE = /\borifice\b|\bventuri\b|\bthroat\b|\bconstriction\b|\btunnel\b/;
const AIRFOIL_WORD_RE = /\bairfoil\b/;
/** Honest cannot do triggers. The tunnel is 2D incompressible analytic plus
 *  low speed LBM, so these answer with zero actions, canvas unchanged. */
const CANNOT_3D_RE = /(3d|three dimensional)/;
const CANNOT_COMPRESSIBLE_RE = /(supersonic|compressible|transonic|mach\s*\d)/;
const SEPARATION_RE = /(viscous separation|flow separation|separation bubble|\bstall\b)/;
/** Glossary questions name a physics term, never a setup action. */
const GLOSSARY_Q_RE = /\bwhat\s+(is|are|does|do)\b|\bwhat's\b|\bdefine\b|\bmeaning of\b/;
/** Negation guard for phenomenological rescues: declined pressure talk
 *  never stages a preset, it falls through to teaching with zero actions. */
const PRESSURE_NEGATION_RE = /\bdo\s+not\b|\bdon'?t\b|\bnever\b|\bnot\b/i;
/** Declined requests never apply: a negation word anywhere blocks every
 *  setup, engine, field, and run stage, so declined bare or explain talk
 *  settles with zero actions and teaching only. */
const DECLINED_RE = /\bdo\s+not\b|\bdon'?t\b|\bnever\b|\bnot\b/i;
/** Embedded definitional clause: what a/the cylinder (block, orifice,
 *  airfoil) is never stages a body, even with an action verb present. */
const DEFINITIONAL_CLAUSE_RE = /\bwhat\s+(a|an|the)\b[\s\S]*\bis\b/i;

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
 *  setup presets gate on the neural envelope only while it can serve. The
 *  agent-first flag rides the context when the App snapshot names it,
 *  otherwise the build-time default decides. */
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
        agentFirst: resolveAgentFirst((ctx as unknown as { agentFirst?: unknown }).agentFirst),
    };
}

function describeAction(a: AgentAction): string {
    if (a.kind === "set_body") {
        const label = a.body === "block" ? "Rectangle" : a.body;
        return `body ${label}`;
    }
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
    if (/\bvelocity\b/.test(lower)) return "speed";
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
    // The orifice plate has no angle of attack, so its explainer never
    // names one: the gap opening carries the physics instead.
    const isOrifice = /orifice/.test(body.toLowerCase());
    const alphaText = isOrifice ? "no angle (plate has no angle of attack, gap opening sets the physics)" : (alpha === null ? "alpha unset" : `alpha ${alpha.toFixed(1)} deg`);
    const agentFirst = resolveAgentFirst((ctx as unknown as { agentFirst?: unknown } | null)?.agentFirst);
    let suggestion: string;
    if (alpha !== null && alpha < ALPHA_MAX) {
        suggestion = "raise alpha by 1 deg for more lift, watching CpMin for suction peak growth";
    } else if (alpha !== null) {
        suggestion = `alpha is at the top of the [${ALPHA_MIN}, ${ALPHA_MAX}] envelope, raise Re toward ${RE_MAX} for a thinner boundary layer instead`;
    } else {
        suggestion = `set an alpha inside [${ALPHA_MIN}, ${ALPHA_MAX}] deg, then raise it a touch for more lift`;
    }
    const caveat = agentFirst
        ? "Caveat: analytic estimate only, served by the analytic path in agent-first mode. Canvas unchanged."
        : "Caveat: analytic estimate only, press Run for the viscous solve. Canvas unchanged.";
    return (
        `Local engineer note, local only. ${body} at ${alphaText}, ${reText}, ${regime}: ` +
        `${clText}, ${cpText}. Suggested change: ${suggestion}. ` +
        caveat
    );
}

function buildHelp(agentFirst: boolean): string {
    if (agentFirst) {
        return (
            "Local help, no network. The solver bar, field bar, and telemetry bar (SOLVER, FIELD, TELEMETRY) " +
            "hold BODY plus alpha plus RE plus the analytic engine, the field quantity, and Cl plus CpMin plus validation. " +
            "The geometry window (GEOMETRY) edits the shape preset and the display window (DISPLAY) edits colormap plus " +
            "particles. Agent-first analytic mode serves the analytic frame only. Canvas unchanged."
        );
    }
    return (
        "Local help, no network. The solver bar, field bar, and telemetry bar (SOLVER, FIELD, TELEMETRY) " +
        "hold BODY plus alpha plus RE plus engine plus Run, the field quantity, and Cl plus CpMin plus validation. " +
        "The geometry window (GEOMETRY) edits the shape preset and the display window (DISPLAY) edits colormap plus " +
        "particles. Canvas unchanged."
    );
}

function buildGeneric(agentFirst: boolean): string {
    if (agentFirst) {
        return (
            "Local note, no network. Ask to explain the run, set up a body, or switch field within the analytic path, and the console answers from local state. " +
            "Agent-first analytic mode serves the analytic frame only. Canvas unchanged."
        );
    }
    return (
        "Local note, no network. Ask to explain the run, set up a body, " +
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
                "lift coefficient (Cl) is lift divided by dynamic pressure times chord. Higher means more lift for the same size and speed." +
                (cl === null ? "" : ` Current case: lift coefficient (Cl) ${cl.toFixed(3)}.`)
            );
        }
        if (/\bcpmin\b|\bpressure\b|\bcp\b/.test(lower)) {
            const cp = ctx === null ? null : finiteOrNull(ctx.cpMin);
            parts.push(
                "pressure coefficient (Cp) is local pressure minus freestream over dynamic pressure. Negative means suction, and minimum pressure coefficient is the lowest value, the strongest suction peak." +
                (cp === null ? "" : ` Current case: minimum pressure coefficient ${cp.toFixed(3)}.`)
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
                "Reynolds number (Re) is inertial over viscous forces. Higher means a thinner boundary layer and more tendency to unsteadiness." +
                (re === null ? "" : ` Current case: Reynolds number (Re) ${Math.round(re)}.`)
            );
        }
        if (/\balpha\b|\bangle of attack\b|\baoa\b/.test(lower)) {
            const alpha = ctx === null ? null : finiteOrNull(ctx.alphaDeg);
            parts.push(
                "angle of attack (alpha) is in degrees, nose up positive. More angle means more lift until stall." +
                (alpha === null ? "" : ` Current case: angle of attack (alpha) ${alpha.toFixed(1)} deg.`)
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
        const isDeclined = DECLINED_RE.test(lower);
        const bodyLabel = safe === null ? "current body" : cleanText(safe.bodyLabel, "current body");
        if (lower.trim().length === 0) {
            return { reply: buildGeneric(vctx.agentFirst === true), actions: [], rejections: [] };
        }
        // Sweep phrasings never narrate here: the console runs the live
        // analytic staircase before any offline branch, so a sweep summary
        // without a run cannot be served from this path.
        if (CANNOT_3D_RE.test(lower)) {
            return {
                reply: "Cannot do 3D: the tunnel is 2D only (chord normalized, y-up). Set up a 2D section instead, a rectangular section narrows the passage like a venturi and speeds the flow. Canvas unchanged.",
                actions: [],
                rejections: [],
            };
        }
        if (CANNOT_COMPRESSIBLE_RE.test(lower)) {
            return {
                reply: "Cannot do compressible or supersonic flow: the solver is incompressible analytic plus low speed LBM. Stay subsonic and set an Re in [100, 1000000] instead. Canvas unchanged.",
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
            if (vctx.agentFirst === true) {
                return {
                    reply: "Cannot show viscous separation on the analytic path: the potential model omits separation and stall. Agent-first mode serves the analytic estimate only. Canvas unchanged.",
                    actions: [],
                    rejections: [],
                };
            }
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
        // Declined pressure talk never stages: the preset branch below is
        // negation gated and the Cp field stage is suppressed here, so the
        // turn falls through to teaching with zero actions.
        if (HIGH_PRESSURE_PHENOM_RE.test(lower) && PRESSURE_NEGATION_RE.test(lower)) {
            suppressFieldStage = true;
        }
        // NACA plus alpha plus Re come from the shared airfoil intent parser
        // so offline setup agrees with the tested corpus. The live section
        // code in the context snapshot grounds relative edits, the body
        // label is the fallback for older snapshots. Non NACA bodies
        // (cylinder, block, orifice) still resolve from the body tokens.
        // Hoisted above the airfoil word branch so relative words without
        // explicit digits (thicker, more camber) ground on the live custom
        // code instead of resetting to the canonical default.
        const sectionCode = (() => {
            try {
                const snap = safe?.spec?.naca?.code;
                if (typeof snap === "string" && /\d{4}/.test(snap)) return snap;
            } catch {
                // Fall through to the body label below.
            }
            return safe === null ? null : cleanText(safe.bodyLabel, "current body");
        })();
        // Explicit field requests suppress the fresh case speed default so
        // the canvas never overrides a requested cp or omega view.
        const explicitFieldHere = findField(lower);
        const stageSpeedDefault = (): void => {
            if (explicitFieldHere !== null) return;
            accept({ kind: "set_field", field: "speed" });
        };
        if (!isDeclined && SHEDDING_RE.test(lower)) {
            presetHandled = true;
            const staged = accept({ kind: "setup_shedding" });
            sections.push(
                staged
                    ? "Local setup note, no network. Applying the vortex shedding case (cylinder, alpha 0, Re 100, speed field). Canvas updates on apply."
                    : `Local setup note, no network. Staying on ${bodyLabel}; the shedding case is outside the serving envelope. Canvas unchanged.`
            );
        } else if (!isDeclined && HIGH_PRESSURE_PHENOM_RE.test(lower) && !PRESSURE_NEGATION_RE.test(lower)) {
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
        } else if (!isDeclined && AIRFOIL_WORD_RE.test(lower)) {
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
                    `Reply with a valid 4-digit code. Canvas unchanged.`
                );
            } else if (parsed.status === "none") {
                // Relative reshapes without explicit digits (thicker,
                // thinner, more or less camber) ground on the live custom
                // code from the context spec, never the canonical default.
                const relative = parseAirfoilIntent(raw, { code: sectionCode });
                if (relative !== null && relative.kind === "apply" && relative.code !== null) {
                    const check = isSchemaValidCode(relative.code);
                    if (check.ok) {
                        const ctxAlpha = finiteOrNull(safe?.alphaDeg);
                        const ctxRe = finiteOrNull(safe?.reynolds);
                        const rawAlpha = relative.alphaDeg ?? parseAlphaDeg(raw) ?? ctxAlpha ?? 6;
                        const clampedAlpha = Math.min(Math.max(rawAlpha, ALPHA_HARD_MIN), ALPHA_HARD_MAX);
                        const rawRe = relative.reynolds === null
                            ? (ctxRe === null ? 50000 : Math.round(ctxRe))
                            : Math.round(relative.reynolds);
                        const clampedRe = Math.min(Math.max(rawRe, RE_MIN), RE_MAX);
                        const staged = accept(anyAirfoilSpec(check.code, check.m, check.p, check.t, clampedAlpha, clampedRe));
                        if (staged) stageSpeedDefault();
                        if (staged) {
                            sections.push(
                                `Local setup note, no network. Applying body naca${check.code} (NACA ${check.code}, alpha ${clampedAlpha}, Re ${clampedRe}, speed field). Canvas updates on apply.` +
                                (relative.notes.length > 0 ? ` ${relative.notes.join(" ")}` : "")
                            );
                        } else {
                            sections.push(
                                `Local setup note, no network. Staying on ${bodyLabel}; NACA ${check.code} with alpha ${clampedAlpha} and Re ${clampedRe} is outside the serving envelope. Canvas unchanged.`
                            );
                        }
                    } else {
                        sections.push(
                            `Local setup note, no network. Staying on ${bodyLabel}; that reshape falls outside the 4-digit family. Canvas unchanged.`
                        );
                    }
                } else {
                    const candidate: AgentAction = { kind: "setup_airfoil" };
                    if (alphaHere !== null) (candidate as { alphaDeg?: number }).alphaDeg = alphaHere;
                    const staged = accept(candidate);
                    if (staged) stageSpeedDefault();
                    if (staged) {
                        sections.push("Local setup note, no network. Applying the airfoil case (NACA, speed field). Canvas updates on apply.");
                    } else {
                        sections.push(
                            `Local setup note, no network. Staying on ${bodyLabel}; the airfoil case is outside the serving envelope. Canvas unchanged.`
                        );
                    }
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
                        `Reply with a valid 4-digit code. Canvas unchanged.`
                    );
                } else if (CANONICAL_NACA.has(`naca${check.code}`)) {
                    const candidate: AgentAction = { kind: "setup_airfoil" };
                    (candidate as { body?: BodyToken }).body = `naca${check.code}` as BodyToken;
                    if (alphaHere !== null) (candidate as { alphaDeg?: number }).alphaDeg = alphaHere;
                    const staged = accept(candidate);
                    if (staged) stageSpeedDefault();
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
                    if (staged) stageSpeedDefault();
                    if (staged) {
                        const tutor = parsed.note ?? check.note;
                        sections.push(
                            `Local setup note, no network. Applying body naca${check.code} (NACA ${check.code}, alpha ${alpha}, Re ${reynolds}, speed field). Canvas updates on apply.` +
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
        // Constriction language rides the orifice body: tunnel, venturi,
        // throat, or constriction names the narrowed passage, staged with
        // the live orifice gap and width defaults behind set_body orifice.
        // Verb gated like other bare mentions, so questions and plain
        // mentions leave the canvas alone.
        let orificeViaTrigger = false;
        if (bodyTok === null && !presetHandled && ORIFICE_TRIGGER_RE.test(lower) && VERB_GATE_RE.test(lower)) {
            try {
                if (parseNacaLoose(raw).status !== "ambiguous") {
                    bodyTok = "orifice";
                    orificeViaTrigger = true;
                }
            } catch {
                // Parse faults leave the orifice trigger unstaged.
            }
        }
        if (bodyTok === null && intentCode !== null && CANONICAL_NACA.has(`naca${intentCode}`)) {
            bodyTok = `naca${intentCode}`;
        }
        // R1 verb gating for pure mentions: a named body with no parsed
        // action (no code, alpha, Re, or reshape) only stages when the text
        // carries an action verb, so questions and mentions ("what is NACA
        // 2412") leave the canvas alone. Embedded definitional clauses
        // ("show me what a cylinder is") never stage even with a verb.
        // Parsed intents bypass the gate.
        if (bodyTok !== null && applyIntent === null && intentCode === null && !VERB_GATE_RE.test(lower)) {
            bodyTok = null;
        }
        if (bodyTok !== null && applyIntent === null && DEFINITIONAL_CLAUSE_RE.test(lower)) {
            bodyTok = null;
            orificeViaTrigger = false;
        }
        const unknownNacaRaw = presetHandled ? null : unknownNacaHere(intentCode, bodyTok);
        const unknownNaca = unknownNacaRaw !== null && applyIntent === null && DEFINITIONAL_CLAUSE_RE.test(lower) ? null : unknownNacaRaw;
        const alphaVal = presetHandled ? null : (applyIntent?.alphaDeg ?? null);
        const reVal = presetHandled ? null : (applyIntent?.reynolds ?? null);
        const tutorNote = applyIntent !== null && applyIntent.notes.length > 0 ? applyIntent.notes.join(" ") : null;
        const typoNotes = applyIntent !== null && applyIntent.corrections.length > 0 ? applyIntent.corrections.join("; ") : null;
        const hasSetupValues = !clarified && !isDeclined && (bodyTok !== null || unknownNaca !== null || alphaVal !== null || reVal !== null);
        if (hasSetupValues) {
            const applied: string[] = [];
            const notices: string[] = [];
            let carriedBySpec = false;
            if (bodyTok !== null) {
                if (accept({ kind: "set_body", body: bodyTok as BodyToken })) {
                    const displayTok = bodyTok === "block" ? "Rectangle" : bodyTok;
                    applied.push(`body ${displayTok}`);
                    if (orificeViaTrigger) {
                        notices.push("Note: a narrower gap speeds the flow like a venturi.");
                    }
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
                        if (explicitFieldHere === null) accept({ kind: "set_field", field: "speed" });
                    }
                } else {
                    rejections.push(
                        `naca ${unknownNaca} is not a console body, staying on ${bodyLabel}; a rectangular section narrows the passage like a venturi and an airfoil adds lift with camber`
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
                const speedStaged = carriedBySpec && actions.some((a) => a.kind === "set_field" && a.field === "speed");
                sections.push(`Local setup note, no network. Applying ${applied.join(", ")}${speedStaged ? " with the speed field" : ""}.`);
            } else {
                sections.push(
                    `Local setup note, no network. Staying on ${bodyLabel}; tell me which body shape, angle, and Re to use, ` +
                    `a rectangular section narrows the passage like a venturi and a thicker airfoil deepens suction.`
                );
            }
            // Parser Note tails fold into the same single sentence with
            // semicolons, so settled setup replies never render two
            // sentences. Applied values above already carry the clamped
            // alphaVal and live Re.
            if (applied.length > 0) {
                const tails: string[] = [];
                for (const n of notices) tails.push(n.replace(/^Note:\s*/i, "").replace(/\.+$/, ""));
                if (tutorNote !== null) tails.push(tutorNote.replace(/\.+$/, ""));
                if (typoNotes !== null) tails.push(`note: ${typoNotes.replace(/\.+$/, "")}`);
                if (tails.length > 0) {
                    const last = sections.pop() ?? "";
                    const head = last.replace(/\.+$/, "");
                    sections.push(`${head} (${tails.join("; ")}).`);
                }
            } else {
                if (notices.length > 0) sections.push(notices.join(" "));
                if (tutorNote !== null) sections.push(tutorNote);
                if (typoNotes !== null) sections.push(`Note: ${typoNotes}.`);
            }
            if (bodyTok === null && !carriedBySpec && applied.length > 0) {
                sections.push(
                    `Staying on ${bodyLabel} with ${applied.join(", ")}.`
                );
            }
        } else if (HELP_RE.test(lower)) {
            if (presetHandled || clarified) {
                // Phenomenon preset or clarify question already staged above,
                // help copy would contradict it, so keep the staged line only.
            } else {
                return { reply: buildHelp(vctx.agentFirst === true), actions: [], rejections: [] };
            }
        } else if (SETUP_WORD_RE.test(lower)) {
            if (!presetHandled && !clarified) {
                sections.push(
                    `Local setup note, no network. Staying on ${bodyLabel}; tell me which body shape, angle, and Re to use, ` +
                    `a rectangular section narrows the passage like a venturi and a thicker airfoil deepens suction.`
                );
            }
        }
        const engineMatch = lower.match(ENGINE_RE);
        if (!isDeclined && engineMatch !== null && ENGINE_VERB_RE.test(lower)) {
            const token = engineMatch[1];
            const staged = accept({ kind: "set_engine", engine: token as AgentAction extends { kind: "set_engine"; engine: infer E } ? E : never });
            sections.push(
                staged
                    ? `Local engine note, no network. Switching engine to ${token}. Canvas updates on apply.`
                    : `Local engine note, no network. Engine ${token} is not a console engine, staying on ${bodyLabel}; engines are [analytic, lbm]. Canvas unchanged.`
            );
        }
        const fieldName = findField(lower);
        if (!isDeclined && !suppressFieldStage && fieldName !== null && (FIELD_TRIGGER_RE.test(lower) || lower.includes(`field ${fieldName}`))) {
            accept({
                kind: "set_field",
                field: fieldName as AgentAction extends { kind: "set_field"; field: infer F } ? F : never,
            });
            const wasAccepted = actions.some((a) => a.kind === "set_field");
            const gatedCopy = vctx.agentFirst === true && (fieldName === "k" || fieldName === "recirc")
                ? `Local field note, no network. Field ${fieldName} is unavailable in agent-first analytic mode, the analytic frame carries no ${fieldName === "k" ? "TKE" : "recirculation"} channel. Canvas unchanged.`
                : `Local field note, no network. Field ${fieldName} stays gated until the first LBM statistics sample. Canvas unchanged.`;
            sections.push(
                wasAccepted
                    ? `Local field note, no network. Switching field to ${fieldName}. Canvas updates on apply.`
                    : gatedCopy
            );
        }
        const runKind = detectRun(lower);
        if (!isDeclined && runKind !== null) {
            accept(runKind === "run_lbm" ? { kind: "run_lbm" } : { kind: "cancel_lbm" });
            const staged = actions.some((a) => a.kind === "run_lbm" || a.kind === "cancel_lbm");
            const gatedRunCopy = vctx.agentFirst === true
                ? "Local run note, no network. Run is unavailable in agent-first analytic mode, the analytic frame is served instead. Canvas unchanged."
                : "Local run note, no network. Run stays gated until the LBM engine is live. Canvas unchanged.";
            sections.push(
                staged
                    ? runKind === "run_lbm"
                        ? "Local run note, no network. Run staged: confirm with the Run LBM chip to start the viscous solve. Canvas unchanged until confirm."
                        : "Local run note, no network. Cancel staged: confirm with the Cancel LBM chip. Nothing runs until confirm."
                    : gatedRunCopy
            );
        }
        if (sections.length === 0) {
            return { reply: buildGeneric(vctx.agentFirst === true), actions, rejections };
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
        return { reply: buildGeneric(false), actions: [], rejections: [] };
    }
}
