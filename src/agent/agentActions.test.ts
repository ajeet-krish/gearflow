// Phase B2 agent action tests: envelopes, bounds, gating, fallback.

import { describe, expect, it } from "vitest";
import { parseAgentEnvelope, validateAgentAction, type AgentValidationContext } from "./agentActions";
import { expandCasePreset } from "./casePresets";

const LIVE_LBM: AgentValidationContext = { lbmEffective: true, statsReady: true, hasTke: true, hasRecirc: true, agentFirst: false };
const ANALYTIC: AgentValidationContext = { lbmEffective: false, statsReady: false, hasTke: false, hasRecirc: false, agentFirst: false };

function specPayload(): unknown {
    return {
        kind: "set_spec",
        spec: {
            geometry: { kind: "naca4", naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 }, chord: 1, alphaDeg: 6, nPoints: 120 },
            reynolds: 50000,
            rationale: "Baseline high lift proposal for the test envelope.",
        },
    };
}

describe("parseAgentEnvelope", () => {
    it("accepts a valid fenced action plus reply text", () => {
        const raw = `Raising alpha a touch.\n\`\`\`action-json\n{"kind": "set_alpha", "alphaDeg": 8}\n\`\`\``;
        const out = parseAgentEnvelope(raw, ANALYTIC);
        expect(out.actions).toEqual([{ kind: "set_alpha", alphaDeg: 8 }]);
        expect(out.rejections).toEqual([]);
        expect(out.reply).toContain("Raising alpha");
    });

    it("rejects out of envelope alpha with a reason", () => {
        const raw = `\`\`\`action-json\n{"kind": "set_alpha", "alphaDeg": 200}\n\`\`\``;
        const out = parseAgentEnvelope(raw, ANALYTIC);
        expect(out.actions).toEqual([]);
        expect(out.rejections.length).toBeGreaterThan(0);
        expect(out.rejections.join(" ")).toContain("outside");
        const band = `\`\`\`action-json\n{"kind": "set_alpha", "alphaDeg": 20}\n\`\`\``;
        expect(parseAgentEnvelope(band, ANALYTIC).actions).toEqual([{ kind: "set_alpha", alphaDeg: 20 }]);
    });

    it("pins the exact hard alpha boundaries at 90, 180, 181, and minus 181", () => {
        expect(validateAgentAction({ kind: "set_alpha", alphaDeg: 90 }, ANALYTIC).ok).toBe(true);
        expect(validateAgentAction({ kind: "set_alpha", alphaDeg: 180 }, ANALYTIC).ok).toBe(true);
        expect(validateAgentAction({ kind: "set_alpha", alphaDeg: -180 }, ANALYTIC).ok).toBe(true);
        const over = validateAgentAction({ kind: "set_alpha", alphaDeg: 181 }, ANALYTIC);
        expect(over.ok).toBe(false);
        expect(over.reason ?? "").toContain("outside");
        const under = validateAgentAction({ kind: "set_alpha", alphaDeg: -181 }, ANALYTIC);
        expect(under.ok).toBe(false);
        expect(under.reason ?? "").toContain("outside");
    });

    it("rejects gated TKE field before the first stats sample", () => {
        const raw = `\`\`\`action-json\n{"kind": "set_field", "field": "k"}\n\`\`\``;
        const out = parseAgentEnvelope(raw, ANALYTIC);
        expect(out.actions).toEqual([]);
        expect(out.rejections.join(" ")).toContain("gated");
        const live = parseAgentEnvelope(raw, LIVE_LBM);
        expect(live.actions).toEqual([{ kind: "set_field", field: "k" }]);
    });

    it("rejects gated recirc field before the first stats sample", () => {
        const checked = validateAgentAction({ kind: "set_field", field: "recirc" }, ANALYTIC);
        expect(checked.ok).toBe(false);
        const live = validateAgentAction({ kind: "set_field", field: "recirc" }, LIVE_LBM);
        expect(live.ok).toBe(true);
    });

    it("rejects run_lbm when LBM is not effective, accepts when live", () => {
        const raw = `\`\`\`action-json\n{"kind": "run_lbm"}\n\`\`\``;
        expect(parseAgentEnvelope(raw, ANALYTIC).actions).toEqual([]);
        expect(parseAgentEnvelope(raw, ANALYTIC).rejections.join(" ")).toContain("LBM");
        expect(parseAgentEnvelope(raw, LIVE_LBM).actions).toEqual([{ kind: "run_lbm" }]);
    });

    it("falls back on a malformed envelope without throwing", () => {
        const raw = `Tuning the wing.\n\`\`\`action-json\n{"kind": "set_alpha", broken\n\`\`\``;
        const out = parseAgentEnvelope(raw, ANALYTIC);
        expect(out.actions).toEqual([]);
        expect(out.rejections.join(" ")).toContain("malformed");
        expect(out.reply).toContain("Tuning");
    });

    it("parses plain JSON single actions and full spec proposals", () => {
        const single = parseAgentEnvelope(`{"kind": "set_reynolds", "reynolds": 80000}`, ANALYTIC);
        expect(single.actions).toEqual([{ kind: "set_reynolds", reynolds: 80000 }]);
        const over = parseAgentEnvelope(`{"kind": "set_reynolds", "reynolds": 5}`, ANALYTIC);
        expect(over.actions).toEqual([]);
        const spec = parseAgentEnvelope(JSON.stringify(specPayload()), ANALYTIC);
        expect(spec.actions.length).toBe(1);
        expect(spec.actions[0]).toMatchObject({ kind: "set_spec" });
    });

    it("keeps plain chat text action free without throwing", () => {
        const out = parseAgentEnvelope("Explain this run in plain words.", ANALYTIC);
        expect(out.actions).toEqual([]);
        expect(out.rejections).toEqual([]);
        expect(out.reply).toContain("Explain");
    });
});

