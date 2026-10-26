// Meta API client. All browser calls go through the same origin proxy at
// /api/meta so the server only key (META_API_KEY) never reaches the bundle.
// Standard mode only. Typed errors, 15 s timeout, retry with backoff, and an
// eval hook that reports every call to the eval log.

export type MetaErrorCode = "offline" | "timeout" | "http" | "validation" | "network";

export class MetaError extends Error {
    code: MetaErrorCode;
    status: number | null;
    feature: string;
    constructor(code: MetaErrorCode, message: string, feature: string, status: number | null = null) {
        super(message);
        this.name = "MetaError";
        this.code = code;
        this.feature = feature;
        this.status = status;
    }
}

export interface EvalHookPayload {
    feature: string;
    model: string;
    latencyMs: number;
    costUsd: number;
    costEstimated: boolean;
    cached: boolean;
    ok: boolean;
    fallback: string | null;
    hash: string;
}

export interface MetaClientOptions {
    baseUrl?: string;
    fetchFn?: typeof fetch;
    offline?: boolean;
    timeoutMs?: number;
    maxRetries?: number;
    onEval?: (payload: EvalHookPayload) => void;
}

export const META_TIMEOUT_MS = 15000;
export const META_MAX_RETRIES = 2;
export const META_RETRY_BASE_MS = 500;
export const META_RETRY_CAP_MS = 8000;
export const META_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
export const META_MAX_SEGMENT_BYTES = 6 * 1024 * 1024;
export const META_MAX_POSTER_URL_CHARS = 8192;
export const META_MAX_POSTER_B64_CHARS = 7_000_000;

/**
 * Estimated price table (USD). Values are planning estimates, not live
 * billing, so every entry is flagged costEstimated in the eval log.
 * Chat models are priced per 1k tokens, SAM per call, image per render.
 */
export const META_COST_TABLE: Record<string, { per1kTokens?: number; perCall?: number }> = {
    "Llama-4-Maverick-17B-128E-Instruct": { per1kTokens: 0.0005 },
    "Llama-4-Scout-17B-16E-Instruct": { per1kTokens: 0.0003 },
    "sam-3.1": { perCall: 0.002 },
    "imagine-v1": { perCall: 0.01 },
};

export const META_DEFAULT_SPARK_MODEL = "Llama-4-Maverick-17B-128E-Instruct";
export const META_DEFAULT_SAM_MODEL = "sam-3.1";
export const META_DEFAULT_IMAGE_MODEL = "imagine-v1";

/** Rough cost estimate for a call. Token counts are approximations. */
export function estimateCost(model: string, promptChars: number, completionChars = 500): number {
    const entry = META_COST_TABLE[model];
    if (!entry) return 0;
    if (entry.perCall !== undefined) return entry.perCall;
    const totalTokens = (promptChars + completionChars) / 4;
    return (totalTokens / 1000) * (entry.per1kTokens ?? 0);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(attempt: number, retryAfter: string | null): number {
    if (retryAfter !== null) {
        const secs = Number(retryAfter);
        if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, META_RETRY_CAP_MS);
    }
    return Math.min(META_RETRY_BASE_MS * 2 ** attempt, META_RETRY_CAP_MS);
}

export function isOfflineMode(explicit?: boolean): boolean {
    if (explicit !== undefined) return explicit;
    if (typeof import.meta !== "undefined" && typeof import.meta.env !== "undefined") {
        return (import.meta.env as Record<string, string | undefined>).VITE_DEMO_OFFLINE === "true";
    }
    return false;
}

function isAbortError(e: unknown): boolean {
    return (
        (e instanceof Error && e.name === "AbortError") ||
        (typeof DOMException !== "undefined" && e instanceof DOMException && e.name === "AbortError")
    );
}

export class MetaClient {
    readonly baseUrl: string;
    private fetchFn: typeof fetch;
    private offline: boolean | undefined;
    private timeoutMs: number;
    private maxRetries: number;
    onEval: ((payload: EvalHookPayload) => void) | null;

    constructor(opts: MetaClientOptions = {}) {
        this.baseUrl = (opts.baseUrl ?? "/api/meta").replace(/\/$/, "");
        this.fetchFn = opts.fetchFn ?? fetch.bind(globalThis);
        this.offline = opts.offline;
        this.timeoutMs = opts.timeoutMs ?? META_TIMEOUT_MS;
        this.maxRetries = opts.maxRetries ?? META_MAX_RETRIES;
        this.onEval = opts.onEval ?? null;
    }

    get offlineMode(): boolean {
        return isOfflineMode(this.offline);
    }

