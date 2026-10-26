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

export default defineConfig({
    plugins: [react(), metaProxy()],
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "src"),
        },
    },
    server: {
        port: 5173,
    },
});
