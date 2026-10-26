// Proxy allowlist gate shared by vite.config.ts and unit tests.
// Same origin Meta proxy: only POST to three paths, no dot segments,
// same origin check, per-IP rate limit, body and response byte caps.

export const META_PROXY_ALLOWED_PATHS = ["/chat/completions", "/sam/segment", "/images/generations"] as const;
export const META_PROXY_PREFIX = "/api/meta";
export const META_PROXY_MAX_BODY_BYTES = 10 * 1024 * 1024;
export const META_PROXY_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
export const META_PROXY_TIMEOUT_MS = 30000;
export const META_PROXY_RATE_LIMIT_MAX = 30;
export const META_PROXY_RATE_LIMIT_WINDOW_MS = 60 * 1000;

export function proxySuffix(url: string): string | null {
    if (!url.startsWith(META_PROXY_PREFIX)) return null;
    const rest = url.slice(META_PROXY_PREFIX.length);
    if (rest.length > 0 && !rest.startsWith("/")) return null;
    return rest === "" ? "/" : rest;
}

export function hasDotSegment(suffix: string): boolean {
    const pathOnly = suffix.split("?")[0].split("#")[0];
    return pathOnly.split("/").some((seg) => seg === "." || seg === "..");
}

export function isAllowedMetaRequest(method: string | undefined, url: string | undefined): boolean {
    if ((method ?? "GET").toUpperCase() !== "POST") return false;
    const suffix = url !== undefined ? proxySuffix(url) : null;
    if (suffix === null) return false;
    if (hasDotSegment(suffix)) return false;
    const pathOnly = suffix.split("?")[0].split("#")[0];
    const clean = pathOnly === "/" ? "/" : pathOnly.replace(/\/$/, "");
    return (META_PROXY_ALLOWED_PATHS as readonly string[]).includes(clean);
}

function hostOf(value: string | undefined): string | null {
    if (!value) return null;
    try {
        return new URL(value).host.toLowerCase();
    } catch {
        return null;
    }
}

/** Same origin check: when Origin or Referer is present it must match Host. */
export function isSameOriginRequest(headers: Record<string, string | string[] | undefined>, host: string | undefined): boolean {
    const origin = headers.origin ?? headers.Origin;
    const referer = headers.referer ?? headers.Referer ?? headers.referrer;
    const originStr = Array.isArray(origin) ? origin[0] : origin;
    const refererStr = Array.isArray(referer) ? referer[0] : referer;
    const want = (host ?? "").toLowerCase();
    if (originStr !== undefined) {
        const got = hostOf(originStr);
        return got !== null && want !== "" && got === want;
    }
    if (refererStr !== undefined) {
        const got = hostOf(refererStr);
        return got !== null && want !== "" && got === want;
    }
    return true;
}

export class ProxyRateLimiter {
    private hits = new Map<string, number[]>();
    constructor(
        private max = META_PROXY_RATE_LIMIT_MAX,
        private windowMs = META_PROXY_RATE_LIMIT_WINDOW_MS
    ) {}

    allow(ip: string, now = Date.now()): boolean {
        const list = (this.hits.get(ip) ?? []).filter((t) => now - t < this.windowMs);
        if (list.length >= this.max) {
            this.hits.set(ip, list);
            return false;
        }
        list.push(now);
        this.hits.set(ip, list);
        return true;
    }

    size(): number {
        return this.hits.size;
    }
}

/** Shared process rate limiter for the dev and preview proxy. */
export const g_proxyRateLimiter = new ProxyRateLimiter();
