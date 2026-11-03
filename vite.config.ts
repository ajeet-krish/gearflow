import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import type { Connect, ViteDevServer } from "vite";
import {
    META_PROXY_MAX_BODY_BYTES,
    META_PROXY_MAX_RESPONSE_BYTES,
    META_PROXY_TIMEOUT_MS,
    g_proxyRateLimiter,
    isAllowedMetaRequest,
    isSameOriginRequest,
} from "./src/meta/proxyGate";
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
} from "./src/agent/modalGate";

const META_API_BASE = "https://api.meta.ai/v1";

/**
 * Same origin Meta proxy. Reads the server only META_API_KEY from the dev
 * process environment and injects it as a Bearer token, so the key never
 * reaches the browser bundle. Allowlisted to POST on three paths only,
 * same origin checked, per-IP rate limited, body capped at 10 MiB (413
 * over), upstream timeout, response byte cap, generic errors only.
 */
function metaProxy() {
    const handler: Connect.NextHandleFunction = (req, res, next) => {
        if (!req.url || !req.url.startsWith("/api/meta")) {
            next();
            return;
        }
        if (!isAllowedMetaRequest(req.method, req.url)) {
            res.statusCode = req.method !== "POST" ? 405 : 404;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "not found" }));
            return;
        }
        if (!isSameOriginRequest(req.headers as Record<string, string | undefined>, req.headers.host)) {
            res.statusCode = 403;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "not found" }));
            return;
        }
        const ip = (req.socket?.remoteAddress ?? "local").toString();
        if (!g_proxyRateLimiter.allow(ip)) {
            res.statusCode = 429;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "rate limited, retry later" }));
            return;
        }
        const key = process.env.META_API_KEY;
        if (!key) {
            res.statusCode = 503;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "Meta service unavailable" }));
            return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        let rejected = false;
        req.on("data", (chunk: Buffer) => {
            if (rejected) return;
            received += chunk.length;
            if (received > META_PROXY_MAX_BODY_BYTES) {
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
            const suffix = req.url!.slice("/api/meta".length) || "/";
            const target = `${META_API_BASE}${suffix}`;
            const headers: Record<string, string> = { authorization: `Bearer ${key}` };
            const contentType = req.headers["content-type"];
            if (typeof contentType === "string") headers["content-type"] = contentType;
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), META_PROXY_TIMEOUT_MS);
            fetch(target, {
                method: "POST",
                headers,
                body: Buffer.concat(chunks),
                signal: controller.signal,
            })
                .then(async (upstream) => {
                    clearTimeout(timer);
                    const declared = upstream.headers.get("content-length");
                    if (declared !== null && Number(declared) > META_PROXY_MAX_RESPONSE_BYTES) {
                        res.statusCode = 502;
                        res.setHeader("content-type", "application/json");
                        res.end(JSON.stringify({ error: "upstream response too large" }));
                        return;
                    }
                    const buf = Buffer.from(await upstream.arrayBuffer());
                    if (buf.length > META_PROXY_MAX_RESPONSE_BYTES) {
                        res.statusCode = 502;
                        res.setHeader("content-type", "application/json");
                        res.end(JSON.stringify({ error: "upstream response too large" }));
                        return;
                    }
                    res.statusCode = upstream.status;
                    const upstreamType = upstream.headers.get("content-type");
                    if (upstreamType) res.setHeader("content-type", upstreamType);
                    const upstreamRetry = upstream.headers.get("retry-after");
                    if (upstreamRetry) res.setHeader("retry-after", upstreamRetry);
                    res.end(buf);
                })
                .catch(() => {
                    clearTimeout(timer);
                    res.statusCode = 502;
                    res.setHeader("content-type", "application/json");
                    res.end(JSON.stringify({ error: "Meta service unavailable" }));
                });
        });
    };
    return {
        name: "gearflow-meta-proxy",
        configureServer(server: ViteDevServer) {
            server.middlewares.use(handler);
        },
        configurePreviewServer(server: { middlewares: { use: (h: Connect.NextHandleFunction) => void } }) {
            server.middlewares.use(handler);
        },
    };
}

/**
 * Same origin Modal proxy for Muse Spark. Reads the server only
 * MODAL_PROXY_TOKEN from the dev process environment and injects it as
 * a Bearer token, so the token never reaches the browser bundle.
 * Allowlisted to POST on the single pinned chat completions path, same
 * origin checked, per-IP rate limited, body capped at 64 KiB (413 over),
 * upstream 30 s total plus idle stream deadline kept through the read
 * loop with close driven abort and reader cancel, response capped at
 * MODAL_MAX_RESPONSE_BYTES on the non stream path (502 over), pinned
 * model id forced into the forwarded body, non 2xx upstream mapped to
 * generic errors with only retry-after forwarded, SSE passthrough with
 * write drain respected, generic errors only. Modal-only: a missing or
 * hostile MODAL_CHAT_URL fails closed to 503, never falls back.
 */
