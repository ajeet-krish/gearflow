// Conversational case presets. Pure and testable, no DOM or network
// access. Each preset expands atomically into primitive agent actions:
// validation runs first, and any invalid input returns ok false with an
// empty action list plus the honest reason, never a partial list. The
// domain note quotes the provisional neural envelope verdict so the agent
// can say which path will serve the case.
//
// Trusted application contract: the setup_* agent actions (setup_shedding,
// setup_high_pressure, setup_airfoil) carry their own validated Re and
// bypass the per-action envelope Re floor (shedding uses Re 100, below the
// envelope validator floor of 1000). validateAgentAction accepts those
// setup_* kinds on this preset path. The App executor must expand them via
// expandCasePreset and apply the returned primitives directly through the
// App executor (applyAgentAction primitives or applyParametric), never by
// re-validating each primitive through the per-action envelope validator.

import type { AgentAction, BodyToken, FieldMode } from "@/contracts/types";
import { ALPHA_HARD_MAX, ALPHA_HARD_MIN } from "@/contracts/schema";
import { classifyNeuralDomain } from "@/flow/neuralDomain";

/** Preset the agent can expand. */
export type CasePresetId = "shedding" | "high_pressure" | "airfoil";

/** Preset expansion request. Body and alpha are only read where defined. */
export interface CasePresetRequest {
    preset: CasePresetId;
    body?: string;
    alphaDeg?: number;
}

/** Atomic expansion outcome. Actions is empty unless ok is true. */
export interface CasePresetResult {
    ok: boolean;
    actions: AgentAction[];
    /** Null on success, otherwise the honest rejection reason. */
    reason: string | null;
    /** Provisional envelope verdict for the expanded case, null when clean. */
    domainNote: string | null;
}

const AIRFOIL_BODIES: ReadonlyArray<string> = ["naca0012", "naca2412", "naca4412"];
const HIGH_PRESSURE_BODIES: ReadonlyArray<string> = ["orifice", "block"];

function fail(reason: string): CasePresetResult {
    return { ok: false, actions: [], reason, domainNote: null };
}

function succeed(actions: AgentAction[], body: string, alphaDeg: number, reynolds: number): CasePresetResult {
    const verdict = classifyNeuralDomain(body, alphaDeg, reynolds);
    return {
        ok: true,
        actions,
        reason: null,
        domainNote: verdict.inDomain ? null : verdict.reason,
    };
}

function checkAlpha(alphaDeg: number, preset: CasePresetId): string | null {
    if (typeof alphaDeg !== "number" || !Number.isFinite(alphaDeg)) {
        return `${preset} preset needs a finite alphaDeg`;
    }
    if (alphaDeg < ALPHA_HARD_MIN || alphaDeg > ALPHA_HARD_MAX) {
        return `${preset} preset alphaDeg ${alphaDeg} outside [${ALPHA_HARD_MIN}, ${ALPHA_HARD_MAX}]`;
    }
    return null;
}

/**
 * Expand a case preset into primitive agent actions. Atomic: invalid input
 * yields ok false with no actions. shedding is a fixed cylinder at
 * alpha 0, Re 100, speed field. high_pressure is orifice by default (block
 * when requested) at alpha 0, Re 1000, cp field. airfoil is the named NACA
 * body or 2412 at the given alpha or 6 deg, Re 50000, speed field.
 */
export function expandCasePreset(request: CasePresetRequest): CasePresetResult {
    if (request === null || typeof request !== "object") {
        return fail("case preset needs a request object");
    }
    const { preset, body, alphaDeg } = request;
    if (preset === "shedding") {
        const actions: AgentAction[] = [
            { kind: "set_body", body: "cylinder" },
            { kind: "set_alpha", alphaDeg: 0 },
            { kind: "set_reynolds", reynolds: 100 },
            { kind: "set_field", field: "speed" as FieldMode },
        ];
        return succeed(actions, "cylinder", 0, 100);
    }
    if (preset === "high_pressure") {
        const resolved = body === undefined ? "orifice" : body;
        if (!HIGH_PRESSURE_BODIES.includes(resolved)) {
            return fail(`high_pressure preset needs body in [${HIGH_PRESSURE_BODIES.join(", ")}], got ${String(body)}`);
        }
        const actions: AgentAction[] = [
            { kind: "set_body", body: resolved as BodyToken },
            { kind: "set_alpha", alphaDeg: 0 },
            { kind: "set_reynolds", reynolds: 1000 },
            { kind: "set_field", field: "cp" as FieldMode },
        ];
        return succeed(actions, resolved, 0, 1000);
    }
    if (preset === "airfoil") {
        const resolved = body === undefined ? "naca2412" : body;
        if (!AIRFOIL_BODIES.includes(resolved)) {
            return fail(`airfoil preset needs body in [${AIRFOIL_BODIES.join(", ")}], got ${String(body)}`);
        }
        const alpha = alphaDeg === undefined ? 6 : alphaDeg;
        const alphaProblem = checkAlpha(alpha, "airfoil");
        if (alphaProblem !== null) return fail(alphaProblem);
        const actions: AgentAction[] = [
            { kind: "set_body", body: resolved as BodyToken },
            { kind: "set_alpha", alphaDeg: alpha },
            { kind: "set_reynolds", reynolds: 50000 },
            { kind: "set_field", field: "speed" as FieldMode },
        ];
        return succeed(actions, resolved, alpha, 50000);
    }
    return fail(`unknown case preset ${String((request as { preset?: unknown }).preset)}`);
}
