// Phase T1 tutor policy. Pure concept detection plus the offline tutor
// template, no React, no DOM, no network. Concepts stay tutor first and
// agent applied. Physics-only copy: no solver or tech stack talk, no
// field suggestions, no vorticity or omega copy. Try next is an angle of
// attack nudge or a Reynolds number thought experiment. Never throws.

import type { FieldMode } from "@/contracts/types";
import { buildTutorTable, tutorRowsText, tutorSourceFamily, type TutorSnapshotLite, type TutorTableRow } from "./tutorTable";

/** Flow ideas the tutor teaches, one per reply. */
export type TutorConcept =
    | "attached-lift"
    | "suction-peak"
    | "stall-separation"
    | "karman-shedding"
    | "turbulent-wake"
    | "stagnation"
    | "general";

/** Minimal evidence the concept detector reads. All fields optional so
 *  both the live context and the lite snapshots can feed it. */
export interface DetectConceptInput {
    alphaDeg?: unknown;
    regime?: unknown;
    bodyLabel?: unknown;
    strouhal?: unknown;
    recircFraction?: unknown;
    tkePeak?: unknown;
    cpMin?: unknown;
}

/** Suggested field pair kept for backward compatible callers. Physics-only
 *  tutor never surfaces a field suggestion; every concept maps to the
 *  neutral speed plus cp pair so legacy imports keep compiling. */
export interface TutorFieldSuggestion {
    primary: FieldMode;
    secondary: FieldMode | null;
}

const FIELD_TOKENS: ReadonlyArray<FieldMode> = ["speed", "cp", "omega", "u", "v", "k", "recirc"];

function lowerText(v: unknown): string {
    return typeof v === "string" ? v.toLowerCase() : "";
}

