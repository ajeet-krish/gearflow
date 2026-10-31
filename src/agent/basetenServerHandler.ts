// Baseten Vercel serverless handler factory. Mirrors the vite dev
// basetenProxy gate order so local and prod share one contract: path
// allowlist, same origin, optional required origin, kill switch, per IP
// rate limit, server key, 64 KiB body cap, JSON parse, pinned model force,
// upstream fetch with total plus idle deadlines, generic errors only, SSE
// passthrough with drain and close driven cancel, 1 MiB non stream cap.
// Imports only the gate modules plus node:http types, never vite.config.

import type { IncomingMessage, ServerResponse } from "node:http";
import {
    BASETEN_DISABLED_MESSAGE,
    BASETEN_MAX_BODY_BYTES,
    BASETEN_MAX_RESPONSE_BYTES,
    BASETEN_TIMEOUT_MS,
    forceModel,
    g_basetenRateLimiter,
    isAllowedChatUpstreamUrl,
    isBasetenDisabled,
    isBasetenPath,
    parseChatUpstreamKind,
    resolveChatUpstream,
    resolveChatUpstreamFromEnv,
    toGenericError,
} from "./basetenGate";
import type { ChatUpstreamKind } from "./basetenGate";
import { isSameOriginRequest } from "../meta/proxyGate";

export interface BasetenServerHandlerDeps {
    fetchFn?: typeof fetch;
    getKey?: () => string | undefined;
    /** Override the Authorization headers (Modal Bearer proxy token route).
     *  When omitted, baseten uses getKey Bearer and modal uses the server
     *  only MODAL_PROXY_TOKEN Bearer. Never bundled, never logged.
     *  Server-trusted test-only override: tests inject a fake Bearer so no
     *  live token is needed; production passes no override. */
    getAuthHeaders?: () => Record<string, string> | undefined;
    /** Override the resolved upstream URL (fake upstreams in tests). When
     *  omitted, the shared resolveChatUpstreamFromEnv helper picks the URL
     *  from CHAT_UPSTREAM plus MODAL_CHAT_URL with a Baseten fallback.
     *  Server-trusted test-only override: validated against the effective
     *  kind allowlist before use, hostile values fall back to the resolved
     *  URL. Production passes no override (api route passes none). */
    upstreamUrl?: string;
    /** Kind override for tests; defaults to process.env.CHAT_UPSTREAM.
     *  Server-trusted test-only; production reads the env. */
    chatKind?: unknown;
    /** Modal URL override for tests; defaults to process.env.MODAL_CHAT_URL.
     *  Server-trusted test-only; production reads the env. */
    modalUrl?: unknown;
    limiter?: { allow: (ip: string) => boolean };
    timeoutMs?: number;
    maxResponseBytes?: number;
    /** When true, requests without Origin or Referer are rejected with 403.
     *  The Vercel adapter sets this; tests and local default to false. */
    requireOrigin?: boolean;
}

/** Client IP for rate limiting: first x-forwarded-for entry, then
 *  x-real-ip, then the socket address. Pure header read, never throws. */
export function getBasetenClientIp(req: IncomingMessage): string {
    try {
        const forwarded = req.headers["x-forwarded-for"];
        const rawForwarded = Array.isArray(forwarded) ? forwarded[0] : forwarded;
        if (typeof rawForwarded === "string" && rawForwarded.length > 0) {
            const first = rawForwarded.split(",")[0].trim();
            if (first.length > 0) return first;
        }
        const real = req.headers["x-real-ip"];
        const rawReal = Array.isArray(real) ? real[0] : real;
        if (typeof rawReal === "string" && rawReal.trim().length > 0) {
            return rawReal.trim();
        }
    } catch {
        // Header read failed, fall through to the socket address.
    }
    try {
        return (req.socket?.remoteAddress ?? "local").toString();
    } catch {
        return "local";
    }
}

