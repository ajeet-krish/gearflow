// Modal Vercel serverless handler factory. Mirrors the vite dev
// modalProxy gate order so local and prod share one contract: path
// allowlist, same origin, optional required origin, kill switch, per IP
// rate limit, proxy token, 64 KiB body cap, JSON parse, pinned model
// force, upstream fetch with total plus idle deadlines, generic errors
// only, SSE passthrough with drain and res-close driven cancel
// (writableFinished guard), 1 MiB non
// stream cap. Modal-only: the upstream resolves from MODAL_CHAT_URL and
// fails closed to 503, never falls back. Imports only the gate modules
// plus node:http types, never vite.config.

import type { IncomingMessage, ServerResponse } from "node:http";
import {
    MODAL_DISABLED_MESSAGE,
    MODAL_MAX_BODY_BYTES,
    MODAL_MAX_RESPONSE_BYTES,
    MODAL_TIMEOUT_MS,
    forceModel,
    g_modalRateLimiter,
    isAllowedModalUpstreamUrl,
    isModalDisabled,
    isModalPath,
    resolveModalUpstreamUrl,
    toGenericError,
} from "./modalGate.js";
import { isSameOriginRequest } from "../meta/proxyGate.js";

export interface ModalServerHandlerDeps {
    fetchFn?: typeof fetch;
    /** Override the Authorization headers (Modal Bearer proxy token route).
     *  When omitted, the server only MODAL_PROXY_TOKEN Bearer is used.
     *  Never bundled, never logged.
     *  Server-trusted test-only override: tests inject a fake Bearer so no
     *  live token is needed; production passes no override. */
    getAuthHeaders?: () => Record<string, string> | undefined;
    /** Override the resolved upstream URL (fake upstreams in tests). When
     *  omitted, MODAL_CHAT_URL resolves through the shared helper and a
     *  missing or hostile value fails closed to 503. Server-trusted
     *  test-only override: validated against the Modal allowlist before
     *  use, hostile values fall back to the resolved URL. Production
     *  passes no override (api route passes none). */
    upstreamUrl?: string;
    limiter?: { allow: (ip: string) => boolean };
    timeoutMs?: number;
    maxResponseBytes?: number;
    /** When true, requests without Origin or Referer are rejected with 403.
     *  The Vercel adapter sets this; tests and local default to false. */
    requireOrigin?: boolean;
}

/** Client IP for rate limiting: platform trusted x-real-ip first, then
 *  the socket address. x-forwarded-for is client controlled and is never
 *  trusted here, so spoofed values cannot slice or flood the limiter.
 *  Pure header read, never throws. */
