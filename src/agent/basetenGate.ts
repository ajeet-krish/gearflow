// Baseten transport gate, pure module for the Muse Spark proxy.
// Pinned live contract from B0: OpenAI compatible chat completions over
// https://inference.baseten.co/v1/chat/completions with n fixed to 1.
// Prompt fenced JSON envelope is used because native tool_calls are not
// returned (the model reasons in reasoning_content). No React, no DOM,
// no secrets in this module.

export const BASETEN_MODEL_ID = "meta-models/muse-spark-open-1026";
export const BASETEN_PATH = "/api/baseten/chat/completions";
export const BASETEN_UPSTREAM_URL = "https://inference.baseten.co/v1/chat/completions";
export const BASETEN_MAX_BODY_BYTES = 64 * 1024;
export const BASETEN_MAX_RESPONSE_BYTES = 1 * 1024 * 1024;
export const BASETEN_MAX_TOKENS = 700;
export const BASETEN_TIMEOUT_MS = 30000;
export const BASETEN_RATE_LIMIT_MAX = 10;
export const BASETEN_RATE_LIMIT_WINDOW_MS = 60 * 1000;
export const BASETEN_RATE_LIMIT_MAX_ENTRIES = 5000;

/** Proxy 503 message when the kill switch is set. The client maps any 503
 *  to offline local mode through toHttpError, so this string only names the
 *  cause for proxy logs and tests, never for browser error detail. */
export const BASETEN_DISABLED_MESSAGE = "Baseten disabled";

/**
 * Kill switch predicate for the Baseten proxy. Reads the BASETEN_DISABLED
 * server environment value: the exact string "true" disables the proxy with
 * a 503, any other value (including unset) leaves the proxy live. The 503
 * maps to offline local mode on the client, so the console keeps answering
 * from local state with zero network. Pure and never throws.
 */
export function isBasetenDisabled(value: unknown): boolean {
    try {
        return value === "true";
    } catch {
        return false;
    }
}

/** Allowlist: only POST to the single pinned chat completions path. */
export function isBasetenPath(method: string | undefined, url: string | undefined): boolean {
    if ((method ?? "GET").toUpperCase() !== "POST") return false;
    if (url === undefined) return false;
    if (!url.startsWith("/api/baseten")) return false;
    const pathOnly = url.split("?")[0].split("#")[0];
    if (pathOnly.split("/").some((seg) => seg === "." || seg === "..")) return false;
    const clean = pathOnly.length > 1 ? pathOnly.replace(/\/+$/, "") : pathOnly;
    return clean === BASETEN_PATH;
}

/** Body cap predicate: true when the byte count fits the 64 KiB budget. */
export function checkBodySize(bytes: number): boolean {
    if (!Number.isFinite(bytes) || bytes < 0) return false;
    return bytes <= BASETEN_MAX_BODY_BYTES;
}

function clampTokens(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        return BASETEN_MAX_TOKENS;
    }
    return Math.min(Math.floor(value), BASETEN_MAX_TOKENS);
}

/**
 * Overwrite any client supplied model with the pinned id, force n to 1,
 * and cap max_tokens at 700. Returns a new object, never mutates input.
 */
export function forceModel(body: unknown): unknown {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return { model: BASETEN_MODEL_ID, n: 1, max_tokens: BASETEN_MAX_TOKENS };
    }
    const src = body as Record<string, unknown>;
    return {
        ...src,
        model: BASETEN_MODEL_ID,
        n: 1,
        max_tokens: clampTokens(src.max_tokens),
    };
}

/** Retryable upstream status: 429 plus any 5xx. */
export function isRetryable(status: number): boolean {
    return status === 429 || (status >= 500 && status <= 599);
}

export interface BasetenGenericError {
    status: number;
    retryable: boolean;
    message: string;
}

/**
 * Map an upstream status to a generic client error. Upstream bodies are
 * never echoed, so no key or provider detail can leak to the browser.
 */
export function toGenericError(status: number): BasetenGenericError {
    const retryable = isRetryable(status);
    if (status === 404) {
        return { status, retryable: false, message: "model unavailable, please check model" };
    }
    if (status === 429) {
        return { status, retryable: true, message: "rate limited, retry later" };
    }
    if (status === 401) {
        return { status, retryable: false, message: "service unavailable" };
    }
    if (status === 503) {
        return { status, retryable: true, message: "service unavailable" };
    }
    return { status, retryable, message: "service unavailable" };
}

export class BasetenRateLimiter {
    private hits = new Map<string, number[]>();
    constructor(
        private max = BASETEN_RATE_LIMIT_MAX,
        private windowMs = BASETEN_RATE_LIMIT_WINDOW_MS
    ) {}

    allow(ip: string, now = Date.now()): boolean {
        this.evictExpired(now);
        const list = (this.hits.get(ip) ?? []).filter((t) => now - t < this.windowMs);
        if (list.length >= this.max) {
            this.hits.set(ip, list);
            return false;
        }
        list.push(now);
        this.hits.set(ip, list);
        return true;
    }

    private evictExpired(now: number): void {
        if (this.hits.size < BASETEN_RATE_LIMIT_MAX_ENTRIES) {
            for (const [key, times] of this.hits) {
                if (times.every((t) => now - t >= this.windowMs)) {
                    this.hits.delete(key);
                }
            }
            return;
        }
        for (const [key, times] of this.hits) {
            const live = times.filter((t) => now - t < this.windowMs);
            if (live.length === 0) {
                this.hits.delete(key);
            } else if (live.length !== times.length) {
                this.hits.set(key, live);
            }
        }
    }

    size(): number {
        return this.hits.size;
    }
}

/** Shared process rate limiter for the dev and preview Baseten proxy. */
export const g_basetenRateLimiter = new BasetenRateLimiter();
