// P4 teaching layer: pure misconception detector table. Claim to
// correction flow with one analytic-only experiment each. No React, no
// DOM, no network. Experiment actions use only existing validateAgentAction
// kinds (set_field, set_alpha, set_reynolds, setup presets), never run_lbm
// or cancel_lbm, so every experiment validates offline. Never throws.

import type { AgentAction } from "@/contracts/types";

/** One claim to correction flow. The experiment rides one existing agent
 *  action kind so the console can stage it through validateAgentAction. */
export interface MisconceptionFlow {
    id: string;
    claim: string;
    whyTempting: string;
    whatModelShows: string;
    experimentText: string;
    experimentAction: AgentAction;
}

/** Detector entry: trigger plus the flow it corrects. Triggers stay on
 *  plain word patterns, never on model output. */
interface MisconceptionEntry {
    flow: MisconceptionFlow;
    triggers: RegExp[];
}

function flowStallPotential(): MisconceptionFlow {
    return {
        id: "stall-potential",
        claim: "Stall and separation are shown by the potential model.",
        whyTempting: "The analytic canvas draws attached streamlines at every angle, so it is tempting to read a separated bubble or a stall dip from it.",
        whatModelShows: "The potential flow picture omits separation and stall. Lift coefficient (Cl) stays linear in the characterized band, the wake stays attached, and flattening past the band is not shown on this picture.",
        experimentText: "First set angle of attack (alpha) to 7 deg and compare lift coefficient (Cl). The potential flow picture omits separation and stall, so flattening past the band is not shown.",
        experimentAction: { kind: "set_alpha", alphaDeg: 7 },
    };
}

function flowReNoEffect(): MisconceptionFlow {
    return {
        id: "re-no-effect",
        claim: "Reynolds number does nothing on this tunnel.",
        whyTempting: "Lift coefficient (Cl) moves little with Reynolds number (Re) on this picture, so Re looks inert at first glance.",
        whatModelShows: "Reynolds number (Re) sets the wake and the suction peak. A higher Re thins the boundary layer, deepens minimum pressure coefficient, and shifts the wake regime even while lift coefficient (Cl) moves only a little.",
        experimentText: "First set Reynolds number (Re) to 200000 and compare minimum pressure coefficient. The suction peak and the wake move with Reynolds number (Re).",
        experimentAction: { kind: "set_reynolds", reynolds: 200000 },
    };
}

function flowClForever(): MisconceptionFlow {
    return {
        id: "cl-forever",
        claim: "Lift coefficient (Cl) keeps rising forever as angle of attack (alpha) increases.",
        whyTempting: "The lift curve looks straight inside the band, so it is tempting to extend that line past every angle.",
        whatModelShows: "The sweep shows a linear band inside the characterized [-4, 12] deg range only. Past that limit the estimate leaves the band and stall is not shown here.",
        experimentText: "First set angle of attack (alpha) to 12 deg and note the linear band plus the characterized limit. Past 12 deg the estimate is outside the band, not a higher lift promise.",
        experimentAction: { kind: "set_alpha", alphaDeg: 12 },
    };
}

function flowCpMinMeasured(): MisconceptionFlow {
    return {
        id: "cpmin-measured",
        claim: "Minimum pressure coefficient is a measured pressure in pascals.",
        whyTempting: "Minimum pressure coefficient reads like a pressure tap value, one number at one point.",
        whatModelShows: "Pressure coefficient (Cp) is local pressure minus freestream over dynamic pressure. Negative means suction, and minimum pressure coefficient is the lowest value, the strongest suction peak, not a pascal reading.",
        experimentText: "First raise angle of attack (alpha) to 7 deg (a 1 deg nudge) and watch the suction peak deepen as minimum pressure coefficient falls. The shape tells the lift story.",
        experimentAction: { kind: "set_alpha", alphaDeg: 7 },
    };
}

const ENTRIES: ReadonlyArray<MisconceptionEntry> = [
    {
        flow: flowStallPotential(),
        triggers: [
            /stall.*(potential|analytic)/,
            /potential.*stall/,
            /(separation|separated).*(potential|analytic)/,
            /potential.*(separation|separated)/,
        ],
    },
    {
        flow: flowReNoEffect(),
        triggers: [
            /re\s*(does\s*(nothing|n.?t\s*matter)|has\s*no\s*effect|no\s*effect|irrelevant|doesn.?t\s*affect)/,
            /reynolds.*(does\s*(nothing|n.?t\s*matter)|has\s*no\s*effect|no\s*effect|irrelevant)/,
            /re\s*does\s*nothing/,
        ],
    },
    {
        flow: flowClForever(),
        triggers: [
            /cl\s*(rises|increases|keeps\s*(rising|increasing)).*(forever|always|without\s*limit|indefinitely)/,
            /(lift|cl)\s*(forever|always\s*increases|keeps\s*rising)/,
            /more\s*alpha\s*(always|forever).*more\s*lift/,
            /cl\s*rises\s*forever/,
        ],
    },
    {
        // Measured claim only: the what is trigger requires a measurement
        // token so plain definition questions fall through to the glossary.
        flow: flowCpMinMeasured(),
        triggers: [
            /cpmin.*(measured|measurement|pascal|sensor|tap|physical)/,
            /cp\s*(is\s*)?(measured|in\s*pascal|physical\s*pressure)/,
            /what\s*is\s*cpmin.*(measured|measurement|reading|pascal|sensor|tap|physical)/,
            /cpmin\s*pressure\s*reading/,
        ],
    },
];

/**
 * Detect one misconception flow from free text. First matching entry wins,
 * order matches the table above. Pure, never throws: non string input or
 * any fault returns null. The optional context is accepted for future
 * grounding and ignored today.
 */
export function detectMisconception(text: unknown, _ctx?: unknown): MisconceptionFlow | null {
    try {
        void _ctx;
        if (typeof text !== "string") return null;
        const lower = text.toLowerCase();
        if (lower.trim().length === 0) return null;
        for (const entry of ENTRIES) {
            for (const trigger of entry.triggers) {
                try {
                    if (trigger.test(lower)) return entry.flow;
                } catch {
                    continue;
                }
            }
        }
        return null;
    } catch {
        return null;
    }
}

/** Every flow in the table, for tests and docs. Never throws. */
export function misconceptionFlows(): MisconceptionFlow[] {
    try {
        return [flowStallPotential(), flowReNoEffect(), flowClForever(), flowCpMinMeasured()];
    } catch {
        return [];
    }
}
