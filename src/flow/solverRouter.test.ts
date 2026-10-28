// solverRouter tests: fast path decisions plus neural and analytic
// provenance wordings. No network, pure logic only.

import { describe, expect, it } from "vitest";
import {
    analyticProvenanceLabel,
    decideFastPath,
    neuralProvenanceLabel,
} from "@/flow/solverRouter";

describe("decideFastPath", () => {
    it("routes ready plus in-domain to neural-v2", () => {
        const decision = decideFastPath({ body: "naca2412", alphaDeg: 6, reynolds: 1200, neuralStatus: "ready" });
        expect(decision.path).toBe("neural-v2");
        expect(decision.inDomain).toBe(true);
        expect(decision.reason).toBe("neural-v2 weights ready and case inside the provisional envelope");
    });

    it("routes ready but out-of-domain to analytic with the envelope reason", () => {
        const decision = decideFastPath({ body: "naca2412", alphaDeg: 30, reynolds: 1000, neuralStatus: "ready" });
        expect(decision.path).toBe("analytic");
        expect(decision.inDomain).toBe(false);
        expect(decision.reason).toBe(
            "case outside the provisional neural envelope (alpha 30 deg is outside the provisional envelope [-4, 8] deg), analytic fallback",
        );
    });

    it("routes an out-of-envelope Re to analytic even when ready", () => {
        const decision = decideFastPath({ body: "cylinder", alphaDeg: 0, reynolds: 19, neuralStatus: "ready" });
        expect(decision.path).toBe("analytic");
        expect(decision.inDomain).toBe(false);
        expect(decision.reason).toBe(
            "case outside the provisional neural envelope (Re 19 is outside the provisional envelope [20, 700] for cylinder, nearest cylinder Re 20), analytic fallback",
        );
    });

    it("routes loading weights to analytic with the loading wording", () => {
        const decision = decideFastPath({ body: "naca2412", alphaDeg: 6, reynolds: 50000, neuralStatus: "loading" });
        expect(decision.path).toBe("analytic");
        expect(decision.reason).toBe("neural-v2 weights still loading, analytic fallback");
    });

    it("routes failed weights to analytic with the failed wording", () => {
        const decision = decideFastPath({ body: "naca2412", alphaDeg: 6, reynolds: 50000, neuralStatus: "failed" });
        expect(decision.path).toBe("analytic");
        expect(decision.reason).toBe("neural-v2 weights failed to load, analytic fallback");
    });

    it("routes unavailable weights to analytic with the unavailable wording", () => {
        const decision = decideFastPath({ body: "naca2412", alphaDeg: 6, reynolds: 50000, neuralStatus: "unavailable" });
        expect(decision.path).toBe("analytic");
        expect(decision.reason).toBe("neural-v2 weights unavailable, analytic fallback");
    });
});

describe("provenance labels", () => {
    it("labels neural-v2 frames predicted, not validated", () => {
        const label = neuralProvenanceLabel({ weightsVersion: "v2-abc123", latencyMs: 12.345, cached: true });
        expect(label).toBe("neural-v2 predicted, not validated, (v2-abc123, 12.3 ms, cached)");
    });

    it("labels neural-v2 honestly when weights metadata is missing", () => {
        const label = neuralProvenanceLabel();
        expect(label).toBe("neural-v2 predicted, not validated, (weights pending)");
    });

    it("labels analytic frames with the cause and the not validated marker", () => {
        const label = analyticProvenanceLabel("neural-v2 weights unavailable, analytic fallback");
        expect(label).toBe("analytic potential flow (neural-v2 weights unavailable, analytic fallback), not validated");
    });

    it("falls back to the analytic path wording for a blank reason", () => {
        const label = analyticProvenanceLabel("   ");
        expect(label).toBe("analytic potential flow (analytic path), not validated");
    });
});