describe("parseAgentEnvelope B2 minors", () => {
    it("tolerates a null validation context without throwing", () => {
        const raw = "Raising alpha.\n```action-json\n{\"kind\": \"set_alpha\", \"alphaDeg\": 8}\n```";
        let out: ReturnType<typeof parseAgentEnvelope> | undefined;
        expect(() => {
            out = parseAgentEnvelope(raw, null);
        }).not.toThrow();
        expect(out?.actions).toEqual([{ kind: "set_alpha", alphaDeg: 8 }]);
        expect(validateAgentAction({ kind: "set_alpha", alphaDeg: 8 }, null).ok).toBe(true);
        expect(validateAgentAction({ kind: "run_lbm" }, null).ok).toBe(false);
        expect(validateAgentAction({ kind: "run_lbm" }, undefined).ok).toBe(false);
    });

    it("rejects a null set_spec without throwing", () => {
        const checked = validateAgentAction({ kind: "set_spec", spec: null }, LIVE_LBM);
        expect(checked.ok).toBe(false);
        expect(checked.reason ?? "").toContain("spec object");
        expect(validateAgentAction({ kind: "set_spec" }, LIVE_LBM).ok).toBe(false);
    });

    it("caps fence candidates at five with a rejection note", () => {
        const fences = Array.from(
            { length: 8 },
            (_, i) => "```action-json\n{\"kind\": \"set_alpha\", \"alphaDeg\": " + (i - 4) + "}\n```"
        ).join("\n");
        const out = parseAgentEnvelope("Many moves.\n" + fences, ANALYTIC);
        expect(out.actions.length).toBeLessThanOrEqual(5);
        expect(out.actions.length).toBe(5);
        expect(out.rejections.join(" ")).toContain("ignored");
    });

    it("caps plain JSON arrays at five with a rejection note", () => {
        const many = Array.from({ length: 8 }, (_, i) => ({ kind: "set_alpha", alphaDeg: i - 4 }));
        const out = parseAgentEnvelope(JSON.stringify(many), ANALYTIC);
        expect(out.actions.length).toBe(5);
        expect(out.rejections.join(" ")).toContain("ignored");
    });
});

describe("envelope alias plus canonical fraction normalization", () => {
    it("maps model-invented set_re to set_reynolds across case and value shapes", () => {
        for (const kind of ["set_re", "Set_Re", "SET_RE", "set-re"]) {
            const raw = `Tuning.\n\`\`\`action-json\n{"kind": "${kind}", "re": 80000}\n\`\`\``;
            const out = parseAgentEnvelope(raw, ANALYTIC);
            expect(out.actions).toEqual([{ kind: "set_reynolds", reynolds: 80000 }]);
            expect(out.rejections).toEqual([]);
        }
        const byValue = parseAgentEnvelope(`Tuning.\n\`\`\`action-json\n{"kind": "set_re", "value": 120000}\n\`\`\``, ANALYTIC);
        expect(byValue.actions).toEqual([{ kind: "set_reynolds", reynolds: 120000 }]);
        const plain = parseAgentEnvelope(`{"kind": "set_re", "reynolds": 50000}`, ANALYTIC);
        expect(plain.actions).toEqual([{ kind: "set_reynolds", reynolds: 50000 }]);
    });

    it("keeps the validator strict on the bare set_re kind", () => {
        expect(validateAgentAction({ kind: "set_re", re: 80000 }, ANALYTIC).ok).toBe(false);
    });

    it("overrides mismatched NACA fractions from the code digits with a note", () => {
        const raw = `Setting up.\n\`\`\`action-json\n{"kind": "set_spec", "spec": {"geometry": {"kind": "naca4", "naca": {"code": "2197", "m": 0.02, "p": 0.2, "t": 0.97}, "chord": 1, "alphaDeg": 6, "nPoints": 120}, "reynolds": 50000, "rationale": "Agent setup NACA 2197 alpha 6."}}\n\`\`\``;
        const out = parseAgentEnvelope(raw, ANALYTIC);
        expect(out.actions).toHaveLength(1);
        const only = out.actions[0];
        expect(only.kind).toBe("set_spec");
        if (only.kind === "set_spec") {
            expect(only.spec.geometry.naca).toEqual({ code: "2197", m: 0.02, p: 0.1, t: 0.97 });
        }
        expect(out.rejections).toEqual([]);
        expect(out.reply).toContain("2197");
        expect(out.reply).toContain("fractions set from the code digits");
    });
});

