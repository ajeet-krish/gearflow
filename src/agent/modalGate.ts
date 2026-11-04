// Modal transport gate, pure module for the Muse Spark proxy.
// Pinned live contract: OpenAI compatible chat completions over the
// operator configured MODAL_CHAT_URL (a https Modal serving host) with
// n fixed to 1, max_tokens capped at 400, temperature forced to 0, and
// chat_template_kwargs.reasoning_effort pinned to low,
// the pinned gearflow-chat endpoint model. Modal-only: invalid or
// missing upstream config fails closed, never falls back. No React,
// no DOM, no secrets in this module.

export const MODAL_MODEL_ID = "gearflow-chat";
export const MODAL_PATH = "/api/modal/chat/completions";
export const MODAL_MAX_BODY_BYTES = 64 * 1024;
export const MODAL_MAX_RESPONSE_BYTES = 1 * 1024 * 1024;
export const MODAL_MAX_TOKENS = 400;
export const MODAL_TIMEOUT_MS = 60000;
export const MODAL_RATE_LIMIT_MAX = 10;
export const MODAL_RATE_LIMIT_WINDOW_MS = 60 * 1000;
export const MODAL_RATE_LIMIT_MAX_ENTRIES = 5000;
export const MODAL_MAX_MESSAGES = 32;
export const MODAL_MAX_MESSAGE_CHARS = 8000;
export const MODAL_MAX_TOTAL_MESSAGE_CHARS = 48000;
export const MODAL_REASONING_EFFORT = "low";

/** Browser safe process.env read. Default params evaluate at call time,
 *  so direct process.env access throws ReferenceError in browsers where
 *  process is undefined (Live request failed). Returns {} there. */
function safeProcessEnv(): Record<string, string | undefined> {
    try {
        if (typeof process !== "undefined" && process.env) {
            return process.env as Record<string, string | undefined>;
        }
    } catch {
        // process is undefined in the browser, fall through to {}.
    }
    return {};
}

/** Resolve the Modal model name: trimmed non empty MODAL_MODEL_ID env wins
 *  (endpoint renames), otherwise the pinned gearflow-chat default. Pure
 *  with an injectable env map for tests; never throws. */
export function resolveModalModelId(env: Record<string, string | undefined> = safeProcessEnv()): string {
    try {
        const raw = env.MODAL_MODEL_ID;
        if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
    } catch {
        // Env read failed, fall through to the pinned default.
    }
    return MODAL_MODEL_ID;
}

/** Host allowlist for the Modal upstream. Only Modal serving hosts
 *  (modal.run and modal.direct) are allowed, never arbitrary,
 *  credentialed, or query and fragment carrying URLs. */
export function isAllowedModalUpstreamHost(hostname: unknown): boolean {
    if (typeof hostname !== "string" || hostname.length === 0) return false;
    const host = hostname.toLowerCase();
    return (
        host === "modal.run" ||
        host.endsWith(".modal.run") ||
        host === "modal.direct" ||
        host.endsWith(".modal.direct")
    );
}

/** True when the string is an https URL on the Modal allowlist with no
 *  embedded credentials and no query or fragment. Query and fragment are
 *  rejected so operator URLs cannot smuggle secrets or tracking state. */
export function isAllowedModalUpstreamUrl(value: unknown): boolean {
    if (typeof value !== "string") return false;
    const trimmed = value.trim();
    if (trimmed.length === 0) return false;
    let parsed: URL;
    try {
        parsed = new URL(trimmed);
    } catch {
        return false;
    }
    if (parsed.protocol !== "https:") return false;
    if (parsed.username.length > 0 || parsed.password.length > 0) return false;
    if (parsed.search.length > 0 || parsed.hash.length > 0) return false;
    return isAllowedModalUpstreamHost(parsed.hostname);
}

/**
 * Resolve the Modal chat completions upstream URL from the environment.
 * Returns the trimmed MODAL_CHAT_URL when it is an https URL on the
 * Modal allowlist, otherwise null (fail closed, no fallback upstream).
 * Pure with an injectable env map for tests; never throws.
 */
