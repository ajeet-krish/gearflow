// R4 zero credit envelope replay plus mutation corpus. Pure replay of the
// recorded Spark raw replies in fixtures/envelopes through
// parseAgentEnvelope plus validateAgentAction with zero network. The global
// fetch stub throws, so any live call fails loudly, and BasetenClient is
// only built with an injected fetchFn fake. The mutation corpus applies
// deterministic edits (digit duplication, transposition, vowel swaps like
// naca to naka, dropped separators) over seed codes and pins three
// invariants: the parser chain never throws, no emitted action carries a
// code that fails validateParametricSpec, and ambiguous parses never
// auto apply.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAgentEnvelope, validateAgentAction } from "./agentActions";
import { buildAirfoilEnvelope, parseAirfoilIntent } from "./airfoilIntent";
import { isSchemaValidCode, parseNacaLoose } from "./nacaParse";
import { validateParametricSpec } from "@/contracts/schema";
import { BasetenClient } from "./basetenClient";
import manifest from "./fixtures/envelopes/manifest.json";

interface ManifestExpect {
    actions: unknown[];
    rejections?: string[];
    rejectionsContain?: string[];
    replyContains?: string;
}

interface ManifestRow {
    id: string;
    file: string;
    ctx: string;
    expect: ManifestExpect;
}

const CONTEXTS: Record<string, { lbmEffective: boolean; statsReady: boolean; hasTke: boolean; hasRecirc: boolean }> = {
    ...(manifest as unknown as { contexts: Record<string, { lbmEffective: boolean; statsReady: boolean; hasTke: boolean; hasRecirc: boolean }> }).contexts,
};

const ROWS = (manifest as unknown as { rows: ManifestRow[] }).rows;

function envelopeDir(): string {
    return join(process.cwd(), "src", "agent", "fixtures", "envelopes");
}

function readEnvelope(file: string): string {
    return readFileSync(join(envelopeDir(), file), "utf8");
}

const LIVE = { lbmEffective: true, statsReady: true, hasTke: true, hasRecirc: true };