describe("trusted preset setup actions", () => {
    it("accepts setup_shedding at Re 100 on the same path the bare Re floor accepts", () => {
        const bare = validateAgentAction({ kind: "set_reynolds", reynolds: 99 }, ANALYTIC);
        expect(bare.ok).toBe(false);
        expect(bare.reason ?? "").toContain("100");
        expect(validateAgentAction({ kind: "set_reynolds", reynolds: 100 }, ANALYTIC).ok).toBe(true);
        expect(validateAgentAction({ kind: "set_reynolds", reynolds: 700 }, ANALYTIC).ok).toBe(true);
        const trusted = validateAgentAction({ kind: "setup_shedding" }, ANALYTIC);
        expect(trusted.ok).toBe(true);
        expect(trusted.action).toEqual({ kind: "setup_shedding" });
        const expanded = expandCasePreset({ preset: "shedding" });
        expect(expanded.ok).toBe(true);
        expect(expanded.actions).toContainEqual({ kind: "set_reynolds", reynolds: 100 });
    });

    it("rejects invalid setup bodies and alphas on the preset path", () => {
        const badBody = validateAgentAction({ kind: "setup_high_pressure", body: "cylinder" }, ANALYTIC);
        expect(badBody.ok).toBe(false);
        expect(badBody.reason ?? "").toContain("high_pressure");
        const badAlpha = validateAgentAction({ kind: "setup_airfoil", body: "naca4412", alphaDeg: 200 }, ANALYTIC);
        expect(badAlpha.ok).toBe(false);
        const retired = validateAgentAction({ kind: "setup_high_pressure", body: "block" }, ANALYTIC);
        expect(retired.ok).toBe(false);
        expect(retired.reason ?? "").toContain("diverges at every tested gap and Re");
    });

    it("rejects a set_spec whose code does not match its m/p/t fractions", () => {
        const mismatched = validateAgentAction(
            {
                kind: "set_spec",
                spec: {
                    geometry: { kind: "naca4", naca: { code: "2412", m: 0.06, p: 0.4, t: 0.15 }, chord: 1, alphaDeg: 6, nPoints: 120 },
                    reynolds: 50000,
                    rationale: "Mismatched code test.",
                },
            },
            ANALYTIC
        );
        expect(mismatched.ok).toBe(false);
        expect(mismatched.reason ?? "").toContain("does not match");
    });
});

describe("agent-first analytic enforcement", () => {
    const FIRST: AgentValidationContext = { lbmEffective: true, statsReady: true, hasTke: true, hasRecirc: true, agentFirst: true };

    it("rejects non-analytic set_engine with an analytic-only reason", () => {
        for (const engine of ["lbm", "wasm", "surrogate"]) {
            const checked = validateAgentAction({ kind: "set_engine", engine }, FIRST);
            expect(checked.ok).toBe(false);
            expect(checked.action).toBeNull();
            expect(checked.reason ?? "").toContain("agent-first analytic mode");
            const parsed = parseAgentEnvelope(`\`\`\`action-json\n{"kind": "set_engine", "engine": "${engine}"}\n\`\`\``, FIRST);
            expect(parsed.actions).toEqual([]);
            expect(parsed.rejections.join(" ")).toContain("agent-first analytic mode");
        }
        expect(validateAgentAction({ kind: "set_engine", engine: "analytic" }, FIRST).ok).toBe(true);
    });

    it("rejects run_lbm and cancel_lbm even with a live LBM context", () => {
        const run = validateAgentAction({ kind: "run_lbm" }, FIRST);
        expect(run.ok).toBe(false);
        expect(run.reason ?? "").toContain("run_lbm");
        expect(run.reason ?? "").toContain("analytic");
        const cancel = validateAgentAction({ kind: "cancel_lbm" }, FIRST);
        expect(cancel.ok).toBe(false);
        expect(cancel.reason ?? "").toContain("cancel_lbm");
        const parsed = parseAgentEnvelope("```action-json\n{\"kind\": \"run_lbm\"}\n```", FIRST);
        expect(parsed.actions).toEqual([]);
        expect(parsed.rejections.join(" ")).toContain("run_lbm");
    });

    it("rejects k and recirc fields even with stats ready", () => {
        for (const field of ["k", "recirc"]) {
            const checked = validateAgentAction({ kind: "set_field", field }, FIRST);
            expect(checked.ok).toBe(false);
            expect(checked.reason ?? "").toContain("gated");
            expect(checked.reason ?? "").toContain("analytic");
        }
        expect(validateAgentAction({ kind: "set_field", field: "speed" }, FIRST).ok).toBe(true);
    });

    it("keeps analytic-safe actions accepted under the flag", () => {
        expect(validateAgentAction({ kind: "set_alpha", alphaDeg: 6 }, FIRST).ok).toBe(true);
        expect(validateAgentAction({ kind: "setup_shedding" }, FIRST).ok).toBe(true);
        const expanded = expandCasePreset({ preset: "shedding" }, { agentFirst: true });
        expect(expanded.ok).toBe(true);
        expect(expanded.domainNote ?? "").toContain("analytic preview");
    });
});