    private report(payload: EvalHookPayload): void {
        if (this.onEval !== null) {
            try {
                this.onEval(payload);
            } catch {
                // Eval hook failures never break the API call path.
            }
        }
    }

    /** Cache layer hit: zero latency, zero cost, cached true, same content hash. */
    reportCacheHit(feature: string, model: string, hash: string, fallback: string | null = "cache"): void {
        this.report({
            feature, model, latencyMs: 0,
            costUsd: 0, costEstimated: true,
            cached: true, ok: true, fallback, hash,
        });
    }

    private checkOffline(feature: string): void {
        if (this.offlineMode) {
            throw new MetaError("offline", `Meta ${feature} is unavailable in offline demo mode`, feature);
        }
    }

    private checkContentLength(res: Response, feature: string): void {
        const declared = typeof res.headers?.get === "function" ? res.headers.get("content-length") : null;
        if (declared !== null && Number(declared) > META_MAX_RESPONSE_BYTES) {
            throw new MetaError("validation", `Meta ${feature} response exceeds size cap`, feature);
        }
    }

    private async readJson(res: Response, feature: string): Promise<unknown> {
        if (typeof res.text === "function") {
            const text = await res.text();
            if (text.length > META_MAX_RESPONSE_BYTES) {
                throw new MetaError("validation", `Meta ${feature} response exceeds size cap`, feature);
            }
            try {
                return JSON.parse(text) as unknown;
            } catch {
                throw new MetaError("validation", `Meta ${feature} returned malformed JSON`, feature);
            }
        }
        const json = await res.json();
        if (JSON.stringify(json).length > META_MAX_RESPONSE_BYTES) {
            throw new MetaError("validation", `Meta ${feature} response exceeds size cap`, feature);
        }
        return json;
    }