export function resolveModalUpstreamUrl(env: Record<string, string | undefined> = safeProcessEnv()): string | null {
    try {
        const raw = env.MODAL_CHAT_URL;
        if (typeof raw === "string" && isAllowedModalUpstreamUrl(raw)) return raw.trim();
    } catch {
        // Env read failed, fall through to null below.
    }
    return null;
}

/** Proxy 503 message when the kill switch is set. The client maps any 503
 *  to offline, so this string only names the cause for proxy logs and
 *  tests, never for browser error detail. */
export const MODAL_DISABLED_MESSAGE = "Modal disabled";

/**
 * Kill switch predicate for the Modal proxy. Reads the MODAL_DISABLED
 * server environment value: the exact string "true" disables the proxy
 * with a 503, any other value (including unset) leaves the proxy live.
 * Pure and never throws.
 */
export function isModalDisabled(value: unknown): boolean {
    try {
        return value === "true";
    } catch {
        return false;
    }
}

/** Allowlist: only POST to the single pinned chat completions path. */
export function isModalPath(method: string | undefined, url: string | undefined): boolean {
    if ((method ?? "GET").toUpperCase() !== "POST") return false;
    if (url === undefined) return false;
    if (!url.startsWith("/api/modal")) return false;
    const pathOnly = url.split("?")[0].split("#")[0];
    if (pathOnly.split("/").some((seg) => seg === "." || seg === "..")) return false;
    const clean = pathOnly.length > 1 ? pathOnly.replace(/\/+$/, "") : pathOnly;
    return clean === MODAL_PATH;
}

/** Body cap predicate: true when the byte count fits the 64 KiB budget. */
export function checkBodySize(bytes: number): boolean {
    if (!Number.isFinite(bytes) || bytes < 0) return false;
    return bytes <= MODAL_MAX_BODY_BYTES;
}

function clampTokens(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        return MODAL_MAX_TOKENS;
    }
    return Math.min(Math.floor(value), MODAL_MAX_TOKENS);
}

const MODAL_ALLOWED_ROLES = new Set(["system", "user", "assistant"]);

export interface ModalSanitizedMessage {
    role: "system" | "user" | "assistant";
    content: string;
}

/**
 * Allowlist sanitize for chat messages. Keeps at most MODAL_MAX_MESSAGES
 * entries with an allowlisted role and string content, truncates each
 * content to MODAL_MAX_MESSAGE_CHARS, and enforces the total char budget
 * MODAL_MAX_TOTAL_MESSAGE_CHARS by truncating or dropping trailing
 * entries. Never throws, returns an empty array for non arrays.
 */
export function sanitizeModalMessages(value: unknown): ModalSanitizedMessage[] {
    if (!Array.isArray(value)) return [];
    const out: ModalSanitizedMessage[] = [];
    let total = 0;
    const limit = Math.min(value.length, MODAL_MAX_MESSAGES);
    for (let i = 0; i < limit; i += 1) {
        const entry = value[i] as unknown;
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
        const rec = entry as Record<string, unknown>;
        if (typeof rec.role !== "string" || !MODAL_ALLOWED_ROLES.has(rec.role)) continue;
        if (typeof rec.content !== "string") continue;
        const remaining = MODAL_MAX_TOTAL_MESSAGE_CHARS - total;
        if (remaining <= 0) break;
        const perMessage = rec.content.slice(0, MODAL_MAX_MESSAGE_CHARS);
        const clipped = perMessage.slice(0, remaining);
        if (clipped.length === 0) continue;
        out.push({ role: rec.role as ModalSanitizedMessage["role"], content: clipped });
        total += clipped.length;
    }
    return out;
}

/**
 * Overwrite any client supplied model with the pinned gearflow-chat id
 * (overridable via the server only MODAL_MODEL_ID env for endpoint
 * renames), force n to 1, cap max_tokens at 400, force temperature
 * to 0, and pin chat_template_kwargs.reasoning_effort to low (merged
 * over any client supplied chat_template_kwargs so low always wins;
 * the endpoint default medium would spend the whole 400 token budget
 * on reasoning, leaving empty content). Returns a new
 * object, never mutates input. The optional env map keeps the override
 * pure and testable; production callers omit it so safeProcessEnv()
 * is read. */
