// Offline pack: pre baked Meta responses served with zero Meta network.
// Loads local JSON from public/offline-pack and validates every entry.
// indexUrl is allowlisted to the bundled pack path; cases, strings, and the
// poster asset path are capped so a tampered pack cannot bloat the DOM.

import { validateEngineerResult, validateParametricSpec, validateSamPolygon } from "@/contracts/schema";
import type { OfflineCase } from "@/contracts/types";

export const OFFLINE_PACK_INDEX = "/offline-pack/index.json";
export const OFFLINE_PACK_MAX_CASES = 16;
export const OFFLINE_PACK_ID_MAX = 64;
export const OFFLINE_PACK_LABEL_MAX = 200;
export const OFFLINE_PACK_PROMPT_MAX = 2000;
export const OFFLINE_PACK_POSTER_MAX = 256;
export const OFFLINE_PACK_POSTER_RE = /^\/offline-pack\/[A-Za-z0-9._-]+\.(png|svg|jpg|jpeg|webp)$/;

export function isAllowedIndexUrl(indexUrl: string): boolean {
    if (indexUrl === OFFLINE_PACK_INDEX) return true;
    if (indexUrl.includes("\\") || indexUrl.includes("..")) return false;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(indexUrl)) return false;
    return /^\/offline-pack\/[A-Za-z0-9._-]+\.json$/.test(indexUrl);
}

function checkLen(value: string, field: string, max: number): void {
    if (value.length > max) throw new Error(`OfflineCase.${field} must be <= ${max} chars`);
}

function validateOfflineCase(raw: unknown): OfflineCase {
    if (typeof raw !== "object" || raw === null) throw new Error("OfflineCase must be an object");
    const c = raw as Record<string, unknown>;
    if (typeof c.id !== "string" || c.id.length === 0) throw new Error("OfflineCase.id is required");
    if (typeof c.label !== "string" || c.label.length === 0) throw new Error("OfflineCase.label is required");
    if (typeof c.sparkPrompt !== "string" || c.sparkPrompt.length === 0) {
        throw new Error("OfflineCase.sparkPrompt is required");
    }
    if (typeof c.poster !== "string" || c.poster.length === 0) throw new Error("OfflineCase.poster is required");
    checkLen(c.id as string, "id", OFFLINE_PACK_ID_MAX);
    checkLen(c.label as string, "label", OFFLINE_PACK_LABEL_MAX);
    checkLen(c.sparkPrompt as string, "sparkPrompt", OFFLINE_PACK_PROMPT_MAX);
    checkLen(c.poster as string, "poster", OFFLINE_PACK_POSTER_MAX);
    if (!OFFLINE_PACK_POSTER_RE.test(c.poster as string)) {
        throw new Error("OfflineCase.poster must be a bundled asset path like /offline-pack/poster-x.png");
    }
    validateParametricSpec(c.spec);
    validateEngineerResult(c.engineer);
    validateSamPolygon(c.samPolygon);
    return c as unknown as OfflineCase;
}

export async function loadOfflinePack(indexUrl = OFFLINE_PACK_INDEX, fetchFn: typeof fetch = fetch): Promise<OfflineCase[]> {
    if (!isAllowedIndexUrl(indexUrl)) throw new Error(`Offline pack index not allowlisted: ${indexUrl}`);
    const res = await fetchFn(indexUrl);
    if (!res.ok) throw new Error(`Offline pack index missing at ${indexUrl}`);
    const json = await res.json();
    const list = (json as { cases?: unknown }).cases;
    if (!Array.isArray(list) || list.length === 0) throw new Error("Offline pack has no cases");
    if (list.length > OFFLINE_PACK_MAX_CASES) {
        throw new Error(`Offline pack has ${list.length} cases, cap is ${OFFLINE_PACK_MAX_CASES}`);
    }
    return list.map((entry) => validateOfflineCase(entry));
}
