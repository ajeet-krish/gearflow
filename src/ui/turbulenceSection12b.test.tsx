// TurbulenceSection Phase 12b: empty state before samples, six rows after
// a snapshot with samples, n/a for a null Strouhal, and no section at all
// in placeholder mode. Copy never claims resolved turbulence.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import AnalysisPanel from "./AnalysisPanel";
import TurbulenceSection, { turbulenceSectionDef } from "./TurbulenceSection";
import type { LbmStats } from "@/contracts/types";

const noop = () => {};

function stats(over: Partial<LbmStats> = {}): LbmStats {
    return {
        samples: 120,
        startStep: 8000,
        step: 20000,
        recircFraction: 0.1,
        cdMean: 1.35,
        clMean: 0.28,
        clRms: 0.05,
        strouhal: 0.2,
        ...over,
    };
}

describe("TurbulenceSection", () => {
    it("renders the empty state before any samples", () => {
        const html = renderToStaticMarkup(<TurbulenceSection ready={false} stats={null} />);
        expect(html).toContain("Time means start at step 8,000. Run the solver to populate them.");
        expect(html).not.toContain("CD MEAN");
        expect(html).not.toContain("SAMPLES");
    });

    it("renders the empty state when samples are zero", () => {
        const html = renderToStaticMarkup(
            <TurbulenceSection ready={false} stats={stats({ samples: 0 })} />,
        );
        expect(html).toContain("Time means start at step 8,000.");
        expect(html).not.toContain("CD MEAN");
    });

    it("renders all six rows after a snapshot with samples", () => {
        const html = renderToStaticMarkup(<TurbulenceSection ready={true} stats={stats()} />);
        for (const label of ["SAMPLES", "CD MEAN", "CL MEAN", "CL RMS", "ST", "RECIRC AREA"]) {
            expect(html).toContain(label);
        }
        expect(html).toContain("120");
        expect(html).toContain("10.0 percent");
    });

    it("renders n/a for a null Strouhal", () => {
        const html = renderToStaticMarkup(
            <TurbulenceSection ready={true} stats={stats({ strouhal: null })} />,
        );
        expect(html).toContain("ST");
        expect(html).toContain("n/a");
    });

    it("carries the honest reference note with no dashes", () => {
        const html = renderToStaticMarkup(<TurbulenceSection ready={true} stats={stats()} />);
        expect(html).toContain("Time means over the sampled window. Cd and St are solver reference values for this tunnel, not free cylinder literature values.");
        expect(html).not.toContain("resolved");
        expect(html).not.toContain("validated model");
    });

    it("renders nothing in placeholder mode", () => {
        expect(turbulenceSectionDef(false, false, null)).toBeNull();
        expect(turbulenceSectionDef(false, true, stats())).toBeNull();
        const html = renderToStaticMarkup(
            <AnalysisPanel sections={[]} open={new Set()} onToggle={noop} />,
        );
        expect(html).not.toContain("TURBULENCE");
    });

    it("exposes the TURBULENCE def when the LBM provider is active", () => {
        const def = turbulenceSectionDef(true, false, null);
        expect(def).not.toBeNull();
        expect(def!.label).toBe("TURBULENCE");
        const html = renderToStaticMarkup(
            <AnalysisPanel sections={[def!]} open={new Set(["turbulence"])} onToggle={noop} />,
        );
        expect(html).toContain("TURBULENCE");
        expect(html).toContain("Time means start at step 8,000.");
    });
});