export function forceModel(body: unknown, env: Record<string, string | undefined> = safeProcessEnv()): unknown {
    const model = resolveModalModelId(env);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return {
            messages: [],
            stream: false,
            model,
            n: 1,
            max_tokens: MODAL_MAX_TOKENS,
            temperature: 0,
            chat_template_kwargs: { reasoning_effort: MODAL_REASONING_EFFORT },
        };
    }
    const src = body as Record<string, unknown>;
    return {
        messages: sanitizeModalMessages(src.messages),
        stream: src.stream === true,
        model,
        n: 1,
        max_tokens: clampTokens(src.max_tokens),
        temperature: 0,
        chat_template_kwargs: forceReasoningKwargs(src.chat_template_kwargs),
    };
}

/** Merge client chat_template_kwargs over a pinned low reasoning effort.
 *  Keeps client keys (so endpoint extras survive) but always overwrites
 *  reasoning_effort with low. Returns a fresh object, never mutates
 *  input; non objects become the pinned default. Skips prototype
 *  pollution keys. */
function forceReasoningKwargs(value: unknown): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
            if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
            try {
                out[key] = entry;
            } catch {
                continue;
            }
        }
    }
    out.reasoning_effort = MODAL_REASONING_EFFORT;
    return out;
}

/** Retryable upstream status: 429 plus any 5xx. */
export function isRetryable(status: number): boolean {
    return status === 429 || (status >= 500 && status <= 599);
}

export interface ModalGenericError {
    status: number;
    retryable: boolean;
    message: string;
}

/**
 * Map an upstream status to a generic client error. Upstream bodies are
 * never echoed, so no key or provider detail can leak to the browser.
 */
export function toGenericError(status: number): ModalGenericError {
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

export class ModalRateLimiter {
    private hits = new Map<string, number[]>();
    constructor(
        private max = MODAL_RATE_LIMIT_MAX,
        private windowMs = MODAL_RATE_LIMIT_WINDOW_MS
    ) {}

    allow(ip: string, now = Date.now()): boolean {
        this.evictExpired(now);
        const key = typeof ip === "string" && ip.length > 0 ? ip.slice(0, 128) : "local";
        const existing = this.hits.get(key);
        // Refresh recency for LRU ordering before the limit check.
        if (existing !== undefined) this.hits.delete(key);
        const list = (existing ?? []).filter((t) => now - t < this.windowMs);
        if (list.length >= this.max) {
            this.hits.set(key, list);
            this.enforceCap(key);
            return false;
        }
        list.push(now);
        this.hits.set(key, list);
        this.enforceCap(key);
        return true;
    }

    private enforceCap(exceptKey?: string): void {
        while (this.hits.size > MODAL_RATE_LIMIT_MAX_ENTRIES) {
            const oldest = this.hits.keys().next();
            if (oldest.done) break;
            const oldestKey = oldest.value as string;
            // Never evict the entry just touched; remove the next oldest.
            if (exceptKey !== undefined && oldestKey === exceptKey) {
                const second = this.hits.keys().next();
                void second;
                // Move the protected key to the end then drop the new oldest.
                const protectedList = this.hits.get(exceptKey);
                if (protectedList !== undefined && this.hits.size > 1) {
                    this.hits.delete(exceptKey);
                    const nextOldest = this.hits.keys().next();
                    if (!nextOldest.done) this.hits.delete(nextOldest.value as string);
                    this.hits.set(exceptKey, protectedList);
                    continue;
                }
                break;
            }
            this.hits.delete(oldestKey);
        }
    }

    private evictExpired(now: number): void {
        for (const [key, times] of this.hits) {
            const live = times.filter((t) => now - t < this.windowMs);
            if (live.length === 0) {
                this.hits.delete(key);
            } else if (live.length !== times.length) {
                this.hits.delete(key);
                this.hits.set(key, live);
            }
        }
        // Hard cap with LRU eviction so a spoofed IP flood cannot grow
        // the map without bound. Oldest insertion order evicts first.
        while (this.hits.size >= MODAL_RATE_LIMIT_MAX_ENTRIES) {
            const oldest = this.hits.keys().next();
            if (oldest.done) break;
            this.hits.delete(oldest.value as string);
        }
    }

    size(): number {
        return this.hits.size;
    }
}

/** Shared process rate limiter for the dev and preview Modal proxy. */
export const g_modalRateLimiter = new ModalRateLimiter();
