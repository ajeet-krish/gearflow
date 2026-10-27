// Phase B3 agent reply cache. Pure helpers plus a chat wrapper with zero
// live calls in the module itself. Entries live in memory plus a single
// localStorage blob for 24 h (AGENT_CACHE_TTL_MS), keyed by prompt plus
// context hash plus schema version. Stale entries serve when the live call
// fails, corrupt entries are dropped and refetched. Never throws.
//
// Key choice: FNV-1a 32 bit runs synchronously with zero dependencies, so
// buildCacheKey stays deterministic on the hot path. cachedChat upgrades to
// SHA-256 through SubtleCrypto when a secure context offers it and falls
// back to the same FNV key otherwise, so keys stay stable within each
// environment (SHA-256 where offered, FNV elsewhere) and entries do not
// transfer across environments with different crypto availability.

import {
    type BasetenChatOptions,
    type BasetenChatResult,
    type BasetenMessage,
} from "./basetenClient";

export const AGENT_CACHE_VERSION = 1;
export const AGENT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const AGENT_CACHE_KEY = "gearflow:agent-cache:v1";
export const AGENT_CACHE_MAX_ENTRIES = 50;

/** Minimal key value surface so tests inject a fake and the browser path
 *  uses localStorage. localStorage satisfies this interface directly. */
