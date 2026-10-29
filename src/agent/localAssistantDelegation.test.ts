// R2 local delegation tests. localReply NACA plus alpha plus Re handling
// must follow the shared R1 corpus through parseAirfoilIntent, so offline
// setup cannot drift from the tested parser. Pure, zero network.

import { describe, expect, it } from "vitest";
import type { AgentContext } from "./agentContext";
import { parseAirfoilIntent } from "./airfoilIntent";
import { localReply } from "./localAssistant";
import corpus from "./fixtures/airfoilCorpus.json";

interface CorpusIntentExpect {
    kind: "apply" | "clarify";
    code?: string | null;
    alphaDeg?: number | null;
    reynolds?: number | null;
    candidatesInclude?: string[];
    correctionsInclude?: string[];
    notesInclude?: string[];
}

interface CorpusRow {
    id: string;
    text: string;
    current?: string | null;
    parse?: unknown;
    intent?: CorpusIntentExpect | null;
}

const rows = (corpus as unknown as { rows: CorpusRow[] }).rows;

const CANONICAL = new Set(["naca0012", "naca2412", "naca4412"]);

function makeCtx(over: Partial<AgentContext> = {}): AgentContext {
    return {
        spec: { kind: "naca4", alphaDeg: 6, reynolds: 50000, naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 } },
        reynolds: 50000,
        regime: "attached laminar",
        bodyLabel: "NACA 2412",
        alphaDeg: 6,
        backend: "analytic",
        engine: "analytic",
        gridLabel: "grid 128",
        cl: 0.6,
        cpMin: -1.2,
        lbm: { status: "idle", hasSnapshot: false, effective: false, statsReady: false, stats: null },
        field: { variable: "speed", effective: "speed", hasTke: false, hasRecirc: false },
        validation: { pass: 1, warn: 0, fail: 0, info: 0 },
        provenanceLabel: "analytic",
        offline: true,
        honesty: [],
        neural: {
            available: false,
            envelope: "provisional neural envelope [naca0012, naca2412, naca4412, cylinder, block], alpha [-4, 8], Re [20, 1200], no weights yet",
            path: "analytic",
        },
        ...over,
    };
}

describe("localReply follows the airfoil corpus", () => {
    for (const row of rows) {
        it(`delegates ${row.id}`, () => {
            const codeMatch = typeof row.current === "string" ? row.current.match(/(\d{4})(?!\d)/) : null;
            const specNaca = codeMatch !== null
                ? {
                    code: codeMatch[1],
                    m: parseInt(codeMatch[1][0], 10) / 100,
                    p: parseInt(codeMatch[1][1], 10) / 10,
                    t: parseInt(codeMatch[1].slice(2), 10) / 100,
                }
                : { code: "2412", m: 0.02, p: 0.4, t: 0.12 };
            const ctx = makeCtx({
                bodyLabel: row.current ?? "NACA 2412",
                spec: { kind: "naca4", alphaDeg: 6, reynolds: 50000, naca: specNaca },
            });
            const out = localReply(row.text, ctx);
            expect(typeof out.reply).toBe("string");
            expect(out.reply.length).toBeGreaterThan(0);
            if (row.intent === null || row.intent === undefined) {
                expect(out.actions.some((a) => a.kind === "set_body")).toBe(false);
                return;
            }
            if (row.intent.kind === "clarify") {
                expect(out.actions.some((a) => a.kind === "set_body")).toBe(false);
                expect(out.reply).toContain("Canvas unchanged");
                return;
            }
            const parsed = parseAirfoilIntent(row.text, row.current == null ? null : { code: row.current });
            expect(parsed?.kind).toBe("apply");
            if (parsed?.kind !== "apply") return;
            if (parsed.code !== null) {
                const tok = `naca${parsed.code}`;
                if (CANONICAL.has(tok)) {
                    expect(out.actions).toContainEqual({ kind: "set_body", body: tok });
                } else {
                    expect(out.actions.some((a) => a.kind === "set_body")).toBe(false);
                    expect(out.rejections.join(" ")).toContain(parsed.code);
                }
            }
            if (parsed.alphaDeg !== null) {
                expect(out.actions).toContainEqual({ kind: "set_alpha", alphaDeg: parsed.alphaDeg });
            }
            if (parsed.reynolds !== null) {
                expect(out.actions).toContainEqual({ kind: "set_reynolds", reynolds: parsed.reynolds });
            }
        });
    }

    it("stages the corpus alpha plus Re alongside the canonical body", () => {
        const out = localReply("NACA 2412 alpha 6", makeCtx());
        expect(out.actions).toContainEqual({ kind: "set_body", body: "naca2412" });
        expect(out.actions).toContainEqual({ kind: "set_alpha", alphaDeg: 6 });
        const mixed = localReply("use 6415 at 8deg Re200k", makeCtx());
        expect(mixed.actions).toContainEqual({ kind: "set_alpha", alphaDeg: 8 });
        expect(mixed.actions).toContainEqual({ kind: "set_reynolds", reynolds: 200000 });
        expect(mixed.rejections.join(" ")).toContain("6415");
    });

    it("surfaces the shared parser typo corrections", () => {
        const naka = localReply("naka2412", makeCtx());
        expect(naka.actions).toContainEqual({ kind: "set_body", body: "naca2412" });
        expect(naka.reply.toLowerCase()).toContain("naka");
        const five = localReply("naka 24112", makeCtx());
        expect(five.actions.some((a) => a.kind === "set_body")).toBe(false);
        expect(five.reply.toLowerCase()).toContain("naka");
        expect(five.reply).toContain("5 digits");
    });

    it("adds the tutor physics note for valid but unrealistic thickness", () => {
        const out = localReply("NACA 2440", makeCtx());
        expect(out.actions.some((a) => a.kind === "set_body")).toBe(false);
        expect(out.reply).toContain("6 to 18%");
        expect(out.reply).toContain("Canvas unchanged");
    });

    it("asks the clarify question instead of applying an ambiguous code", () => {
        const out = localReply("23012", makeCtx());
        expect(out.actions).toEqual([]);
        expect(out.reply).toContain("2312");
        expect(out.reply).toContain("Canvas unchanged");
    });

    it("is deterministic across repeated calls", () => {
        const first = localReply("Set up NACA 2412 alpha 6", makeCtx());
        const second = localReply("Set up NACA 2412 alpha 6", makeCtx());
        expect(second.reply).toBe(first.reply);
        expect(second.actions).toEqual(first.actions);
        expect(second.rejections).toEqual(first.rejections);
    });
});
