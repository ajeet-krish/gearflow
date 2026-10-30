// Baseten chat client for Muse Spark. All browser calls go through the
// same origin proxy at /api/baseten so the server only BASETEN_API_KEY
// never reaches the bundle. Non streaming chat plus SSE streamChat, 15 s
// timeout with one retry before the first token only, fenced JSON envelope
// parsing, and an eval hook reporting model, latency, usage, and cost.

import {
    BASETEN_MAX_TOKENS,
    BASETEN_MODEL_ID,
    BASETEN_PATH,
    forceModel,
    isRetryable,
} from "./basetenGate";

export type BasetenErrorCode = "offline" | "timeout" | "abort" | "http" | "validation" | "network";

export class BasetenError extends Error {
    code: BasetenErrorCode;
    status: number | null;
    retryable: boolean;
    constructor(code: BasetenErrorCode, message: string, status: number | null = null, retryable = false) {
        super(message);
        this.name = "BasetenError";
        this.code = code;
        this.status = status;
        this.retryable = retryable;
    }
}

export interface BasetenMessage {
    role: "system" | "user" | "assistant";
    content: string;
}

export interface BasetenUsage {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
}

export interface BasetenEvalPayload {
    feature: string;
    model: string;
    latencyMs: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    costUsd: number;
    ok: boolean;
}

export interface BasetenClientOptions {
    baseUrl?: string;
    fetchFn?: typeof fetch;
    offline?: boolean;
    timeoutMs?: number;
    onEval?: (payload: BasetenEvalPayload) => void;
}

export interface BasetenChatOptions {
    feature?: string;
    maxTokens?: number;
    temperature?: number;
    signal?: AbortSignal;
    timeoutMs?: number;
}

export interface BasetenChatResult {
    text: string;
    action: unknown;
    model: string;
    usage: BasetenUsage;
    costUsd: number;
    latencyMs: number;
}

export interface BasetenStreamChunk {
    delta: string;
    text: string;
    done: boolean;
}

export const BASETEN_TIMEOUT_MS = 15000;
export const BASETEN_RETRY_CAP_MS = 8000;
export const BASETEN_RETRY_DEFAULT_MS = 500;
export const BASETEN_PRICE_INPUT_PER_M = 1.25;
export const BASETEN_PRICE_CACHED_PER_M = 0.15;
export const BASETEN_PRICE_OUTPUT_PER_M = 4.25;

/** Cost estimate in USD from token counts using pinned per million rates. */
export function estimateBasetenCost(inputTokens: number, outputTokens: number, cachedTokens = 0): number {
    const safe = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0);
    const input = safe(inputTokens);
    const output = safe(outputTokens);
    const cached = Math.min(safe(cachedTokens), input);
    return (
        ((input - cached) * BASETEN_PRICE_INPUT_PER_M) / 1_000_000 +
        (cached * BASETEN_PRICE_CACHED_PER_M) / 1_000_000 +
        (output * BASETEN_PRICE_OUTPUT_PER_M) / 1_000_000
    );
}

/**
 * Extract the fenced action envelope. Prefers action-json fences in order,
 * falling through to the next candidate when one fence holds malformed
 * JSON, then a plain json fence, then raw text. Throws a validation
 * BasetenError when nothing parses.
 */
