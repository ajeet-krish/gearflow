// Poster render: one labeled illustrative image per session. The session
// guard keeps the demo to a single paid call, extra requests reuse the first
// url. Cache key covers the prompt hash, poster results persist in memory.

import type { ParametricSpec } from "@/contracts/types";
import { META_DEFAULT_IMAGE_MODEL } from "./client";
import type { MetaClient } from "./client";
import { hashKey, type HashCache } from "./cache";

export interface PosterSession {
    used: boolean;
    url: string | null;
}

export function createPosterSession(): PosterSession {
    return { used: false, url: null };
}

export function posterPrompt(spec: ParametricSpec): string {
    const g = spec.geometry;
    const kindLabel = g.kind === "naca4" && g.naca ? `NACA ${g.naca.code}` : g.kind;
    return [
        "Labeled illustrative poster of a generic single element wing study,",
        `style proxy inspired by high downforce circuits, ${kindLabel} at alpha ${g.alphaDeg} deg,`,
        `Reynolds ${spec.reynolds}. Clean engineering sketch style, annotated arrows,`,
        "no logos, no brand marks, no team liveries.",
    ].join(" ");
}

export async function generatePoster(
    client: MetaClient,
    cache: HashCache,
    spec: ParametricSpec,
    session: PosterSession
): Promise<{ url: string; cached: boolean }> {
    if (session.used && session.url !== null) {
        client.reportCacheHit("poster", META_DEFAULT_IMAGE_MODEL, session.url, "session");
        return { url: session.url, cached: true };
    }
    if (session.used) throw new Error("Poster session already used one render; reuse the first url.");
    const prompt = posterPrompt(spec);
    const key = `poster:${await hashKey({ prompt })}`;
    const hit = cache.get<string>(key);
    if (hit !== null) {
        session.used = true;
        session.url = hit.value;
        client.reportCacheHit("poster", META_DEFAULT_IMAGE_MODEL, key, "cache");
        return { url: hit.value, cached: true };
    }
    const url = await client.image(prompt, "poster", META_DEFAULT_IMAGE_MODEL);
    session.used = true;
    session.url = url;
    cache.set(key, url, 4 * 60 * 60 * 1000, { persist: false });
    return { url, cached: false };
}
