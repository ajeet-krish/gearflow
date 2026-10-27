// Phase B3 session spend meter. Pure helpers behind the console spend meter.
// Tracks input plus output tokens plus cost in USD with a five dollar soft
// stop predicate. Every entry point is NaN safe and never throws: non finite
// counts and costs coerce to zero, non finite caps never trigger a stop.

export const SESSION_SPEND_CAP_USD = 5;

export interface SpendUsage {
    inputTokens: number;
    outputTokens: number;
}

export interface SpendState {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
}

/** Fresh zero spend accumulator for a new session. */
export function createSpend(): SpendState {
    return { inputTokens: 0, outputTokens: 0, costUsd: 0 };
}

function cleanCount(v: unknown): number {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return 0;
    return Math.floor(v);
}

function cleanCost(v: unknown): number {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return 0;
    return v;
}

/**
 * Add one result to the session accumulator. Returns a new object, never
 * mutates the input, and coerces poisoned counts or costs to zero so the
 * meter can never display NaN. Never throws.
 */
export function addSpend(
    state: SpendState | null | undefined,
    usage: { inputTokens?: unknown; outputTokens?: unknown } | null | undefined,
    costUsd: unknown
): SpendState {
    try {
        const base = state ?? createSpend();
        const use = usage ?? {};
        return {
            inputTokens: cleanCount(base.inputTokens) + cleanCount(use.inputTokens),
            outputTokens: cleanCount(base.outputTokens) + cleanCount(use.outputTokens),
            costUsd: cleanCost(base.costUsd) + cleanCost(costUsd),
        };
    } catch {
        return createSpend();
    }
}

/**
 * Soft stop predicate: true when the session cost reaches the cap. NaN or
 * non finite costs never stop, and a NaN or non finite cap never stops, so
 * a poisoned meter fails open to local mode instead of locking the console.
 */
export function isSoftStopped(costUsd: unknown, cap: unknown = SESSION_SPEND_CAP_USD): boolean {
    if (typeof costUsd !== "number" || !Number.isFinite(costUsd)) return false;
    if (typeof cap !== "number" || !Number.isFinite(cap)) return false;
    return costUsd >= cap;
}