export function extractActionJson(text: string): unknown {
    const actionRe = /```action-json\s*([\s\S]*?)```/g;
    let malformedAction = false;
    for (const match of text.matchAll(actionRe)) {
        try {
            return JSON.parse(match[1].trim()) as unknown;
        } catch {
            malformedAction = true;
            continue;
        }
    }
    const generic = text.match(/```json\s*([\s\S]*?)```/);
    if (generic !== null) {
        try {
            return JSON.parse(generic[1].trim()) as unknown;
        } catch {
            throw new BasetenError("validation", "Baseten reply envelope was not valid JSON");
        }
    }
    try {
        return JSON.parse(text.trim()) as unknown;
    } catch {
        throw new BasetenError("validation", malformedAction ? "Baseten reply envelope was not valid JSON" : "Baseten reply envelope was not valid JSON");
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepAbortable(ms: number, signal: AbortSignal | undefined): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(new BasetenError("abort", "Baseten request was aborted"));
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = (): void => {
            clearTimeout(timer);
            reject(new BasetenError("abort", "Baseten request was aborted"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

/**
 * Retry delay from a retry-after value. Accepts delay seconds or an HTTP
 * date, clamps to BASETEN_RETRY_CAP_MS, and falls back to a bounded
 * default backoff when the header is absent or unparsable.
 */
export function retryDelayMs(retryAfter: string | null, now = Date.now()): number {
    if (retryAfter !== null) {
        const trimmed = retryAfter.trim();
        if (trimmed.length > 0) {
            const secs = Number(trimmed);
            if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, BASETEN_RETRY_CAP_MS);
            const when = Date.parse(trimmed);
            if (Number.isFinite(when)) return Math.min(Math.max(when - now, 0), BASETEN_RETRY_CAP_MS);
        }
    }
    return Math.min(BASETEN_RETRY_DEFAULT_MS, BASETEN_RETRY_CAP_MS);
}

export function isBasetenOffline(explicit?: boolean): boolean {
    if (explicit !== undefined) return explicit;
    if (typeof import.meta !== "undefined" && typeof import.meta.env !== "undefined") {
        return (import.meta.env as Record<string, string | undefined>).VITE_DEMO_OFFLINE === "true";
    }
    return false;
}

/**
 * Validate a Baseten proxy base URL. Allows same origin relative paths
 * (single leading slash, no query, fragment, or dot segments) and http or
 * https absolute URLs without credentials, query, or fragment. Anything
 * else (other schemes, protocol relative URLs, hostile env values) is
 * rejected so the caller falls back to the same origin default.
 */
export function isSafeBasetenBaseUrl(candidate: string): boolean {
    if (candidate.length === 0 || candidate.length > 2048) return false;
    if (/[\s\\]/.test(candidate)) return false;
    if (candidate.includes("?") || candidate.includes("#")) return false;
    if (candidate.startsWith("/")) {
        if (candidate.startsWith("//")) return false;
        if (candidate.split("/").some((seg) => seg === "." || seg === "..")) return false;
        return true;
    }
    let parsed: URL;
    try {
        parsed = new URL(candidate);
    } catch {
        return false;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    if (parsed.username.length > 0 || parsed.password.length > 0) return false;
    if (parsed.search.length > 0 || parsed.hash.length > 0) return false;
    if (parsed.host.length === 0) return false;
    // Check the raw path text too: URL normalizes dot segments away, so
    // /../ in the input would otherwise vanish before the check below.
    const rawPath = candidate.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]*/, "");
    if (rawPath.split("/").some((seg) => seg === "." || seg === "..")) return false;
    if (parsed.pathname.split("/").some((seg) => seg === "." || seg === "..")) return false;
    return true;
}

/**
 * Resolve the Baseten proxy base URL. Precedence is explicit constructor
 * input, then VITE_BASETEN_URL when trimmed non empty, then the same
 * origin default /api/baseten. A single trailing slash is stripped so
 * path appends never double up slashes. Unsafe values (non http schemes,
 * credentials, query, fragment, dot segments) fall back to the default.
 * Public base only, never a key.
 */
export function resolveBasetenBaseUrl(explicit?: string): string {
    const trimmedExplicit = explicit?.trim();
    if (trimmedExplicit !== undefined && trimmedExplicit.length > 0) {
        const stripped = trimmedExplicit.replace(/\/$/, "");
        if (stripped.length === 0) return "/api/baseten";
        if (isSafeBasetenBaseUrl(stripped)) return stripped;
        return "/api/baseten";
    }
    if (typeof import.meta !== "undefined" && typeof import.meta.env !== "undefined") {
        const fromEnv = ((import.meta.env as Record<string, string | undefined>).VITE_BASETEN_URL ?? "").trim();
        if (fromEnv.length > 0) {
            const stripped = fromEnv.replace(/\/$/, "");
            if (stripped.length > 0 && isSafeBasetenBaseUrl(stripped)) {
                return stripped;
            }
        }
    }
    return "/api/baseten";
}

function isAbortError(e: unknown): boolean {
    return (
        (e instanceof Error && e.name === "AbortError") ||
        (typeof DOMException !== "undefined" && e instanceof DOMException && e.name === "AbortError")
    );
}

function readStreamChunk(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    budgetMs: number,
    signal: AbortSignal | undefined
): Promise<ReadableStreamReadResult<Uint8Array>> {
    if (signal?.aborted) {
        return Promise.reject(new BasetenError("abort", "Baseten request was aborted"));
    }
    return new Promise((resolve, reject) => {
        const cleanup = (): void => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
        };
        const timer = setTimeout(() => {
            cleanup();
            try {
                void reader.cancel();
            } catch {
                // Cancel is best effort, the timeout below is authoritative.
            }
            reject(new BasetenError("timeout", "Baseten stream timed out"));
        }, Math.max(budgetMs, 1));
        const onAbort = (): void => {
            cleanup();
            try {
                void reader.cancel();
            } catch {
                // Cancel is best effort, the abort below is authoritative.
            }
            reject(new BasetenError("abort", "Baseten request was aborted"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        reader.read().then(
            (result) => {
                cleanup();
                resolve(result);
            },
            (err: unknown) => {
                cleanup();
                if (signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
                    reject(new BasetenError("abort", "Baseten request was aborted"));
                } else {
                    reject(err);
                }
            }
        );
    });
}

function num(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function readUsage(json: unknown): BasetenUsage {
    const root = (json ?? {}) as Record<string, unknown>;
    const usage = (root.usage ?? {}) as Record<string, unknown>;
    const details = (usage.prompt_tokens_details ?? {}) as Record<string, unknown>;
    const cached = num(details.cached_tokens ?? usage.cached_tokens);
    return {
        inputTokens: num(usage.prompt_tokens ?? usage.input_tokens),
        outputTokens: num(usage.completion_tokens ?? usage.output_tokens),
        cachedTokens: cached,
    };
}

function readText(json: unknown): string {
    const root = json as Record<string, unknown>;
    const choices = root.choices as Array<Record<string, unknown>> | undefined;
    const message = choices?.[0]?.message as Record<string, unknown> | undefined;
    const content = typeof message?.content === "string" ? message.content : "";
    const reasoning = typeof message?.reasoning_content === "string" ? message.reasoning_content : "";
    return `${content}${reasoning}`;
}

/** Map an HTTP status to a typed error. Any 503 (missing key or the
 *  BASETEN_DISABLED kill switch) maps to the offline code, so the console
 *  keeps answering from local state with zero network. */
export function toHttpError(status: number): BasetenError {
    if (status === 503) {
        return new BasetenError("offline", "Baseten service unavailable, running offline", status, true);
    }
    if (status === 404) {
        return new BasetenError("http", "model unavailable, please check model", status, false);
    }
    if (status === 429) {
        return new BasetenError("http", "Baseten rate limited, retry later", status, true);
    }
    if (status === 401) {
        return new BasetenError("http", "Baseten service unavailable", status, false);
    }
    return new BasetenError("http", `Baseten request failed with status ${status}`, status, isRetryable(status));
}

export class BasetenClient {
    readonly baseUrl: string;
    private fetchFn: typeof fetch;
    private offline: boolean | undefined;
    private timeoutMs: number;
    onEval: ((payload: BasetenEvalPayload) => void) | null;

    constructor(opts: BasetenClientOptions = {}) {
        this.baseUrl = resolveBasetenBaseUrl(opts.baseUrl);
        this.fetchFn = opts.fetchFn ?? fetch.bind(globalThis);
        this.offline = opts.offline;
        this.timeoutMs = opts.timeoutMs ?? BASETEN_TIMEOUT_MS;
        this.onEval = opts.onEval ?? null;
    }

    get offlineMode(): boolean {
        return isBasetenOffline(this.offline);
    }

    private report(payload: BasetenEvalPayload): void {
        if (this.onEval !== null) {
            try {
                this.onEval(payload);
            } catch {
                // Eval hook failures never break the API call path.
            }
        }
    }

    private checkOffline(): void {
        if (this.offlineMode) {
            throw new BasetenError("offline", "Baseten chat is unavailable in offline demo mode");
        }
    }

    private buildBody(messages: BasetenMessage[], opts: BasetenChatOptions, stream: boolean): unknown {
        const maxTokens =
            opts.maxTokens === undefined
                ? BASETEN_MAX_TOKENS
                : Math.min(Math.max(Math.floor(opts.maxTokens), 1), BASETEN_MAX_TOKENS);
        return forceModel({
            messages,
            n: 1,
            max_tokens: maxTokens,
            temperature: opts.temperature ?? 0,
            stream,
        });
    }

    private linkSignal(external: AbortSignal | undefined, controller: AbortController): void {
        if (external === undefined) return;
        if (external.aborted) controller.abort();
        else external.addEventListener("abort", () => controller.abort(), { once: true });
    }

    private async doFetch(url: string, body: unknown, timeoutMs: number, external: AbortSignal | undefined): Promise<Response> {
        if (external?.aborted) {
            throw new BasetenError("abort", "Baseten request was aborted");
        }
        const controller = new AbortController();
        this.linkSignal(external, controller);
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await this.fetchFn(url, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
        } finally {
            clearTimeout(timer);
        }
    }

    /** Non streaming chat. One retry on 429 or 5xx before any token arrives,
     * plus one documented retry on a connect timeout before headers. */
    async chat(messages: BasetenMessage[], opts: BasetenChatOptions = {}): Promise<BasetenChatResult> {
        this.checkOffline();
        const feature = opts.feature ?? "chat";
        const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
        const body = this.buildBody(messages, opts, false);
        const t0 = Date.now();
        let attempt = 0;
        for (;;) {
            let res: Response;
            try {
                res = await this.doFetch(`${this.baseUrl}${BASETEN_PATH.slice("/api/baseten".length)}`, body, timeoutMs, opts.signal);
            } catch (e) {
                if (e instanceof BasetenError) throw e;
                if (isAbortError(e)) {
                    if (opts.signal?.aborted) {
                        throw new BasetenError("abort", "Baseten request was aborted");
                    }
                    if (attempt === 0) {
                        attempt += 1;
                        continue;
                    }
                    throw new BasetenError("timeout", `Baseten chat timed out after ${timeoutMs} ms`);
                }
                throw new BasetenError("network", "Baseten network failure");
            }
            if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
                if (attempt === 0) {
                    const retryAfter = typeof res.headers?.get === "function" ? res.headers.get("retry-after") : null;
                    const wait = retryDelayMs(retryAfter);
                    await sleepAbortable(wait, opts.signal);
                    attempt += 1;
                    continue;
                }
                const latencyMs = Date.now() - t0;
                const err = toHttpError(res.status);
                this.report({
                    feature, model: BASETEN_MODEL_ID, latencyMs,
                    inputTokens: 0, outputTokens: 0, cachedTokens: 0,
                    costUsd: 0, ok: false,
                });
                throw err;
            }
            if (!res.ok) {
                const latencyMs = Date.now() - t0;
                const err = toHttpError(res.status);
                this.report({
                    feature, model: BASETEN_MODEL_ID, latencyMs,
                    inputTokens: 0, outputTokens: 0, cachedTokens: 0,
                    costUsd: 0, ok: false,
                });
                throw err;
            }
            let json: unknown;
            try {
                json = await res.json();
            } catch {
                throw new BasetenError("validation", "Baseten reply was not valid JSON");
            }
            const text = readText(json);
            if (text.length === 0) {
                throw new BasetenError("validation", "Baseten reply had no message content");
            }
            let action: unknown = null;
            try {
                action = extractActionJson(text);
            } catch {
                action = null;
            }
            const usage = readUsage(json);
            const costUsd = estimateBasetenCost(usage.inputTokens, usage.outputTokens, usage.cachedTokens);
            const latencyMs = Date.now() - t0;
            this.report({
                feature, model: BASETEN_MODEL_ID, latencyMs,
                inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
                cachedTokens: usage.cachedTokens, costUsd, ok: true,
            });
            return { text, action, model: BASETEN_MODEL_ID, usage, costUsd, latencyMs };
        }
    }

    /**
     * Streaming chat over SSE. Accumulates both delta.content and
     * delta.reasoning_content, stops only after finish_reason plus the
     * terminal DONE line, retries once on 429 or 5xx before the first
     * token only, plus one documented connect timeout retry. The read
     * loop keeps the 15 s idle and total stream deadline wired through
     * every read and cancels the reader when the caller aborts, so a
     * stalled stream cannot hang past the client timeout.
     */
    async *streamChat(messages: BasetenMessage[], opts: BasetenChatOptions = {}): AsyncGenerator<BasetenStreamChunk, BasetenChatResult, void> {
        this.checkOffline();
        const feature = opts.feature ?? "chat";
        const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
        const body = this.buildBody(messages, opts, true);
        const t0 = Date.now();
        let res: Response | null = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                res = await this.doFetch(`${this.baseUrl}${BASETEN_PATH.slice("/api/baseten".length)}`, body, timeoutMs, opts.signal);
            } catch (e) {
                if (e instanceof BasetenError) throw e;
                if (isAbortError(e)) {
                    if (opts.signal?.aborted) {
                        throw new BasetenError("abort", "Baseten request was aborted");
                    }
                    if (attempt === 0) continue;
                    throw new BasetenError("timeout", `Baseten chat timed out after ${timeoutMs} ms`);
                }
                throw new BasetenError("network", "Baseten network failure");
            }
            if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
                if (attempt === 0) {
                    const retryAfter = typeof res.headers?.get === "function" ? res.headers.get("retry-after") : null;
                    const wait = retryDelayMs(retryAfter);
                    await sleepAbortable(wait, opts.signal);
                    continue;
                }
                const err = toHttpError(res.status);
                this.report({
                    feature, model: BASETEN_MODEL_ID, latencyMs: Date.now() - t0,
                    inputTokens: 0, outputTokens: 0, cachedTokens: 0,
                    costUsd: 0, ok: false,
                });
                throw err;
            }
            if (!res.ok) {
                const err = toHttpError(res.status);
                this.report({
                    feature, model: BASETEN_MODEL_ID, latencyMs: Date.now() - t0,
                    inputTokens: 0, outputTokens: 0, cachedTokens: 0,
                    costUsd: 0, ok: false,
                });
                throw err;
            }
            break;
        }
        if (res === null) {
            throw new BasetenError("network", "Baseten network failure");
        }
        let text = "";
        let sawFinish = false;
        let sawDone = false;
        let usage: BasetenUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
        const parseLine = (line: string): void => {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) return;
            const payload = trimmed.slice("data:".length).trim();
            if (payload === "[DONE]") {
                sawDone = true;
                return;
            }
            if (payload.length === 0) return;
            let evt: Record<string, unknown>;
            try {
                evt = JSON.parse(payload) as Record<string, unknown>;
            } catch {
                return;
            }
            const evtUsage = (evt as { usage?: unknown }).usage;
            if (evtUsage !== undefined) usage = readUsage(evt);
            const choices = (evt.choices ?? []) as Array<Record<string, unknown>>;
            const first = choices[0] as Record<string, unknown> | undefined;
            if (first === undefined) return;
            if (first.finish_reason !== null && first.finish_reason !== undefined) sawFinish = true;
            const delta = (first.delta ?? first.message ?? {}) as Record<string, unknown>;
            if (typeof delta.content === "string") text += delta.content;
            if (typeof delta.reasoning_content === "string") text += delta.reasoning_content;
        };
        const emit = function* (delta: string): Generator<BasetenStreamChunk> {
            yield { delta, text, done: false };
        };
        const raw = res.body !== null && typeof (res.body as ReadableStream).getReader === "function"
            ? null
            : await res.text();
        if (raw !== null) {
            const before = text;
            for (const line of raw.split("\n")) parseLine(line);
            const delta = text.slice(before.length);
            if (delta.length > 0) yield* emit(delta);
        } else {
            const reader = (res.body as ReadableStream<Uint8Array>).getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            const streamStart = Date.now();
            let lastActivity = streamStart;
            try {
                for (;;) {
                    if (opts.signal?.aborted) {
                        throw new BasetenError("abort", "Baseten request was aborted");
                    }
                    const idleBudget = timeoutMs - (Date.now() - lastActivity);
                    const totalBudget = timeoutMs - (Date.now() - streamStart);
                    const budget = Math.min(idleBudget, totalBudget);
                    if (budget <= 0) {
                        try {
                            await reader.cancel();
                        } catch {
                            // Cancel is best effort, the timeout below is authoritative.
                        }
                        throw new BasetenError("timeout", `Baseten stream timed out after ${timeoutMs} ms`);
                    }
                    const { done, value } = await readStreamChunk(reader, budget, opts.signal);
                    if (done) break;
                    lastActivity = Date.now();
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split("\n");
                    buffer = lines.pop() ?? "";
                    for (const line of lines) {
                        const before = text;
                        parseLine(line);
                        const delta = text.slice(before.length);
                        if (delta.length > 0) yield { delta, text, done: false };
                    }
                    if (sawDone && sawFinish) break;
                }
            } catch (e) {
                try {
                    await reader.cancel();
                } catch {
                    // Reader cancel on error is best effort.
                }
                throw e;
            }
            const tail = buffer.trim();
            if (tail.length > 0) {
                const before = text;
                parseLine(tail);
                const delta = text.slice(before.length);
                if (delta.length > 0) yield { delta, text, done: false };
            }
            try {
                reader.releaseLock();
            } catch {
                // Reader cleanup is best effort.
            }
        }
        let action: unknown = null;
        try {
            action = extractActionJson(text);
        } catch {
            action = null;
        }
        const costUsd = estimateBasetenCost(usage.inputTokens, usage.outputTokens, usage.cachedTokens);
        const latencyMs = Date.now() - t0;
        this.report({
            feature, model: BASETEN_MODEL_ID, latencyMs,
            inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
            cachedTokens: usage.cachedTokens, costUsd, ok: true,
        });
        yield { delta: "", text, done: true };
        return { text, action, model: BASETEN_MODEL_ID, usage, costUsd, latencyMs };
    }
}
