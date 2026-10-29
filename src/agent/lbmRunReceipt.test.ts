// T2 blocked preflight receipt: a hard-blocked gate maps to gated, never
// applied. Drives the real preflightLbm plus the production receiptForLbmRun
// helper from App, so a receipt that claims a blocked run as applied fails.

import { describe, expect, it } from "vitest";
import { receiptForLbmRun } from "@/App";
import { DEFAULT_DOMAIN } from "@/contracts/types";
import { preflightLbm } from "@/flow/lbmRunConfig";

const RUN = { kind: "run_lbm" } as const;

describe("blocked preflight receipt", () => {
    it("maps a blocked preflight outcome to gated with zero applied", () => {
        const gate = preflightLbm(
            { kind: "cylinder", chord: 1, alphaDeg: 0, nPoints: 64, radius: 0.25 },
            { nx: 128, ny: 128, domain: { ...DEFAULT_DOMAIN } },
            0.05,
            2000
        );
        expect(gate.ok).toBe(false);
        expect(gate.blockReasons.length).toBeGreaterThan(0);
        const receipt = receiptForLbmRun(RUN, "blocked", gate.blockReasons.join(" "));
        expect(receipt.applied).toEqual([]);
        expect(receipt.gated.length).toBe(1);
        expect(receipt.gated[0]).toContain("blocked");
        expect(receipt.summary).toContain("gated");
        expect(receipt.summary).not.toContain("applied run_lbm");
    });

    it("maps a started run to applied with zero gated", () => {
        const gate = preflightLbm(
            { kind: "cylinder", chord: 1, alphaDeg: 0, nPoints: 64, radius: 0.05 },
            { nx: 128, ny: 128, domain: { ...DEFAULT_DOMAIN } },
            0.05,
            100
        );
        expect(gate.ok).toBe(true);
        const receipt = receiptForLbmRun(RUN, "started");
        expect(receipt.applied).toEqual([RUN]);
        expect(receipt.gated).toEqual([]);
        expect(receipt.summary).toContain("applied run_lbm");
    });
});