function hasOriginOrReferer(headers: IncomingMessage["headers"]): boolean {
    const first = (value: string | string[] | undefined): string | undefined =>
        Array.isArray(value) ? value[0] : value;
    const origin = first(headers.origin);
    if (typeof origin === "string" && origin.length > 0) return true;
    const referer = first(headers.referer ?? headers.referrer);
    if (typeof referer === "string" && referer.length > 0) return true;
    return false;
}

function writeGenericBasetenError(
    res: ServerResponse,
    upstreamStatus: number,
    upstreamRetryAfter: string | null
): void {
    const generic = toGenericError(upstreamStatus);
    res.statusCode = generic.status;
    res.setHeader("content-type", "application/json");
    if (upstreamRetryAfter) res.setHeader("retry-after", upstreamRetryAfter);
    res.end(JSON.stringify({ error: generic.message }));
}

/** Build a Node (req, res) handler for the pinned chat completions path. */
export function createBasetenServerHandler(
    deps: BasetenServerHandlerDeps = {}
): (req: IncomingMessage, res: ServerResponse) => void {
    const fetchFn = deps.fetchFn ?? fetch;
    const getKey = deps.getKey ?? ((): string | undefined => process.env.BASETEN_API_KEY);
    const limiter = deps.limiter ?? g_basetenRateLimiter;
    const timeoutMs = deps.timeoutMs ?? BASETEN_TIMEOUT_MS;
    const maxResponseBytes = deps.maxResponseBytes ?? BASETEN_MAX_RESPONSE_BYTES;
    const requireOrigin = deps.requireOrigin ?? false;
    return (req, res) => {
        const method = req.method ?? "GET";
        const url = req.url ?? "";
        if (!isBasetenPath(method, url)) {
            res.statusCode = method !== "POST" ? 405 : 404;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "not found" }));
            return;
        }
        const hostHeader = req.headers.host;
        const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
        if (!isSameOriginRequest(req.headers as Record<string, string | string[] | undefined>, host)) {
            res.statusCode = 403;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "not found" }));
            return;
        }
        if (requireOrigin && !hasOriginOrReferer(req.headers)) {
            res.statusCode = 403;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "not found" }));
            return;
        }
        if (isBasetenDisabled(process.env.BASETEN_DISABLED)) {
            res.statusCode = 503;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: BASETEN_DISABLED_MESSAGE }));
            return;
        }
        const ip = getBasetenClientIp(req);
        if (!limiter.allow(ip)) {
            res.statusCode = 429;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "rate limited, retry later" }));
            return;
        }
        // Env driven default through the shared helper so the handler and
        // the Vite proxy cannot diverge. Dep overrides are server-trusted
        // test-only inputs layered on top for the kind and modal URL.
        const kindInput = deps.chatKind ?? process.env.CHAT_UPSTREAM;
        const modalUrlInput = deps.modalUrl ?? process.env.MODAL_CHAT_URL;
        const resolved =
            deps.chatKind === undefined && deps.modalUrl === undefined
                ? resolveChatUpstreamFromEnv()
                : resolveChatUpstream(kindInput, modalUrlInput);
        // Validate a test-only upstreamUrl override against the effective
        // kind allowlist; hostile values fall back to the resolved URL.
        let effectiveKind: ChatUpstreamKind = resolved.kind;
        let upstreamUrl = resolved.url;
        if (deps.upstreamUrl !== undefined) {
            const candidateKind = parseChatUpstreamKind(kindInput);
            if (isAllowedChatUpstreamUrl(candidateKind, deps.upstreamUrl)) {
                effectiveKind = candidateKind;
                upstreamUrl = deps.upstreamUrl.trim();
            }
        }
        const buildDefaultAuthHeaders = (): Record<string, string> | undefined => {
            if (effectiveKind === "modal") {
                const token = process.env.MODAL_PROXY_TOKEN;
                if (!token) return undefined;
                return { authorization: `Bearer ${token}` };
            }
            const key = getKey();
            if (!key) return undefined;
            return { authorization: `Bearer ${key}` };
        };
        const authHeaders = deps.getAuthHeaders !== undefined ? deps.getAuthHeaders() : buildDefaultAuthHeaders();
        if (
            authHeaders === undefined ||
            typeof authHeaders.authorization !== "string" ||
            authHeaders.authorization.length === 0
        ) {
            res.statusCode = 503;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "Baseten service unavailable" }));
            return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        let rejected = false;
        req.on("data", (chunk: Buffer) => {
            if (rejected) return;
            received += chunk.length;
            if (received > BASETEN_MAX_BODY_BYTES) {
                rejected = true;
                res.statusCode = 413;
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ error: "request body too large" }));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            if (rejected) return;
            let payload: unknown;
            try {
                payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
            } catch {
                res.statusCode = 400;
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ error: "invalid request" }));
                return;
            }
            const forced = forceModel(payload, effectiveKind);
            const requestedStream =
                typeof payload === "object" &&
                payload !== null &&
                (payload as Record<string, unknown>).stream === true;
            const controller = new AbortController();
            let settled = false;
            let readerRef: { cancel: () => unknown } | null = null;
            let streamClosed = false;
            const pendingDrainCloses: Array<() => void> = [];
            const notifyDrainClosed = (): void => {
                for (const notify of pendingDrainCloses.splice(0)) {
                    try {
                        notify();
                    } catch {
                        // Drain close notify is best effort.
                    }
                }
            };
            const abortUpstream = (): void => {
                streamClosed = true;
                controller.abort();
                try {
                    void readerRef?.cancel();
                } catch {
                    // Abort driven cancel is best effort.
                }
                notifyDrainClosed();
            };
            const totalTimer = setTimeout(() => {
                abortUpstream();
            }, timeoutMs);
            const onClose = (): void => {
                if (settled) return;
                abortUpstream();
            };
            const onResClose = (): void => {
                if (settled) return;
                abortUpstream();
                finish();
            };
            req.on("close", onClose);
            try {
                res.on("close", onResClose);
            } catch {
                // Old test doubles may lack res.on; req close still aborts.
            }
            const finish = (): void => {
                if (settled) return;
                settled = true;
                clearTimeout(totalTimer);
                if (idleTimer !== undefined) clearTimeout(idleTimer);
                req.removeListener("close", onClose);
                try {
                    res.removeListener("close", onResClose);
                } catch {
                    // Best effort for doubles without removeListener.
                }
            };
            let idleTimer: ReturnType<typeof setTimeout> | undefined;
            const pokeIdle = (reader: { cancel: () => unknown }): void => {
                if (idleTimer !== undefined) clearTimeout(idleTimer);
                idleTimer = setTimeout(() => {
                    abortUpstream();
                }, timeoutMs);
            };
            fetchFn(upstreamUrl, {
                method: "POST",
                headers: {
                    ...authHeaders,
                    "content-type": "application/json",
                },
                body: JSON.stringify(forced),
                signal: controller.signal,
            })
                .then(async (upstream) => {
                    const upstreamType = upstream.headers.get("content-type") ?? "";
                    const upstreamRetry = upstream.headers.get("retry-after");
                    if (upstream.status < 200 || upstream.status >= 300) {
                        try {
                            await upstream.body?.cancel();
                        } catch {
                            // Error path body cancel is best effort.
                        }
                        finish();
                        writeGenericBasetenError(res, upstream.status, upstreamRetry);
                        return;
                    }
                    const isStream = requestedStream || upstreamType.includes("text/event-stream");
                    if (isStream) {
                        res.statusCode = upstream.status;
                        res.setHeader("content-type", "text/event-stream");
                        res.setHeader("cache-control", "no-cache");
                        res.setHeader("connection", "keep-alive");
                        res.setHeader("x-accel-buffering", "no");
                        if (upstreamRetry) res.setHeader("retry-after", upstreamRetry);
                        try {
                            if (upstream.body) {
                                const reader = upstream.body.getReader();
                                readerRef = reader as unknown as { cancel: () => unknown };
                                pokeIdle(readerRef);
                                for (;;) {
                                    let read: ReadableStreamReadResult<Uint8Array>;
                                    try {
                                        read = await reader.read();
                                    } catch {
                                        break;
                                    }
                                    if (read.done) break;
                                    pokeIdle(readerRef);
                                    const chunk = Buffer.from(read.value);
                                    const ok = res.write(chunk);
                                    if (!ok) {
                                        if (res.destroyed || streamClosed) break;
                                        const drained = await new Promise<boolean>((resolve) => {
                                            let done = false;
                                            const cleanup = (): void => {
                                                const idx = pendingDrainCloses.indexOf(onClosed);
                                                if (idx >= 0) pendingDrainCloses.splice(idx, 1);
                                                try {
                                                    res.removeListener("drain", onDrained);
                                                } catch {
                                                    // Best effort for doubles.
                                                }
                                            };
                                            const onDrained = (): void => {
                                                if (done) return;
                                                done = true;
                                                cleanup();
                                                resolve(true);
                                            };
                                            const onClosed = (): void => {
                                                if (done) return;
                                                done = true;
                                                cleanup();
                                                abortUpstream();
                                                finish();
                                                resolve(false);
                                            };
                                            pendingDrainCloses.push(onClosed);
                                            res.once("drain", onDrained);
                                        });
                                        if (!drained) break;
                                    }
                                    if (res.destroyed || streamClosed) break;
                                }
                                try {
                                    reader.releaseLock();
                                } catch {
                                    // Reader cleanup is best effort only.
                                }
                            }
                            finish();
                            res.end();
                        } catch {
                            finish();
                            try {
                                res.end();
                            } catch {
                                // Client went away mid stream, nothing left to do.
                            }
                        }
                        return;
                    }
                    const declared = upstream.headers.get("content-length");
                    if (declared !== null && Number(declared) > maxResponseBytes) {
                        try {
                            await upstream.body?.cancel();
                        } catch {
                            // Over cap cancel is best effort.
                        }
                        finish();
                        res.statusCode = 502;
                        res.setHeader("content-type", "application/json");
                        res.end(JSON.stringify({ error: "upstream response too large" }));
                        return;
                    }
                    let buf: Buffer;
                    if (upstream.body && typeof upstream.body.getReader === "function") {
                        const reader = upstream.body.getReader();
                        readerRef = reader as unknown as { cancel: () => unknown };
                        const parts: Uint8Array[] = [];
                        let total = 0;
                        let overCap = false;
                        for (;;) {
                            let read: ReadableStreamReadResult<Uint8Array>;
                            try {
                                read = await reader.read();
                            } catch {
                                break;
                            }
                            if (read.done) break;
                            total += read.value.length;
                            if (total > maxResponseBytes) {
                                overCap = true;
                                try {
                                    await reader.cancel();
                                } catch {
                                    // Over cap cancel is best effort.
                                }
                                break;
                            }
                            parts.push(read.value);
                        }
                        try {
                            reader.releaseLock();
                        } catch {
                            // Reader cleanup is best effort only.
                        }
                        if (overCap) {
                            finish();
                            res.statusCode = 502;
                            res.setHeader("content-type", "application/json");
                            res.end(JSON.stringify({ error: "upstream response too large" }));
                            return;
                        }
                        buf = Buffer.concat(parts.map((p) => Buffer.from(p)));
                    } else {
                        buf = Buffer.from(await upstream.arrayBuffer());
                        if (buf.length > maxResponseBytes) {
                            finish();
                            res.statusCode = 502;
                            res.setHeader("content-type", "application/json");
                            res.end(JSON.stringify({ error: "upstream response too large" }));
                            return;
                        }
                    }
                    finish();
                    res.statusCode = upstream.status;
                    if (upstreamType) res.setHeader("content-type", upstreamType);
                    if (upstreamRetry) res.setHeader("retry-after", upstreamRetry);
                    res.end(buf);
                })
                .catch(() => {
                    finish();
                    if (!res.writableEnded) {
                        res.statusCode = 502;
                        res.setHeader("content-type", "application/json");
                        res.end(JSON.stringify({ error: "Baseten service unavailable" }));
                    }
                });
        });
    };
}
