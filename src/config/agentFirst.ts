// P1 agent-first backend flags. Single source for the agent-first
// analytic mode: the app serves the analytic frame only, never arms the
// LBM worker, never loads neural bundles, and never switches engines.
// Build-time env overrides (VITE_AGENT_FIRST defaults on, the rest
// default off). Every reader is pure and never throws, so a missing or
// malformed env falls back to the safe analytic default.

/** Backend capability flags for the agent-first slice. */
export interface AgentFirstFlags {
    /** Master switch: analytic only, no LBM worker, no neural loads. */
    agentFirst: boolean;
    /** LBM path allowed (reserved, forced off while agentFirst holds). */
    lbmEnabled: boolean;
    /** Surrogate path allowed (reserved, forced off while agentFirst holds). */
    surrogateEnabled: boolean;
    /** Engine switching allowed (reserved, forced off while agentFirst holds). */
    engineSwitchingEnabled: boolean;
}

function readEnvRecord(): Record<string, string | undefined> {
    try {
        const env = (import.meta as unknown as { env?: Record<string, unknown> }).env;
        if (env === null || env === undefined || typeof env !== "object") return {};
        const out: Record<string, string | undefined> = {};
        for (const key of ["VITE_AGENT_FIRST", "VITE_LBM_ENABLED", "VITE_SURROGATE_ENABLED", "VITE_ENGINE_SWITCHING_ENABLED"]) {
            const raw = (env as Record<string, unknown>)[key];
            out[key] = typeof raw === "string" ? raw : undefined;
        }
        return out;
    } catch {
        return {};
    }
}

function isAffirmative(raw: string | undefined): boolean {
    try {
        if (raw === undefined) return false;
        const t = raw.trim().toLowerCase();
        return t === "true" || t === "1" || t === "on" || t === "yes";
    } catch {
        return false;
    }
}

function isNegative(raw: string | undefined): boolean {
    try {
        if (raw === undefined) return false;
        const t = raw.trim().toLowerCase();
        return t === "false" || t === "0" || t === "off" || t === "no";
    } catch {
        return false;
    }
}

/**
 * Read the build-time backend flags. agentFirst defaults on (unset or
 * blank means analytic only); the capability flags default off. An
 * explicit negative pins agentFirst off, an explicit affirmative keeps
 * it on. Never throws.
 */
export function agentFirstFlags(): AgentFirstFlags {
    try {
        const env = readEnvRecord();
        const firstRaw = env.VITE_AGENT_FIRST;
        const agentFirst = firstRaw === undefined || firstRaw.trim().length === 0 ? true : !isNegative(firstRaw);
        return {
            agentFirst,
            lbmEnabled: agentFirst ? false : isAffirmative(env.VITE_LBM_ENABLED),
            surrogateEnabled: agentFirst ? false : isAffirmative(env.VITE_SURROGATE_ENABLED),
            engineSwitchingEnabled: agentFirst ? false : isAffirmative(env.VITE_ENGINE_SWITCHING_ENABLED),
        };
    } catch {
        return { agentFirst: true, lbmEnabled: false, surrogateEnabled: false, engineSwitchingEnabled: false };
    }
}

/**
 * Resolve the effective agent-first mode. An explicit boolean wins (so
 * tests and callers can pin legacy behavior), otherwise the build-time
 * flag decides. Never throws.
 */
export function resolveAgentFirst(explicit?: unknown): boolean {
    try {
        if (typeof explicit === "boolean") return explicit;
        return agentFirstFlags().agentFirst;
    } catch {
        return true;
    }
}

/**
 * LBM worker creation gate. True only when agent-first is off and the
 * caller armed LBM, so the worker constructor is unreachable under the
 * flag. Never throws.
 */
export function lbmWorkerArmed(flags: AgentFirstFlags | null | undefined, lbmActive: boolean): boolean {
    try {
        if (flags === null || flags === undefined) return false;
        return flags.agentFirst !== true && lbmActive === true;
    } catch {
        return false;
    }
}

/**
 * Neural bundle load gate. False under agent-first, so neither adapter
 * instantiation nor ensureLoaded runs in that mode. Never throws.
 */
export function neuralLoadAllowed(flags: AgentFirstFlags | null | undefined): boolean {
    try {
        if (flags === null || flags === undefined) return false;
        return flags.agentFirst !== true;
    } catch {
        return false;
    }
}

/** Agent-first startup resolution for ?engine=lbm. Never throws. */
export interface AgentFirstStartup {
    /** Worker arming after the flag is applied, false under the flag. */
    lbmArmed: boolean;
    /** True when the URL asked for LBM but the flag held it off. */
    ignoredLbmRequest: boolean;
}

function readEngineParam(search: string): string | null {
    try {
        const q = search.startsWith("?") ? search : `?${search}`;
        return new URLSearchParams(q).get("engine");
    } catch {
        return null;
    }
}

/**
 * Resolve worker arming at startup. Under the flag LBM is forced off and
 * a ?engine=lbm request is reported as ignored so the App can note it in
 * the terminal. Legacy mode passes the request through. Never throws.
 */
export function resolveAgentFirstStartup(search: string): AgentFirstStartup {
    try {
        const flags = agentFirstFlags();
        const requested = readEngineParam(search) === "lbm";
        if (flags.agentFirst) return { lbmArmed: false, ignoredLbmRequest: requested };
        return { lbmArmed: requested, ignoredLbmRequest: false };
    } catch {
        return { lbmArmed: false, ignoredLbmRequest: false };
    }
}