export interface AgentCacheStore {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

export interface AgentCacheUsage {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
}

export interface AgentCacheEntry {
    version: number;
    text: string;
    action: unknown;
    model: string;
    usage: AgentCacheUsage;
    costUsd: number;
    latencyMs: number;
    at: number;
}

export interface AgentCacheDeps {
    now?: number;
    store?: AgentCacheStore | null;
    skipMemory?: boolean;
}

export interface CachedChatOptions extends BasetenChatOptions {
    now?: number;
    store?: AgentCacheStore | null;
    skipMemory?: boolean;
}

/** Minimal chat port so the wrapper accepts the console port or a fake. */
export interface ChatPort {
    chat(messages: BasetenMessage[], opts?: BasetenChatOptions): Promise<BasetenChatResult>;
}

const g_memory = new Map<string, AgentCacheEntry>();

function nowMs(given: unknown): number {
    if (typeof given === "number" && Number.isFinite(given) && given >= 0) return given;
    return Date.now();
}

function resolveStore(explicit: AgentCacheStore | null | undefined): AgentCacheStore | null {
    if (explicit !== undefined) return explicit;
    try {
        if (typeof localStorage !== "undefined") return localStorage;
    } catch {
        return null;
    }
    return null;
}

/** Deterministic FNV-1a 32 bit hex digest, sync with zero dependencies. */
export function fnv1a32(text: string): string {
    let hash = 0x811c9dc5;
    const input = typeof text === "string" ? text : "";
    for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Sync cache key: schema version plus FNV of prompt plus context. */
export function buildCacheKey(prompt: string, contextJson: string): string {
    const p = typeof prompt === "string" ? prompt : "";
    const c = typeof contextJson === "string" ? contextJson : "";
    return `v${AGENT_CACHE_VERSION}:${fnv1a32(`${p}\n${c}`)}`;
}

function bytesToHex(bytes: ArrayBuffer): string {
    const view = new Uint8Array(bytes);
    let out = "";
    for (let i = 0; i < view.length; i += 1) {
        out += view[i].toString(16).padStart(2, "0");
    }
    return out;
}

/**
 * Async cache key: SHA-256 through SubtleCrypto when available, otherwise
 * the same sync FNV key. Never throws, always resolves a versioned key.
 */
export async function buildCacheKeyAsync(prompt: string, contextJson: string): Promise<string> {
    try {
        const cryptoRef = (globalThis as unknown as { crypto?: unknown }).crypto as
            | { subtle?: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> } }
            | undefined;
        if (cryptoRef?.subtle !== undefined && typeof cryptoRef.subtle.digest === "function") {
            const data = new TextEncoder().encode(
                `${typeof prompt === "string" ? prompt : ""}\n${typeof contextJson === "string" ? contextJson : ""}`
            );
            const digest = await cryptoRef.subtle.digest("SHA-256", data);
            return `v${AGENT_CACHE_VERSION}:sha256:${bytesToHex(digest)}`;
        }
    } catch {
        // SubtleCrypto unavailable or denied: fall through to FNV below.
    }
    return buildCacheKey(prompt, contextJson);
}

function isNonNegNumber(v: unknown): v is number {
    return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

function isCacheEntry(v: unknown): v is AgentCacheEntry {
    if (typeof v !== "object" || v === null) return false;
    const r = v as Record<string, unknown>;
    if (r.version !== AGENT_CACHE_VERSION) return false;
    if (typeof r.text !== "string" || typeof r.model !== "string") return false;
    if (!isNonNegNumber(r.at) || typeof r.costUsd !== "number" || !Number.isFinite(r.costUsd)) return false;
    if (typeof r.latencyMs !== "number" || !Number.isFinite(r.latencyMs)) return false;
    const usage = r.usage as Record<string, unknown> | null | undefined;
    if (typeof usage !== "object" || usage === null) return false;
    return isNonNegNumber(usage.inputTokens) && isNonNegNumber(usage.outputTokens) && isNonNegNumber(usage.cachedTokens);
}

/** True when the entry is older than the 24 h TTL. Never throws. */
export function isExpired(entry: AgentCacheEntry | null | undefined, now?: unknown): boolean {
    try {
        if (entry === null || entry === undefined) return true;
        const at = (entry as AgentCacheEntry).at;
        if (typeof at !== "number" || !Number.isFinite(at)) return true;
        return nowMs(now) - at > AGENT_CACHE_TTL_MS;
    } catch {
        return true;
    }
}

/** Clear the in memory layer. localStorage blobs are left intact. */
export function clearAgentCache(): void {
    g_memory.clear();
}

function readBlob(store: AgentCacheStore | null): Record<string, unknown> | null {
    if (store === null) return null;
    let raw: string | null = null;
    try {
        raw = store.getItem(AGENT_CACHE_KEY);
    } catch {
        return null;
    }
    if (raw === null) return null;
    try {
        const parsed = JSON.parse(raw) as { version?: unknown; entries?: unknown };
        if (parsed === null || typeof parsed !== "object") return null;
        if (parsed.version !== AGENT_CACHE_VERSION) return null;
        if (parsed.entries === null || typeof parsed.entries !== "object") return null;
        return parsed.entries as Record<string, unknown>;
    } catch {
        try {
            store.removeItem(AGENT_CACHE_KEY);
        } catch {
            // Evicting a corrupt blob is best effort only.
        }
        return null;
    }
}

function writeBlob(store: AgentCacheStore | null, entries: Record<string, AgentCacheEntry>): void {
    if (store === null) return;
    try {
        const keys = Object.keys(entries).sort((a, b) => entries[a].at - entries[b].at);
        const trimmed: Record<string, AgentCacheEntry> = {};
        for (const key of keys.slice(-AGENT_CACHE_MAX_ENTRIES)) {
            trimmed[key] = entries[key];
        }
        store.setItem(AGENT_CACHE_KEY, JSON.stringify({ version: AGENT_CACHE_VERSION, entries: trimmed }));
    } catch {
        // Quota or private mode: the memory layer still serves this session.
    }
}

/** Raw entry regardless of TTL, or null on miss or corruption. Never throws. */
export function readRawEntry(key: string, deps?: AgentCacheDeps): AgentCacheEntry | null {
    try {
        if (typeof key !== "string" || key.length === 0) return null;
        const skipMemory = deps?.skipMemory === true;
        if (!skipMemory) {
            const hit = g_memory.get(key) ?? null;
            if (hit !== null && isCacheEntry(hit)) return hit;
            if (hit !== null) g_memory.delete(key);
        }
        const store = resolveStore(deps?.store);
        const blob = readBlob(store);
        if (blob === null) return null;
        const found = blob[key] ?? null;
        if (!isCacheEntry(found)) {
            if (found !== null && found !== undefined && store !== null) {
                try {
                    const next: Record<string, AgentCacheEntry> = {};
                    for (const [k, v] of Object.entries(blob)) {
                        if (k !== key && isCacheEntry(v)) next[k] = v;
                    }
                    writeBlob(store, next);
                } catch {
                    // Eviction is best effort only.
                }
            }
            return null;
        }
        if (!skipMemory) g_memory.set(key, found);
        return found;
    } catch {
        return null;
    }
}

/** Fresh entry or null when missing, corrupt, or past the TTL. Never throws. */
export function cacheGet(key: string, deps?: AgentCacheDeps): AgentCacheEntry | null {
    const found = readRawEntry(key, deps);
    if (found === null) return null;
    if (isExpired(found, deps?.now)) return null;
    return found;
}

/** Store one result under key in memory plus the blob. Never throws. */
export function cacheSet(key: string, result: BasetenChatResult, deps?: AgentCacheDeps): void {
    try {
        if (typeof key !== "string" || key.length === 0) return;
        if (result === null || typeof result !== "object") return;
        const now = nowMs(deps?.now);
        const usage = (result as BasetenChatResult).usage ?? { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
        const entry: AgentCacheEntry = {
            version: AGENT_CACHE_VERSION,
            text: typeof result.text === "string" ? result.text : "",
            action: (result as BasetenChatResult).action ?? null,
            model: typeof result.model === "string" ? result.model : "unknown",
            usage: {
                inputTokens: isNonNegNumber(usage.inputTokens) ? Math.floor(usage.inputTokens) : 0,
                outputTokens: isNonNegNumber(usage.outputTokens) ? Math.floor(usage.outputTokens) : 0,
                cachedTokens: isNonNegNumber(usage.cachedTokens) ? Math.floor(usage.cachedTokens) : 0,
            },
            costUsd: typeof result.costUsd === "number" && Number.isFinite(result.costUsd) && result.costUsd > 0 ? result.costUsd : 0,
            latencyMs: typeof result.latencyMs === "number" && Number.isFinite(result.latencyMs) && result.latencyMs > 0 ? result.latencyMs : 0,
            at: now,
        };
        if (deps?.skipMemory !== true) {
            g_memory.set(key, entry);
            while (g_memory.size > AGENT_CACHE_MAX_ENTRIES) {
                const oldest = g_memory.keys().next();
                if (oldest.done) break;
                g_memory.delete(oldest.value);
            }
        }
        const store = resolveStore(deps?.store);
        const blob = readBlob(store) ?? {};
        const next: Record<string, AgentCacheEntry> = {};
        for (const [k, v] of Object.entries(blob)) {
            if (isCacheEntry(v)) next[k] = v;
        }
        next[key] = entry;
        writeBlob(store, next);
    } catch {
        // Cache writes never break the chat path.
    }
}

function zeroedCopy(entry: AgentCacheEntry): BasetenChatResult {
    return {
        text: entry.text,
        action: entry.action,
        model: entry.model,
        usage: {
            inputTokens: 0,
            outputTokens: 0,
            cachedTokens: entry.usage.inputTokens + entry.usage.outputTokens,
        },
        costUsd: 0,
        latencyMs: 0,
    };
}

/**
 * Cached chat wrapper: serve a fresh entry with zeroed marginal cost (the
 * spend meter stays honest and the console shows the cached badge), else
 * delegate to the port and store the result, else serve the stale entry
 * when the live call fails. Rejects only when the store is empty and the
 * live call fails. Never caches failures.
 */
export async function cachedChat(
    port: ChatPort,
    messages: BasetenMessage[],
    opts?: CachedChatOptions
): Promise<BasetenChatResult> {
    const list = Array.isArray(messages) ? messages : [];
    let prompt = "";
    try {
        const lastUser = [...list].reverse().find((m) => m !== null && typeof m === "object" && m.role === "user");
        prompt = typeof lastUser?.content === "string" ? lastUser.content : "";
        if (prompt.length === 0) prompt = JSON.stringify(list).slice(0, 2000);
    } catch {
        prompt = "";
    }
    let contextJson = "{}";
    try {
        contextJson = JSON.stringify(list).slice(0, 3500);
    } catch {
        contextJson = "{}";
    }
    const key = await buildCacheKeyAsync(prompt, contextJson);
    const deps: AgentCacheDeps = { now: opts?.now, store: opts?.store, skipMemory: opts?.skipMemory };
    const raw = readRawEntry(key, deps);
    if (raw !== null && !isExpired(raw, deps.now)) {
        return zeroedCopy(raw);
    }
    const { now: _now, store: _store, skipMemory: _skip, ...chatOpts } = opts ?? {};
    void _now;
    void _store;
    void _skip;
    try {
        const live = await port.chat(list, chatOpts);
        cacheSet(key, live, deps);
        return live;
    } catch (e) {
        if (raw !== null) return zeroedCopy(raw);
        throw e;
    }
}