export interface ModalProxyDeps {
    fetchFn?: typeof fetch;
    /** Override the Authorization headers (Modal Bearer proxy token route).
     *  When omitted, the server only MODAL_PROXY_TOKEN Bearer is used.
     *  Server-trusted test-only override: tests inject a fake Bearer so no
     *  live token is needed; production passes no override. */
    getAuthHeaders?: () => Record<string, string> | undefined;
    /** Override the resolved upstream URL (fake upstreams in tests). When
     *  omitted, MODAL_CHAT_URL resolves through the shared helper and a
     *  missing or hostile value fails closed to 503. Server-trusted
     *  test-only override: validated against the Modal allowlist before
     *  use, hostile values fall back to the resolved URL. Production uses
     *  defaults. */
    upstreamUrl?: string;
    limiter?: { allow: (ip: string) => boolean };
    timeoutMs?: number;
    maxResponseBytes?: number;
}

function writeGenericModalError(
    res: Parameters<Connect.NextHandleFunction>[1],
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
 *  upstream status, retry-after presence, and the first 300 chars of the
 *  upstream body. Never logs Authorization tokens or request bodies. */
function logModalUpstreamFailure(
    upstreamStatus: number | string,
    upstreamRetryAfter: string | null,
    upstreamBodyPreview: string,
    fetchDetail = ""
): void {
    try {
        const retry = upstreamRetryAfter ? "yes" : "no";
        const preview = (upstreamBodyPreview ?? "").slice(0, 300);
        const suffix = fetchDetail ? ` error=${fetchDetail.slice(0, 300)}` : "";
        console.error(`[modal-upstream] status=${upstreamStatus} retry-after=${retry} body=${preview}${suffix}`);
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

export function modalProxy(deps: ModalProxyDeps = {}): {
    name: string;
    configureServer: (server: ViteDevServer) => void;
    configurePreviewServer: (server: { middlewares: { use: (h: Connect.NextHandleFunction) => void } }) => void;
} {
    const fetchFn = deps.fetchFn ?? fetch;
    const limiter = deps.limiter ?? g_modalRateLimiter;
    const timeoutMs = deps.timeoutMs ?? MODAL_TIMEOUT_MS;
    const maxResponseBytes = deps.maxResponseBytes ?? MODAL_MAX_RESPONSE_BYTES;
    const handler: Connect.NextHandleFunction = (req, res, next) => {
        if (!req.url || !req.url.startsWith("/api/modal")) {
            next();
            return;
        }
        if (!isModalPath(req.method, req.url)) {
            res.statusCode = req.method !== "POST" ? 405 : 404;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "not found" }));
            return;
        }
        if (!isSameOriginRequest(req.headers as Record<string, string | undefined>, req.headers.host)) {
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
        const ip = (req.socket?.remoteAddress ?? "local").toString();
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
            const totalTimer = setTimeout(() => {
                controller.abort();
                try {
                    void readerRef?.cancel();
                } catch {
                    // Abort driven cancel is best effort.
                }
            }, timeoutMs);
            const onClose = (): void => {
                if (settled) return;
                controller.abort();
                try {
                    void readerRef?.cancel();
                } catch {
                    // Close driven cancel is best effort.
                }
            };
            req.on("close", onClose);
            const finish = (): void => {
                if (settled) return;
                settled = true;
                clearTimeout(totalTimer);
                if (idleTimer !== undefined) clearTimeout(idleTimer);
                req.removeListener("close", onClose);
            };
            let idleTimer: ReturnType<typeof setTimeout> | undefined;
            const pokeIdle = (reader: { cancel: () => unknown }): void => {
                if (idleTimer !== undefined) clearTimeout(idleTimer);
                idleTimer = setTimeout(() => {
                    controller.abort();
                    try {
                        void reader.cancel();
                    } catch {
                        // Idle deadline cancel is best effort.
                    }
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
                        logModalUpstreamFailure(upstream.status, upstreamRetry, preview);
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
                                        controller.abort();
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
                                        await new Promise<void>((resolve) => {
                                            res.once("drain", () => resolve());
                                        });
                                    }
                                    if (res.destroyed) break;
                                }
                                try {
                                    reader.releaseLock();
                                } catch {
                                    // Reader cleanup is best effort only.
                                }
                                if (overCap && forwardedBytes === 0) {
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
                    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
                    logModalUpstreamFailure("fetch-error", null, "", detail);
                    finish();
                    if (!res.writableEnded) {
                        res.statusCode = 502;
                        res.setHeader("content-type", "application/json");
                        res.end(JSON.stringify({ error: "Modal service unavailable" }));
                    }
                });
        });
    };
    return {
        name: "gearflow-modal-proxy",
        configureServer(server: ViteDevServer) {
            server.middlewares.use(handler);
        },
        configurePreviewServer(server: { middlewares: { use: (h: Connect.NextHandleFunction) => void } }) {
            server.middlewares.use(handler);
        },
    };
}

export default defineConfig({
    // Relative asset URLs so the built app serves from both a domain root
    // and a project subpath (owner.github.io/repo/). Surrogate fetches and
    // the ORT wasm prefix stay relative to the document base by construction.
    base: "./",
    plugins: [react(), metaProxy(), modalProxy()],
    worker: {
        format: "es",
    },
    build: {
        chunkSizeWarningLimit: 900,
        rollupOptions: {
            output: {
                manualChunks: {
                    three: ["three"],
                    react: ["react", "react-dom"],
                },
            },
        },
    },
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "src"),
        },
    },
    server: {
        port: 5173,
    },
});