export function getModalClientIp(req: IncomingMessage): string {
    try {
        const real = req.headers["x-real-ip"];
        const rawReal = Array.isArray(real) ? real[0] : real;
        if (typeof rawReal === "string" && rawReal.trim().length > 0) {
            return rawReal.trim().slice(0, 128);
        }
    } catch {
        // Header read failed, fall through to the socket address.
    }
    try {
        return (req.socket?.remoteAddress ?? "local").toString().slice(0, 128) || "local";
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

function writeGenericModalError(
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

/** Minimal server side log for Modal upstream failures. Logs only the
 *  upstream status, retry-after presence, elapsed wall time, and the first
 *  300 chars of the upstream body plus a cause prefixed fetch detail
 *  (total-timeout, res-close, idle-timeout, or fetch-error).
 *  Never logs Authorization tokens or request bodies. */
function logModalUpstreamFailure(
    upstreamStatus: number | string,
    upstreamRetryAfter: string | null,
    upstreamBodyPreview: string,
    fetchDetail = "",
    elapsedMs?: number
): void {
    try {
        const retry = upstreamRetryAfter ? "yes" : "no";
        const preview = (upstreamBodyPreview ?? "").slice(0, 300);
        const elapsed =
            typeof elapsedMs === "number" && Number.isFinite(elapsedMs)
                ? ` elapsedMs=${Math.max(0, Math.round(elapsedMs))}`
                : "";
        const suffix = fetchDetail ? ` error=${fetchDetail.slice(0, 300)}` : "";
        console.error(`[modal-upstream] status=${upstreamStatus} retry-after=${retry}${elapsed} body=${preview}${suffix}`);
    } catch {
        // Logging never throws.
    }
}

async function readUpstreamPreview(upstream: Response): Promise<string> {
    try {
        const text = await upstream.text();
        return text.slice(0, 300);
    } catch {
        return "";
    }
}

/** Build a Node (req, res) handler for the pinned chat completions path. */
export function createModalServerHandler(
    deps: ModalServerHandlerDeps = {}
): (req: IncomingMessage, res: ServerResponse) => void {
    const fetchFn = deps.fetchFn ?? fetch;
    const limiter = deps.limiter ?? g_modalRateLimiter;
    const timeoutMs = deps.timeoutMs ?? MODAL_TIMEOUT_MS;
    const maxResponseBytes = deps.maxResponseBytes ?? MODAL_MAX_RESPONSE_BYTES;
    const requireOrigin = deps.requireOrigin ?? false;
    return (req, res) => {
        const method = req.method ?? "GET";
        const url = req.url ?? "";
        if (!isModalPath(method, url)) {
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
        if (isModalDisabled(process.env.MODAL_DISABLED)) {
            res.statusCode = 503;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: MODAL_DISABLED_MESSAGE }));
            return;
        }
        const ip = getModalClientIp(req);
        if (!limiter.allow(ip)) {
            res.statusCode = 429;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "rate limited, retry later" }));
            return;
        }
        // Modal-only upstream: MODAL_CHAT_URL through the shared helper,
        // fail closed to 503 when missing or hostile. A server-trusted
        // test-only override may substitute a fake upstream, validated
        // against the Modal allowlist first.
        const resolved = resolveModalUpstreamUrl();
        let upstreamUrl = resolved;
        if (deps.upstreamUrl !== undefined && isAllowedModalUpstreamUrl(deps.upstreamUrl)) {
            upstreamUrl = deps.upstreamUrl.trim();
        }
        if (upstreamUrl === null) {
            res.statusCode = 503;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "Modal service unavailable" }));
            return;
        }
        const buildDefaultAuthHeaders = (): Record<string, string> | undefined => {
            const token = process.env.MODAL_PROXY_TOKEN;
            if (!token) return undefined;
            return { authorization: `Bearer ${token}` };
        };
        const authHeaders = deps.getAuthHeaders !== undefined ? deps.getAuthHeaders() : buildDefaultAuthHeaders();
        if (
            authHeaders === undefined ||
            typeof authHeaders.authorization !== "string" ||
            authHeaders.authorization.length === 0
        ) {
            res.statusCode = 503;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "Modal service unavailable" }));
            return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        let rejected = false;
        req.on("data", (chunk: Buffer) => {
            if (rejected) return;
            received += chunk.length;
            if (received > MODAL_MAX_BODY_BYTES) {
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
            const startMs = Date.now();
            let payload: unknown;
            try {
                payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
            } catch {
                res.statusCode = 400;
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ error: "invalid request" }));
                return;
            }
            const forced = forceModel(payload);
            const requestedStream =
                typeof payload === "object" &&
                payload !== null &&
                (payload as Record<string, unknown>).stream === true;
            const controller = new AbortController();
            let settled = false;
            let readerRef: { cancel: () => unknown } | null = null;
            let abortCause: string | null = null;
            const noteAbort = (cause: string): void => {
                if (abortCause === null) abortCause = cause;
            };
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
                noteAbort("total-timeout");
                abortUpstream();
            }, timeoutMs);
            const onResClose = (): void => {
                if (settled) return;
                try {
                    if ((res as unknown as { writableFinished?: boolean }).writableFinished) return;
                } catch {
                    // writableFinished read is best effort, assume client went away.
                }
                noteAbort("res-close");
                abortUpstream();
                finish();
            };
            try {
                res.on("close", onResClose);
            } catch {
                // Old test doubles may lack res.on; timers still guard the upstream.
            }
            const finish = (): void => {
                if (settled) return;
                settled = true;
                clearTimeout(totalTimer);
                if (idleTimer !== undefined) clearTimeout(idleTimer);
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
                    noteAbort("idle-timeout");
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
                        const preview = await readUpstreamPreview(upstream);
                        try {
                            await upstream.body?.cancel();
                        } catch {
                            // Error path body cancel is best effort.
                        }
                        logModalUpstreamFailure(upstream.status, upstreamRetry, preview, "", Date.now() - startMs);
                        finish();
                        writeGenericModalError(res, upstream.status, upstreamRetry);
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
                                let streamedBytes = 0;
                                let forwardedBytes = 0;
                                let overCap = false;
                                for (;;) {
                                    let read: ReadableStreamReadResult<Uint8Array>;
                                    try {
                                        read = await reader.read();
                                    } catch {
                                        break;
                                    }
                                    if (read.done) break;
                                    pokeIdle(readerRef);
                                    streamedBytes += read.value.length;
                                    if (streamedBytes > maxResponseBytes) {
                                        overCap = true;
                                        abortUpstream();
                                        try {
                                            await reader.cancel();
                                        } catch {
                                            // Over cap cancel is best effort.
                                        }
                                        break;
                                    }
                                    const chunk = Buffer.from(read.value);
                                    forwardedBytes += chunk.length;
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
                                if (overCap && forwardedBytes === 0) {
                                    // Nothing forwarded yet so headers have not
                                    // flushed: surface the generic 502 cap error.
                                    finish();
                                    res.statusCode = 502;
                                    res.setHeader("content-type", "application/json");
                                    res.end(JSON.stringify({ error: "upstream response too large" }));
                                    return;
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
                .catch((err: unknown) => {
                    const rawDetail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
                    const cause = abortCause ?? "fetch-error";
                    const detail = `${cause}: ${rawDetail}`;
                    logModalUpstreamFailure("fetch-error", null, "", detail, Date.now() - startMs);
                    finish();
                    if (!res.writableEnded) {
                        res.statusCode = 502;
                        res.setHeader("content-type", "application/json");
                        res.end(JSON.stringify({ error: "Modal service unavailable" }));
                    }
                });
        });
    };
}
