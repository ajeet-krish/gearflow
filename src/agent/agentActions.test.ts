// Phase B2 agent action tests: envelopes, bounds, gating, fallback.

import { describe, expect, it } from "vitest";
import { parseAgentEnvelope, validateAgentAction, type AgentValidationContext } from "./agentActions";
import { expandCasePreset } from "./casePresets";

const LIVE_LBM: AgentValidationContext = { lbmEffective: true, statsReady: true, hasTke: true, hasRecirc: true };
const ANALYTIC: AgentValidationContext = { lbmEffective: false, statsReady: false, hasTke: false, hasRecirc: false };

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

describe("trusted preset setup actions", () => {
    it("accepts setup_shedding at Re 100 through the preset path while the bare Re floor rejects it", () => {
        const bare = validateAgentAction({ kind: "set_reynolds", reynolds: 100 }, ANALYTIC);
        expect(bare.ok).toBe(false);
        expect(bare.reason ?? "").toContain("1000");
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
});
