// HashCache: content addressed memory plus localStorage cache for Meta text
// results. Binary blobs (SAM masks, poster images) stay in memory only.
// TTLs: Spark and engineer 24 h, SAM 7 d, poster session only (memory).
// Stale entries are served when the network fails. Memory is LRU capped at
// 100 entries with TTL sweep on set; expired entries are deleted on get;
// persisted values are capped so one prompt cannot fill localStorage.

export const TTL_SPARK_MS = 24 * 60 * 60 * 1000;
export const TTL_ENGINEER_MS = 24 * 60 * 60 * 1000;
export const TTL_SAM_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_CACHE_ENTRIES = 100;
export const MAX_PERSIST_BYTES = 100 * 1024;
const STORAGE_PREFIX = "gearflow:meta:";

interface CacheRecord {
    value: unknown;
    expiresAt: number;
}

function stableStringify(input: unknown): string {
    if (input === null || typeof input !== "object") return JSON.stringify(input) ?? "null";
    if (input instanceof Uint8Array) {
        let out = "[";
        for (let i = 0; i < input.length; i++) out += (i > 0 ? "," : "") + input[i];
        return `${out}]`;
    }
    if (Array.isArray(input)) return `[${input.map((v) => stableStringify(v)).join(",")}]`;
    const obj = input as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

async function sha256HexText(text: string): Promise<string> {
    const cryptoObj = (globalThis as unknown as { crypto?: { subtle?: SubtleCrypto } }).crypto;
    if (cryptoObj?.subtle !== undefined) {
        const digest = await cryptoObj.subtle.digest("SHA-256", new TextEncoder().encode(text));
        return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    }
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < text.length; i++) {
        h1 = Math.imul(h1 ^ text.charCodeAt(i), 16777619);
        h2 = Math.imul(h2 + text.charCodeAt(i), 2246822519);
    }
    return `${(h1 >>> 0).toString(16).padStart(8, "0")}${(h2 >>> 0).toString(16).padStart(8, "0")}`.repeat(8).slice(0, 64);
}

export async function hashKey(parts: unknown): Promise<string> {
    return sha256HexText(stableStringify(parts));
}

/** SHA-256 over raw bytes, chunked so large sketches never build one giant string. */
export async function hashBytes(data: Uint8Array | ArrayBuffer): Promise<string> {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const cryptoObj = (globalThis as unknown as { crypto?: { subtle?: SubtleCrypto } }).crypto;
    if (cryptoObj?.subtle !== undefined) {
        const digest = await cryptoObj.subtle.digest("SHA-256", bytes as unknown as BufferSource);
        return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    }
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < bytes.length; i++) {
        h1 = Math.imul(h1 ^ bytes[i], 16777619);
        h2 = Math.imul(h2 + bytes[i], 2246822519);
    }
    return `${(h1 >>> 0).toString(16).padStart(8, "0")}${(h2 >>> 0).toString(16).padStart(8, "0")}`.repeat(8).slice(0, 64);
}

function storageGet(key: string): CacheRecord | null {
    try {
        if (typeof localStorage === "undefined") return null;
        const raw = localStorage.getItem(`${STORAGE_PREFIX}${key}`);
        if (raw === null) return null;
        const parsed = JSON.parse(raw) as CacheRecord;
        if (typeof parsed.expiresAt !== "number") return null;
        return parsed;
    } catch {
        return null;
    }
}

function storageSet(key: string, record: CacheRecord): void {
    try {
        if (typeof localStorage === "undefined") return;
        const raw = JSON.stringify(record);
        if (raw.length > MAX_PERSIST_BYTES) return;
        localStorage.setItem(`${STORAGE_PREFIX}${key}`, raw);
    } catch {
        // Quota or privacy mode: memory copy still serves this session.
    }
}

function storageDelete(key: string): void {
    try {
        if (typeof localStorage === "undefined") return;
        localStorage.removeItem(`${STORAGE_PREFIX}${key}`);
    } catch {
        // Privacy mode: nothing persisted, nothing to remove.
    }
}

export class HashCache {
    private memory = new Map<string, CacheRecord>();
    /** Persist text results to localStorage. Binary results skip this. */
    persist: boolean;

    constructor(persist = true) {
        this.persist = persist;
    }

    get<T>(key: string, opts: { allowStale?: boolean } = {}): { value: T; stale: boolean } | null {
        const record = this.memory.get(key) ?? (this.persist ? storageGet(key) : null);
        if (!record) return null;
        if (record.expiresAt > Date.now()) {
            if (!this.memory.has(key)) {
                this.memory.set(key, record);
                this.enforceCap();
            } else {
                // LRU refresh: reinsert so recently read entries survive eviction.
                this.memory.delete(key);
                this.memory.set(key, record);
            }
            return { value: record.value as T, stale: false };
        }
        if (opts.allowStale === true) return { value: record.value as T, stale: true };
        this.memory.delete(key);
        if (this.persist) storageDelete(key);
        return null;
    }

    set(key: string, value: unknown, ttlMs: number, opts: { persist?: boolean } = {}): void {
        this.sweepExpired();
        const record: CacheRecord = { value, expiresAt: Date.now() + ttlMs };
        if (this.memory.has(key)) this.memory.delete(key);
        this.memory.set(key, record);
        this.enforceCap();
        if ((opts.persist ?? this.persist) && ttlMs > 0) storageSet(key, record);
    }

    clear(): void {
        this.memory.clear();
        try {
            if (typeof localStorage !== "undefined") {
                const doomed: string[] = [];
                for (let i = 0; i < localStorage.length; i++) {
                    const k = localStorage.key(i);
                    if (k !== null && k.startsWith(STORAGE_PREFIX)) doomed.push(k);
                }
                for (const k of doomed) localStorage.removeItem(k);
            }
        } catch {
            // Privacy mode: memory is already cleared.
        }
    }

    size(): number {
        return this.memory.size;
    }

    private sweepExpired(): void {
        const now = Date.now();
        for (const [k, r] of this.memory) {
            if (r.expiresAt <= now) {
                this.memory.delete(k);
                if (this.persist) storageDelete(k);
            }
        }
    }

    private enforceCap(): void {
        while (this.memory.size > MAX_CACHE_ENTRIES) {
            const oldest = this.memory.keys().next();
            if (oldest.done === true) break;
            const k = oldest.value as string;
            this.memory.delete(k);
            if (this.persist) storageDelete(k);
        }
    }
}
