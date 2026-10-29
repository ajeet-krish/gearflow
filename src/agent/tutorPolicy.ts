// Phase T1 tutor policy. Pure concept detection plus field mapping plus
// the offline tutor template, no React, no DOM, no network. Concepts stay
// tutor first and agent applied: each concept maps to one suggested field
// the agent may apply through a single set_field. Never throws.

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

/** Suggested field pair for one concept. Secondary null means the reply
 *  needs no second view. Fresh attached and general default to the speed
 *  view with the cp chip as secondary, so the canvas lands on velocity
 *  plus streamlines; omega stays primary only for stall, shedding, and
 *  turbulence concepts. */
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
 * Karman shedding on a finite Strouhal, then turbulent wake on regime or
 * recirculation or TKE, then stagnation on regime or bluff bodies, then
 * suction peak on a deep CpMin, then attached lift, else general.
 * Never throws.
 */
export function detectConcept(input: DetectConceptInput | null | undefined): TutorConcept {
    try {
        const raw = (input ?? {}) as DetectConceptInput;
        const regime = lowerText(raw.regime);
        const body = lowerText(raw.bodyLabel);
        const alpha = finiteOrNull(raw.alphaDeg);
        const strouhal = finiteOrNull(raw.strouhal);
        const recirc = finiteOrNull(raw.recircFraction);
        const tke = finiteOrNull(raw.tkePeak);
        const cpMin = finiteOrNull(raw.cpMin);
        if (regime.includes("stall") || regime.includes("separat")) return "stall-separation";
        if (alpha !== null && alpha >= 12) return "stall-separation";
        if (regime.includes("shed") || regime.includes("karman") || regime.includes("vortex street")) return "karman-shedding";
        if (strouhal !== null) return "karman-shedding";
        if (regime.includes("turbul") || regime.includes("wake")) return "turbulent-wake";
        if (recirc !== null && recirc > 0.15) return "turbulent-wake";
        if (tke !== null && tke > 0) return "turbulent-wake";
        if (regime.includes("stagnat") || regime.includes("high pressure")) return "stagnation";
        if (body.includes("block") || body.includes("orifice")) return "stagnation";
        if (regime.includes("suction")) return "suction-peak";
        if (cpMin !== null && cpMin <= -2) return "suction-peak";
        if (regime.includes("attach") || regime.includes("lift")) return "attached-lift";
        return "general";
    } catch {
        return "general";
    }
}

/**
 * Field pair for one concept. Stall favors omega with cp second, shedding
 * favors omega with speed second, suction favors cp with speed second,
 * turbulence favors k when ready else recirc when ready else omega with
 * speed second, stagnation favors cp with speed second, attached and
 * general suggest speed with the cp chip second (keeping speed when the
 * current field already shows velocity). Never throws.
 */
export function fieldForConcept(
    concept: TutorConcept,
    opts?: { current?: unknown; tkeReady?: unknown; recircReady?: unknown },
): TutorFieldSuggestion {
    try {
        const current = cleanCurrent(opts?.current);
        const tkeReady = opts?.tkeReady === true;
        const recircReady = opts?.recircReady === true;
        if (concept === "stall-separation") return { primary: "omega", secondary: "cp" };
        if (concept === "karman-shedding") return { primary: "omega", secondary: "speed" };
        if (concept === "suction-peak") return { primary: "cp", secondary: "speed" };
        if (concept === "turbulent-wake") {
            if (tkeReady) return { primary: "k", secondary: "omega" };
            if (recircReady) return { primary: "recirc", secondary: "omega" };
            return { primary: "omega", secondary: "speed" };
        }
        if (concept === "stagnation") return { primary: "cp", secondary: "speed" };
        // Fresh attached lift and general frames land on velocity plus
        // streamlines: keep speed when already there, otherwise suggest
        // speed (never omega) with the cp chip second.
        void current;
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
    const st = cellOf(rows, "Strouhal");
    if (concept === "attached-lift") {
        return `The wing stays attached, meaning flow follows the surface, with Cl ${cl} at alpha ${alpha}.`;
    }
    if (concept === "suction-peak") {
        return `Suction, meaning low pressure pulling on the upper surface, peaks at CpMin ${cp}, which sets the lift you see in Cl ${cl}.`;
    }
    if (concept === "stall-separation") {
        return `Separation, meaning flow leaving the surface, stalls lift past this alpha, with Cl ${cl} at alpha ${alpha}.`;
    }
    if (concept === "karman-shedding") {
        return `Vorticity, meaning spinning motion in the wake, sheds in turns at St ${st}, which shakes Cl around ${cl}.`;
    }
    if (concept === "turbulent-wake") {
        return `The wake stays turbulent, meaning fast mixing behind the body, with Cl ${cl} and St ${st}.`;
    }
    if (concept === "stagnation") {
        return `Stagnation, meaning flow stopped at the nose, shows as high pressure with Cl ${cl} at alpha ${alpha}.`;
    }
    return `The run reads Cl ${cl} with CpMin ${cp} at alpha ${alpha} and Re ${re}.`;
}

function experimentFor(concept: TutorConcept): string {
    if (concept === "attached-lift") return "Raise alpha by 1 deg and watch Cl and CpMin.";
    if (concept === "suction-peak") return "Raise alpha by 1 deg and watch the suction peak on the cp view.";
    if (concept === "stall-separation") return "Press Run for the viscous LBM solve to see the separated wake, then compare omega.";
    if (concept === "karman-shedding") return "Switch to the omega view and watch the alternating street.";
    if (concept === "turbulent-wake") return "Press Run for the viscous solve, then check recirculation and TKE.";
    if (concept === "stagnation") return "Check the cp view at the nose for the high pressure zone.";
    return "Nudge alpha by 1 deg and compare Cl.";
}

function caveatFor(pathLabel: string): string {
    const family = tutorSourceFamily(pathLabel);
    if (family === "lbm") return "Caveat: LBM solved, instantaneous snapshot (viscous D2Q9, not time averaged).";
    if (family === "neural") return "Caveat: predicted, not validated.";
    if (family === "analytic") return "Caveat: potential flow estimate, not validated.";
    return "Caveat: pending, press Run for a clean solve.";
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
 * Offline tutor reply with the same shape as the live tutor answer:
 * one explanation, the before vs after table, one Try next experiment,
 * the suggested view, and one honesty caveat. Cites only table cells,
 * never invents numbers. Attached and general frames suggest the speed
 * view; omega stays suggested only for stall, shedding, and turbulence.
 * Never throws.
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
        const caveat = caveatFor(typeof focus?.pathLabel === "string" ? focus.pathLabel : "");
        const currentField = fieldFromCaseKey(typeof focus?.caseKey === "string" ? focus.caseKey : "");
        const suggestion = fieldForConcept(concept, { current: currentField });
        const secondary = suggestion.secondary ?? "none";
        return (
            `Local tutor note, local only. ${explanation}\n\n` +
            `Before vs after\n${tutorRowsText(rows)}\n\n` +
            `Try next: ${experiment}\n\n` +
            `Suggested view: ${suggestion.primary} (secondary: ${secondary}).\n\n` +
            caveat
        );
    } catch {
        return "Local tutor note, local only. The run is pending, press Run for a clean solve.\n\nCaveat: pending, press Run for a clean solve.";
    }
}
