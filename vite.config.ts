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
    BASETEN_MAX_BODY_BYTES,
    BASETEN_MAX_RESPONSE_BYTES,
    BASETEN_TIMEOUT_MS,
    BASETEN_UPSTREAM_URL,
    forceModel,
    g_basetenRateLimiter,
    isBasetenPath,
    toGenericError,
} from "./src/agent/basetenGate";

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
 * Same origin Baseten proxy for Muse Spark. Reads the server only
 * BASETEN_API_KEY from the dev process environment and injects it as a
 * Bearer token, so the key never reaches the browser bundle. Allowlisted
 * to POST on the single pinned chat completions path, same origin
 * checked, per-IP rate limited, body capped at 64 KiB (413 over),
 * upstream 30 s total plus idle stream deadline kept through the read
 * loop with close driven abort and reader cancel, response capped at
 * BASETEN_MAX_RESPONSE_BYTES on the non stream path (502 over), pinned
 * model id forced into the forwarded body, non 2xx upstream mapped to
 * generic errors with only retry-after forwarded, SSE passthrough with
 * write drain respected, generic errors only.
 */
export interface BasetenProxyDeps {
    fetchFn?: typeof fetch;
    getKey?: () => string | undefined;
    limiter?: { allow: (ip: string) => boolean };
    timeoutMs?: number;
    maxResponseBytes?: number;
}

function writeGenericBasetenError(
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

export function basetenProxy(deps: BasetenProxyDeps = {}): {
    name: string;
    configureServer: (server: ViteDevServer) => void;
    configurePreviewServer: (server: { middlewares: { use: (h: Connect.NextHandleFunction) => void } }) => void;
} {
    const fetchFn = deps.fetchFn ?? fetch;
    const getKey = deps.getKey ?? ((): string | undefined => process.env.BASETEN_API_KEY);
    const limiter = deps.limiter ?? g_basetenRateLimiter;
    const timeoutMs = deps.timeoutMs ?? BASETEN_TIMEOUT_MS;
    const maxResponseBytes = deps.maxResponseBytes ?? BASETEN_MAX_RESPONSE_BYTES;
    const handler: Connect.NextHandleFunction = (req, res, next) => {
        if (!req.url || !req.url.startsWith("/api/baseten")) {
            next();
            return;
        }
        if (!isBasetenPath(req.method, req.url)) {
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
        if (!limiter.allow(ip)) {
            res.statusCode = 429;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "rate limited, retry later" }));
            return;
        }
        const key = getKey();
        if (!key) {
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
            fetchFn(BASETEN_UPSTREAM_URL, {
                method: "POST",
                headers: {
                    authorization: `Bearer ${key}`,
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
    return {
        name: "gearflow-baseten-proxy",
        configureServer(server: ViteDevServer) {
            server.middlewares.use(handler);
        },
        configurePreviewServer(server: { middlewares: { use: (h: Connect.NextHandleFunction) => void } }) {
            server.middlewares.use(handler);
        },
    };
}

export default defineConfig({
    plugins: [react(), metaProxy(), basetenProxy()],
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