function finiteOrNull(v: unknown): number | null {
    return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function cleanCurrent(v: unknown): FieldMode {
    if (typeof v === "string" && (FIELD_TOKENS as ReadonlyArray<string>).includes(v)) return v as FieldMode;
    return "speed";
}

/**
 * Detect the tutoring concept from live evidence. Order is fixed so one
 * frame maps to exactly one concept: stall and separation first, then
 * Karman shedding on regime words, then turbulent wake on regime or
 * recirculation or TKE, then stagnation on regime or bluff bodies, then
 * suction peak on a deep CpMin, then attached lift, else general.
 * Strouhal is ignored here so teaching never names solver statistics.
 * Never throws.
 */
export function detectConcept(input: DetectConceptInput | null | undefined): TutorConcept {
    try {
        const raw = (input ?? {}) as DetectConceptInput;
        const regime = lowerText(raw.regime);
        const body = lowerText(raw.bodyLabel);
        const alpha = finiteOrNull(raw.alphaDeg);
        void finiteOrNull(raw.strouhal);
        const recirc = finiteOrNull(raw.recircFraction);
        const tke = finiteOrNull(raw.tkePeak);
        const cpMin = finiteOrNull(raw.cpMin);
        if (regime.includes("stall") || regime.includes("separat")) return "stall-separation";
        if (alpha !== null && alpha >= 12) return "stall-separation";
        if (regime.includes("shed") || regime.includes("karman") || regime.includes("vortex street")) return "karman-shedding";
        if (regime.includes("turbul") || regime.includes("wake")) return "turbulent-wake";
        if (recirc !== null && recirc > 0.15) return "turbulent-wake";
        if (tke !== null && tke > 0) return "turbulent-wake";
        if (regime.includes("stagnat") || regime.includes("high pressure")) return "stagnation";
        if (body.includes("block") || body.includes("rectangle") || body.includes("rectangular") || body.includes("orifice")) return "stagnation";
        if (regime.includes("suction")) return "suction-peak";
        if (cpMin !== null && cpMin <= -2) return "suction-peak";
        if (regime.includes("attach") || regime.includes("lift")) return "attached-lift";
        return "general";
    } catch {
        return "general";
    }
}

/**
 * Neutral field pair kept for backward compatible callers. Physics-only
 * teaching never suggests or switches fields, so every concept returns
 * the same neutral pair and the live path ignores it. Never throws.
 */
export function fieldForConcept(
    concept: TutorConcept,
    opts?: { current?: unknown; tkeReady?: unknown; recircReady?: unknown },
): TutorFieldSuggestion {
    try {
        void concept;
        void cleanCurrent(opts?.current);
        void opts?.tkeReady;
        void opts?.recircReady;
        return { primary: "speed", secondary: "cp" };
    } catch {
        return { primary: "speed", secondary: "cp" };
    }
}

function cellOf(rows: TutorTableRow[], metric: string): string {
    const found = rows.find((row) => row.metric === metric);
    const cell = found?.after ?? "n/a";
    return cell === "n/a" ? "pending" : cell;
}

function explanationFor(concept: TutorConcept, rows: TutorTableRow[]): string {
    const cl = cellOf(rows, "Cl");
    const cp = cellOf(rows, "CpMin");
    const alpha = cellOf(rows, "Alpha");
    const re = cellOf(rows, "Re");
    if (concept === "attached-lift") {
        return `The wing stays attached, meaning flow follows the surface, with lift coefficient (Cl) ${cl} at angle of attack (alpha) ${alpha} and Reynolds number (Re) ${re}.`;
    }
    if (concept === "suction-peak") {
        return `Suction, meaning low pressure pulling on the upper surface, peaks at minimum pressure coefficient ${cp}, which sets the lift you see in lift coefficient (Cl) ${cl} at angle of attack (alpha) ${alpha}.`;
    }
    if (concept === "stall-separation") {
        return `Separation, meaning flow leaving the surface, stalls lift past this angle, with lift coefficient (Cl) ${cl} at angle of attack (alpha) ${alpha}. The potential flow picture omits separation and stall.`;
    }
    if (concept === "karman-shedding") {
        return `The wake swings side to side in turns, which shakes lift coefficient (Cl) around ${cl} at angle of attack (alpha) ${alpha} and Reynolds number (Re) ${re}.`;
    }
    if (concept === "turbulent-wake") {
        return `The wake stays mixed and unsteady behind the body, with lift coefficient (Cl) ${cl} at angle of attack (alpha) ${alpha} and Reynolds number (Re) ${re}.`;
    }
    if (concept === "stagnation") {
        return `Stagnation, meaning flow stopped at the nose, shows as high pressure with lift coefficient (Cl) ${cl} at angle of attack (alpha) ${alpha}.`;
    }
    return `The run reads lift coefficient (Cl) ${cl} with minimum pressure coefficient ${cp} at angle of attack (alpha) ${alpha} and Reynolds number (Re) ${re}.`;
}

/** One Try next thought experiment for a concept. Physics only, never a
 *  field switch and never a run: every branch names an angle of attack
 *  nudge or a Reynolds number thought experiment. Never throws. */
export function experimentFor(concept: TutorConcept): string {
    if (concept === "attached-lift") return "Nudge angle of attack (alpha) by 1 deg and compare lift coefficient (Cl) and minimum pressure coefficient.";
    if (concept === "suction-peak") return "Nudge angle of attack (alpha) by 1 deg and watch the suction peak deepen as minimum pressure coefficient falls.";
    if (concept === "stall-separation") return "Nudge angle of attack (alpha) by 1 deg and note the potential flow picture omits separation and stall, so past the band the lift reading is a proxy, not a separated wake.";
    if (concept === "karman-shedding") return "Nudge angle of attack (alpha) by 1 deg at the same Reynolds number (Re) and reason about how the wake rhythm shifts lift coefficient (Cl).";
    if (concept === "turbulent-wake") return "Reason about the same body at a higher Reynolds number (Re) and how stronger mixing behind the body shifts lift coefficient (Cl).";
    if (concept === "stagnation") return "Nudge angle of attack (alpha) by 1 deg and ask how the nose high pressure shifts with lift coefficient (Cl).";
    return "Nudge angle of attack (alpha) by 1 deg and compare lift coefficient (Cl).";
}

function physicsNoteFor(concept: TutorConcept): string {
    if (concept === "stall-separation") return "Note: the potential flow picture omits separation and stall.";
    return "";
}

function caveatFor(_pathLabel: string): string {
    void _pathLabel;
    return "";
}

function fieldFromCaseKey(caseKey: string): FieldMode {
    try {
        const m = caseKey.match(/\|f([a-z]+)/i);
        const token = m !== null ? m[1].toLowerCase() : "";
        if ((FIELD_TOKENS as ReadonlyArray<string>).includes(token)) return token as FieldMode;
        return "speed";
    } catch {
        return "speed";
    }
}

/**
 * Offline tutor reply with the same physics-only shape as the live tutor
 * answer: one explanation, the before vs after table, one Try next
 * thought experiment, plus the physics note only when the idea needs it.
 * Cites only table cells, never invents numbers, never suggests fields,
 * never names solvers. Never throws.
 */
export function localTutorReply(
    before: TutorSnapshotLite | null | undefined,
    after: TutorSnapshotLite | null | undefined,
): string {
    try {
        const rows = buildTutorTable(before, after);
        const focus = after ?? before;
        const concept = detectConcept({
            alphaDeg: focus?.alpha ?? null,
            regime: focus?.regime ?? "",
            bodyLabel: focus?.bodyLabel ?? "",
            strouhal: focus?.strouhal ?? null,
            cpMin: focus?.cpMin ?? null,
        });
        const explanation = explanationFor(concept, rows);
        const experiment = experimentFor(concept);
        const note = physicsNoteFor(concept);
        void caveatFor(typeof focus?.pathLabel === "string" ? focus.pathLabel : "");
        void fieldFromCaseKey(typeof focus?.caseKey === "string" ? focus.caseKey : "");
        void tutorSourceFamily(typeof focus?.pathLabel === "string" ? focus.pathLabel : "");
        const tail = note.length > 0 ? `\n\n${note}` : "";
        return (
            `Local tutor note, local only. ${explanation}\n\n` +
            `Before vs after\n${tutorRowsText(rows)}\n\n` +
            `Try next: ${experiment}${tail}`
        );
    } catch {
        return "Local tutor note, local only. The run is pending.\n\nTry next: Nudge angle of attack (alpha) by 1 deg and compare lift coefficient (Cl).";
    }
}
