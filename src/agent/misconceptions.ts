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
        whyTempting: "The analytic canvas draws attached streamlines at every alpha, so it is tempting to read a separated bubble or a stall dip from it.",
        whatModelShows: "The potential model omits separation and stall. Cl stays linear in the characterized band, the wake stays attached, and flattening past the band is not shown on this path.",
        experimentText: "Switch to the omega view first, then run the alpha sweep from -4 to 12 deg in 2 deg steps and watch Cl stay linear. Flattening past the band is not shown, the model has no separation to solve.",
        experimentAction: { kind: "set_field", field: "omega" },
    };
}

function flowReNoEffect(): MisconceptionFlow {
    return {
        id: "re-no-effect",
        claim: "Reynolds number does nothing on this tunnel.",
        whyTempting: "Cl moves little with Re on the analytic path, so Re looks inert at first glance.",
        whatModelShows: "Re sets the wake and the suction peak. A higher Re thins the boundary layer, deepens CpMin, and shifts the wake regime even while Cl moves only a little.",
        experimentText: "Set Re to 200000 first, then compare the cp view at 20000 versus 200000 plus CpMin. The suction peak and the wake move with Re.",
        experimentAction: { kind: "set_reynolds", reynolds: 200000 },
    };
}

function flowClForever(): MisconceptionFlow {
    return {
        id: "cl-forever",
        claim: "Cl keeps rising forever as alpha increases.",
        whyTempting: "The analytic Cl curve looks straight inside the band, so it is tempting to extend that line past every alpha.",
        whatModelShows: "The sweep shows a linear band inside the characterized [-4, 12] deg envelope only. Past that limit the analytic estimate leaves the validated band and stall is not solved here.",
        experimentText: "Set alpha to 12 deg first, then run the alpha sweep -4 to 12 deg and note the linear band plus the characterized limit. Past 12 deg the estimate is outside the band, not a higher lift promise.",
        experimentAction: { kind: "set_alpha", alphaDeg: 12 },
    };
}

function flowCpMinMeasured(): MisconceptionFlow {
    return {
        id: "cpmin-measured",
        claim: "CpMin is a measured pressure in pascals.",
        whyTempting: "CpMin reads like a pressure tap value, one number at one point.",
        whatModelShows: "Cp is a coefficient, local pressure minus freestream over dynamic pressure. Negative means suction, and CpMin is the lowest value, the strongest suction peak, not a pascal reading.",
        experimentText: "Switch to the cp view first, then raise alpha by 1 deg from the slider. Watch the suction peak deepen as CpMin falls, the shape tells the lift story.",
        experimentAction: { kind: "set_field", field: "cp" },
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