    private async postJson(path: string, feature: string, model: string, body: unknown, hash: string): Promise<unknown> {
        this.checkOffline(feature);
        const t0 = Date.now();
        let attempt = 0;
        let lastError: unknown = null;
        while (attempt <= this.maxRetries) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), this.timeoutMs);
            try {
                const res = await this.fetchFn(`${this.baseUrl}${path}`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify(body),
                    signal: controller.signal,
                });
                clearTimeout(timer);
                if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
                    lastError = new MetaError("http", `Meta ${feature} failed with status ${res.status}`, feature, res.status);
                    if (attempt < this.maxRetries) {
                        const retryAfter = typeof res.headers?.get === "function" ? res.headers.get("retry-after") : null;
                        await sleep(retryDelayMs(attempt, retryAfter));
                        attempt += 1;
                        continue;
                    }
                    const latencyMs = Date.now() - t0;
                    this.report({
                        feature, model, latencyMs,
                        costUsd: estimateCost(model, JSON.stringify(body).length),
                        costEstimated: true, cached: false, ok: false, fallback: null, hash,
                    });
                    throw lastError;
                }
                if (!res.ok) {
                    const latencyMs = Date.now() - t0;
                    this.report({
                        feature, model, latencyMs,
                        costUsd: estimateCost(model, JSON.stringify(body).length),
                        costEstimated: true, cached: false, ok: false, fallback: null, hash,
                    });
                    throw new MetaError("http", `Meta ${feature} failed with status ${res.status}`, feature, res.status);
                }
                this.checkContentLength(res, feature);
                const json = await this.readJson(res, feature);
                const latencyMs = Date.now() - t0;
                this.report({
                    feature, model, latencyMs,
                    costUsd: estimateCost(model, JSON.stringify(body).length),
                    costEstimated: true, cached: false, ok: true, fallback: null, hash,
                });
                return json;
            } catch (e) {
                clearTimeout(timer);
                if (e instanceof MetaError) throw e;
                if (isAbortError(e)) {
                    lastError = new MetaError("timeout", `Meta ${feature} timed out after ${this.timeoutMs} ms`, feature);
                } else {
                    lastError = new MetaError("network", `Meta ${feature} network failure: ${e instanceof Error ? e.message : String(e)}`, feature);
                }
                if (attempt < this.maxRetries) {
                    await sleep(retryDelayMs(attempt, null));
                    attempt += 1;
                    continue;
                }
                const latencyMs = Date.now() - t0;
                this.report({
                    feature, model, latencyMs, costUsd: 0,
                    costEstimated: true, cached: false, ok: false, fallback: null, hash,
                });
                throw lastError;
            }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    /**
     * Chat completion parsed as JSON and checked with validate. Standard mode
     * only (no contributor tier). The proxy injects the server key.
     */
    async chatJson<T>(
        feature: string,
        system: string,
        user: string,
        validate: (raw: unknown) => T,
        opts: { model?: string; temperature?: number; reasoningEffort?: string; hash?: string } = {}
    ): Promise<T> {
        const model = opts.model ?? META_DEFAULT_SPARK_MODEL;
        const body = {
            model,
            mode: "standard",
            temperature: opts.temperature ?? 0,
            reasoning_effort: opts.reasoningEffort ?? "low",
            response_format: { type: "json_schema", json_schema: { name: "gearflow_result", strict: true } },
            messages: [
                { role: "system", content: system },
                { role: "user", content: user },
            ],
        };
        const json = await this.postJson("/chat/completions", feature, model, body, opts.hash ?? feature);
        const content = extractContent(json, feature);
        let parsed: unknown;
        try {
            parsed = JSON.parse(content);
        } catch {
            throw new MetaError("validation", `Meta ${feature} returned non-JSON content`, feature);
        }
        try {
            return validate(parsed);
        } catch (e) {
            throw new MetaError(
                "validation",
                `Meta ${feature} response failed validation: ${e instanceof Error ? e.message : String(e)}`,
                feature
            );
        }
    }

    /** SAM 3.1 streaming segmentation over an uploaded sketch. */
    async segment(imageBytes: ArrayBuffer, feature = "sam", model = META_DEFAULT_SAM_MODEL): Promise<unknown> {
        this.checkOffline(feature);
        if (imageBytes.byteLength > META_MAX_SEGMENT_BYTES) {
            throw new MetaError("validation", `Meta ${feature} sketch exceeds size cap`, feature);
        }
        const t0 = Date.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const bytes = new Uint8Array(imageBytes);
            let binary = "";
            const chunk = 8192;
            for (let i = 0; i < bytes.length; i += chunk) {
                binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
            }
            const res = await this.fetchFn(`${this.baseUrl}/sam/segment`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ model, mode: "standard", image_b64: btoa(binary) }),
                signal: controller.signal,
            });
            clearTimeout(timer);
            if (!res.ok) {
                this.report({
                    feature, model, latencyMs: Date.now() - t0, costUsd: estimateCost(model, 0),
                    costEstimated: true, cached: false, ok: false, fallback: "bbox", hash: feature,
                });
                throw new MetaError("http", `Meta ${feature} failed with status ${res.status}`, feature, res.status);
            }
            this.checkContentLength(res, feature);
            const json = await this.readJson(res, feature);
            this.report({
                feature, model, latencyMs: Date.now() - t0, costUsd: estimateCost(model, 0),
                costEstimated: true, cached: false, ok: true, fallback: null, hash: feature,
            });
            return json;
        } catch (e) {
            clearTimeout(timer);
            if (e instanceof MetaError) throw e;
            if (isAbortError(e)) {
                throw new MetaError("timeout", `Meta ${feature} timed out after ${this.timeoutMs} ms`, feature);
            }
            throw new MetaError("network", `Meta ${feature} network failure: ${e instanceof Error ? e.message : String(e)}`, feature);
        }
    }

    /** Labeled illustrative poster render. Session guarded by the caller. */
    async image(prompt: string, feature = "poster", model = META_DEFAULT_IMAGE_MODEL): Promise<string> {
        const json = await this.postJson(
            "/images/generations",
            feature,
            model,
            { model, mode: "standard", prompt, n: 1, size: "1024x1024" },
            feature
        );
        const url = extractImageUrl(json);
        if (url === null) throw new MetaError("validation", `Meta ${feature} returned no image url`, feature);
        return url;
    }
}

export function extractContent(json: unknown, feature = "chat"): string {
    const root = json as Record<string, unknown>;
    const choices = root.choices as Array<Record<string, unknown>> | undefined;
    const message = choices?.[0]?.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content.map((part) => (typeof part === "object" && part !== null ? String((part as Record<string, unknown>).text ?? "") : "")).join("");
    }
    throw new MetaError("validation", "Meta chat response has no message content", feature);
}

export function extractImageUrl(json: unknown): string | null {
    const root = json as Record<string, unknown>;
    const data = root.data as Array<Record<string, unknown>> | undefined;
    const url = data?.[0]?.url;
    if (typeof url === "string" && url.length > 0) {
        if (url.length > META_MAX_POSTER_URL_CHARS) return null;
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            return null;
        }
        if (parsed.protocol !== "https:") return null;
        return url;
    }
    const b64 = data?.[0]?.b64_json;
    if (typeof b64 === "string" && b64.length > 0) {
        if (b64.length > META_MAX_POSTER_B64_CHARS) return null;
        if (!/^[A-Za-z0-9+/=]+$/.test(b64)) return null;
        if (b64.length % 4 !== 0) return null;
        return `data:image/png;base64,${b64}`;
    }
    return null;
}