beforeEach(() => {
    vi.stubGlobal("fetch", () => {
        throw new Error("zero credit harness forbids global fetch");
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("agent envelope replay (R4 zero credit)", () => {
    for (const row of ROWS) {
        it(`replays ${row.id} with zero network`, () => {
            const raw = readEnvelope(row.file);
            expect(raw.length).toBeGreaterThan(0);
            const ctx = CONTEXTS[row.ctx];
            expect(ctx, `unknown ctx ${row.ctx}`).toBeDefined();
            let out: ReturnType<typeof parseAgentEnvelope> | null = null;
            expect(() => {
                out = parseAgentEnvelope(raw, ctx);
            }).not.toThrow();
            const env = out as unknown as ReturnType<typeof parseAgentEnvelope>;
            expect(env.actions).toEqual(row.expect.actions);
            if (row.expect.rejections !== undefined) {
                expect(env.rejections).toEqual(row.expect.rejections);
            }
            for (const needle of row.expect.rejectionsContain ?? []) {
                expect(env.rejections.join(" ")).toContain(needle);
            }
            if (row.expect.replyContains !== undefined) {
                expect(env.reply).toContain(row.expect.replyContains);
            }
            for (const action of env.actions) {
                const checked = validateAgentAction(action, ctx);
                expect(checked.ok).toBe(true);
                expect(checked.action).toEqual(action);
            }
        });
    }

    it("pins the retired preset and the non canonical body boundary", () => {
        const retired = ROWS.find((r) => r.id === "retired-high-pressure-rejects");
        const body = ROWS.find((r) => r.id === "noncanonical-set-body-rejects");
        const spec = ROWS.find((r) => r.id === "noncanonical-set-spec-applies");
        expect(retired).toBeDefined();
        expect(body).toBeDefined();
        expect(spec).toBeDefined();
        const retiredOut = parseAgentEnvelope(readEnvelope((retired as ManifestRow).file), CONTEXTS.analytic);
        expect(retiredOut.actions).toEqual([]);
        expect(retiredOut.rejections.join(" ")).toContain("diverges at every tested gap and Re");
        const bodyOut = parseAgentEnvelope(readEnvelope((body as ManifestRow).file), CONTEXTS.live);
        expect(bodyOut.actions).toEqual([]);
        expect(bodyOut.rejections.join(" ")).toContain("set_body needs body in");
        const specOut = parseAgentEnvelope(readEnvelope((spec as ManifestRow).file), CONTEXTS.live);
        expect(specOut.actions.length).toBe(1);
        const only = specOut.actions[0];
        expect(only.kind).toBe("set_spec");
        if (only.kind === "set_spec") {
            expect(() => validateParametricSpec(only.spec)).not.toThrow();
        }
    });

    it("serves BasetenClient through the injected fetchFn while global fetch throws", async () => {
        let calls = 0;
        const fakeFetch = (async () => {
            calls += 1;
            return {
                status: 200,
                ok: true,
                headers: { get: () => null },
                json: async () => ({
                    choices: [{ message: { content: "injected fake reply" } }],
                    usage: { prompt_tokens: 10, completion_tokens: 5 },
                }),
            } as unknown as Response;
        }) as unknown as typeof fetch;
        const client = new BasetenClient({ fetchFn: fakeFetch, baseUrl: "/api/baseten" });
        const res = await client.chat([{ role: "user", content: "hello" }]);
        expect(res.text).toContain("injected fake reply");
        expect(calls).toBe(1);
    });
});

interface MutatedCase {
    label: string;
    text: string;
    seed: string;
}

/** Deterministic mutation corpus over seed codes. No randomness, fixed order. */
function buildMutationCorpus(): MutatedCase[] {
    const seeds = ["2412", "4412", "0012", "6415"];
    const out: MutatedCase[] = [];
    const push = (label: string, text: string, seed: string): void => {
        if (!out.some((c) => c.text === text)) out.push({ label, text, seed });
    };
    for (const seed of seeds) {
        const bases: Array<{ label: string; text: string }> = [
            { label: "spaced", text: `NACA ${seed}` },
            { label: "compact", text: `naca${seed}` },
            { label: "dashed", text: `NACA ${seed.slice(0, 2)}-${seed.slice(2)}` },
        ];
        for (const base of bases) {
            push(`${seed} ${base.label} identity`, base.text, seed);
            push(`${seed} ${base.label} vowel naka`, base.text.replace(/naca/i, "naka").replace(/NACA/, "NAKA"), seed);
            const dropped = base.text.replace(/[\s\-_]/g, "");
            push(`${seed} ${base.label} dropped separator`, dropped, seed);
            const digits = seed;
            for (let i = 0; i < digits.length; i++) {
                const dup = digits.slice(0, i + 1) + digits[i] + digits.slice(i + 1);
                push(`${seed} ${base.label} dup pos ${i}`, base.text.replace(seed, dup), seed);
            }
            for (let i = 0; i < digits.length - 1; i++) {
                const arr = digits.split("");
                const tmp = arr[i];
                arr[i] = arr[i + 1];
                arr[i + 1] = tmp;
                push(`${seed} ${base.label} swap pos ${i}`, base.text.replace(seed, arr.join("")), seed);
            }
        }
    }
    return out;
}

describe("agent mutation corpus (R4 deterministic edits)", () => {
    it("never throws, never emits an invalid code, ambiguous never auto applies", () => {
        const corpus = buildMutationCorpus();
        expect(corpus.length).toBeGreaterThan(60);
        let ambiguous = 0;
        let applied = 0;
        let settledApplies = 0;
        for (const item of corpus) {
            let parsed: ReturnType<typeof parseNacaLoose> | null = null;
            expect(() => {
                parsed = parseNacaLoose(item.text);
            }, `parseNacaLoose threw on ${item.label}`).not.toThrow();
            const safe = parsed as unknown as ReturnType<typeof parseNacaLoose>;
            let intent: ReturnType<typeof parseAirfoilIntent> | null = null;
            expect(() => {
                intent = parseAirfoilIntent(item.text, null);
            }, `parseAirfoilIntent threw on ${item.label}`).not.toThrow();
            const use = intent as unknown as ReturnType<typeof parseAirfoilIntent>;
            if (safe.status === "ambiguous") {
                ambiguous += 1;
                expect(use === null || use.kind !== "apply", `ambiguous auto applied on ${item.label}: ${item.text}`).toBe(true);
                continue;
            }
            if (use !== null && use.kind === "apply") {
                applied += 1;
                let envelope: ReturnType<typeof buildAirfoilEnvelope> | null = null;
                expect(() => {
                    envelope = buildAirfoilEnvelope(use, null);
                }, `buildAirfoilEnvelope threw on ${item.label}`).not.toThrow();
                const env = envelope as unknown as ReturnType<typeof buildAirfoilEnvelope>;
                // Candidates settle through the shared validator, exactly
                // like the console fast path: accepted actions must carry a
                // spec that passes validateParametricSpec, rejected
                // candidates must carry an honest reason and never apply.
                // Thin typo sections (for example NACA 0102 at 2 percent
                // chord) land here as rejections, which is the honest
                // outcome, never a canvas write.
                let settled = 0;
                for (const cand of env.candidates) {
                    let checked: ReturnType<typeof validateAgentAction> | null = null;
                    expect(() => {
                        checked = validateAgentAction(cand, LIVE);
                    }, `validateAgentAction threw on ${item.label}`).not.toThrow();
                    const done = checked as unknown as ReturnType<typeof validateAgentAction>;
                    if (done.ok && done.action !== null) {
                        settled += 1;
                        if (done.action.kind === "set_spec") {
                            const specAction = done.action;
                            expect(() => validateParametricSpec(specAction.spec), `invalid set_spec settled on ${item.label}`).not.toThrow();
                            const code = specAction.spec.geometry.naca?.code ?? "";
                            expect(isSchemaValidCode(code).ok, `invalid spec code settled on ${item.label}`).toBe(true);
                        }
                        if (done.action.kind === "set_body" && done.action.body.startsWith("naca")) {
                            const code = done.action.body.slice(4);
                            expect(isSchemaValidCode(code).ok, `invalid body code settled on ${item.label}`).toBe(true);
                        }
                    } else {
                        expect(typeof done.reason === "string" && done.reason.length > 0, `empty rejection on ${item.label}`).toBe(true);
                    }
                }
                if (settled > 0) settledApplies += 1;
            }
        }
        expect(ambiguous).toBeGreaterThan(0);
        expect(applied).toBeGreaterThan(0);
        expect(settledApplies).toBeGreaterThan(0);
    });
});
