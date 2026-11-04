// P4 Physics Agent caption tests: capped plus caveat plus offline. Pure, no network.

import { describe, expect, it } from "vitest";
import {
    buildReportData,
    capTutorCaption,
    caveatForCaption,
    TUTOR_CAPTION_CAVEAT,
    TUTOR_CAPTION_CAVEAT_LBM,
    TUTOR_CAPTION_MAX,
    TUTOR_CAPTION_CAVEAT_NEURAL,
    TUTOR_CAPTION_CAVEAT_PENDING,
    type ExportData,
} from "./exportReport";
import { localTutorReply } from "@/agent/tutorPolicy";

function demoData(over: Partial<ExportData> = {}): ExportData {
    return {
        specLabel: "naca2412",
        alphaDeg: 6,
        reynolds: 50000,
        regime: "transitional wake",
        cl: 0.823,
        cpMin: -1.42,
        solveMs: 3.2,
        backend: "analytic live",
        provenance: "analytic-potential, computed locally",
        gridLabel: "128x128",
        validation: { pass: 3, warn: 2, fail: 0, info: 4 },
        generatedAt: "2026-10-26T00:00:00.000Z",
        ...over,
    };
}

const DOUBLE = "-".repeat(2);

describe("capTutorCaption", () => {
    it("caps long prose to 240 chars ending with the analytic caveat", () => {
        const long = `${"word ".repeat(100)}tail`;
        const capped = capTutorCaption(long);
        expect(capped.length).toBeLessThanOrEqual(TUTOR_CAPTION_MAX);
        expect(capped.endsWith(TUTOR_CAPTION_CAVEAT)).toBe(true);
    });
    it("appends the caveat to short prose without one", () => {
        const capped = capTutorCaption("Cl 0.823 with CpMin -1.420 at alpha 6.");
        expect(capped).toContain("Cl 0.823");
        expect(capped.endsWith(TUTOR_CAPTION_CAVEAT)).toBe(true);
        expect(capped.length).toBeLessThanOrEqual(TUTOR_CAPTION_MAX);
    });
    it("keeps empty input empty so no Physics Agent row renders", () => {
        expect(capTutorCaption("")).toBe("");
        expect(capTutorCaption("   ")).toBe("");
        expect(capTutorCaption(null)).toBe("");
    });
});

describe("buildReportData Physics Agent row", () => {
    it("appends the Physics Agent row when the caption is non-empty", () => {
        const report = buildReportData(demoData({ tutorCaption: "Cl 0.823 at alpha 6. Caveat: analytic estimate, not validated." }));
        expect(report.rows.length).toBe(13);
        const physicsAgent = report.rows.find(([k]) => k === "Physics Agent");
        expect(physicsAgent?.[1]).toContain("Cl 0.823");
        expect(physicsAgent?.[1].endsWith(TUTOR_CAPTION_CAVEAT)).toBe(true);
    });
    it("renders no Physics Agent row without a caption, keeping the twelve row sheet", () => {
        expect(buildReportData(demoData()).rows.length).toBe(12);
        expect(buildReportData(demoData({ tutorCaption: "   " })).rows.length).toBe(12);
    });
    it("works offline from a deterministic localTutorReply snapshot, no chat history", () => {
        const snap = {
            caseKey: "naca4|a6|Re50000|analytic|fspeed",
            bodyLabel: "naca2412",
            alpha: 6,
            reynolds: 50000,
            cl: 0.823,
            cpMin: -1.42,
            regime: "laminar, attached",
            pathLabel: "analytic potential flow, not validated",
            strouhal: null as number | null,
        };
        const prose = localTutorReply(snap, snap);
        expect(prose).toContain("Try next:");
        expect(prose).toContain("angle of attack (alpha) by 1 deg");
        expect(prose).not.toContain("Caveat:");
        expect(prose).not.toContain("Suggested view");
        const capped = capTutorCaption(prose);
        expect(capped.length).toBeLessThanOrEqual(TUTOR_CAPTION_MAX);
        expect(capped.endsWith(TUTOR_CAPTION_CAVEAT)).toBe(true);
        const report = buildReportData(demoData({ tutorCaption: capped }));
        const physicsAgent = report.rows.find(([k]) => k === "Physics Agent");
        expect(physicsAgent?.[1].length ?? 0).toBeLessThanOrEqual(TUTOR_CAPTION_MAX);
        const text = [report.title, report.footer, ...report.rows.flat()].join(" ");
        expect(text).not.toContain(DOUBLE);
    });
});

describe("caveatForCaption source families", () => {
    it("maps path labels to the matching family tail", () => {
        expect(caveatForCaption("analytic potential flow, not validated")).toBe(TUTOR_CAPTION_CAVEAT);
        expect(caveatForCaption("neural-v3 prediction, phase averaged")).toBe(TUTOR_CAPTION_CAVEAT_NEURAL);
        expect(caveatForCaption("lbm-binary, solved instantaneous snapshot")).toBe(TUTOR_CAPTION_CAVEAT_LBM);
        expect(caveatForCaption("mystery path")).toBe(TUTOR_CAPTION_CAVEAT_PENDING);
        expect(caveatForCaption(undefined)).toBe(TUTOR_CAPTION_CAVEAT_PENDING);
    });
    it("omitted labels keep the legacy analytic tail", () => {
        expect(capTutorCaption("Cl 0.823 at alpha 6.")).toContain(TUTOR_CAPTION_CAVEAT);
    });
});

describe("capTutorCaption lbm and neural paths", () => {
    function snapFor(pathLabel: string) {
        return {
            caseKey: "naca4|a6|Re50000|analytic|fspeed",
            bodyLabel: "naca2412",
            alpha: 6,
            reynolds: 50000,
            cl: 0.823,
            cpMin: -1.42,
            regime: "laminar, attached",
            pathLabel,
            strouhal: null as number | null,
        };
    }
    it("keeps the neural tail for a neural path label, never the analytic one", () => {
        const pathLabel = "neural-v3 prediction, phase averaged, not validated";
        const prose = localTutorReply(snapFor(pathLabel), snapFor(pathLabel));
        expect(prose).toContain("Try next:");
        expect(prose).not.toContain("Caveat:");
        const capped = capTutorCaption(prose, pathLabel);
        expect(capped.length).toBeLessThanOrEqual(TUTOR_CAPTION_MAX);
        expect(capped.endsWith(TUTOR_CAPTION_CAVEAT_NEURAL)).toBe(true);
        expect(capped.endsWith(TUTOR_CAPTION_CAVEAT)).toBe(false);
    });
    it("keeps the LBM tail for an LBM path label, never the analytic one", () => {
        const pathLabel = "lbm-binary, solved instantaneous snapshot";
        const prose = localTutorReply(snapFor(pathLabel), snapFor(pathLabel));
        expect(prose).toContain("Try next:");
        expect(prose).not.toContain("Caveat:");
        const capped = capTutorCaption(prose, pathLabel);
        expect(capped.length).toBeLessThanOrEqual(TUTOR_CAPTION_MAX);
        expect(capped.endsWith(TUTOR_CAPTION_CAVEAT_LBM)).toBe(true);
        expect(capped.endsWith(TUTOR_CAPTION_CAVEAT)).toBe(false);
    });
    it("retips an analytic tail to the LBM tail for an LBM label", () => {
        const prose = "Cl 0.823 at alpha 6 with CpMin -1.420. Caveat: analytic estimate, not validated.";
        const capped = capTutorCaption(prose, "lbm-binary, solved instantaneous snapshot");
        expect(capped).toContain("Cl 0.823");
        expect(capped.endsWith(TUTOR_CAPTION_CAVEAT_LBM)).toBe(true);
        expect(capped.endsWith(TUTOR_CAPTION_CAVEAT)).toBe(false);
        expect(capped.length).toBeLessThanOrEqual(TUTOR_CAPTION_MAX);
    });
    it("falls back to the pending tail for an unknown label", () => {
        const capped = capTutorCaption("Run is queued.", "mystery path");
        expect(capped.endsWith(TUTOR_CAPTION_CAVEAT_PENDING)).toBe(true);
        expect(capped.length).toBeLessThanOrEqual(TUTOR_CAPTION_MAX);
    });
});

describe("buildReportData keeps the provenance tail", () => {
    it("keeps the LBM tail through buildReportData, never retipped to analytic", () => {
        const lbmLabel = "lbm-binary, solved instantaneous snapshot";
        const analyticCapped = capTutorCaption("Cl 0.823 at alpha 6 with CpMin -1.420.", lbmLabel);
        expect(analyticCapped.endsWith(TUTOR_CAPTION_CAVEAT_LBM)).toBe(true);
        const report = buildReportData(demoData({ tutorCaption: analyticCapped, provenance: lbmLabel }));
        const physicsAgent = report.rows.find(([k]) => k === "Physics Agent");
        expect(physicsAgent?.[1].endsWith(TUTOR_CAPTION_CAVEAT_LBM)).toBe(true);
        expect(physicsAgent?.[1].endsWith(TUTOR_CAPTION_CAVEAT)).toBe(false);
    });
    it("keeps the neural tail through buildReportData, never retipped to analytic", () => {
        const neuralLabel = "neural-v3 prediction, phase averaged, not validated";
        const neuralCapped = capTutorCaption("Cl 0.810 at alpha 6 with CpMin -1.400.", neuralLabel);
        expect(neuralCapped.endsWith(TUTOR_CAPTION_CAVEAT_NEURAL)).toBe(true);
        const report = buildReportData(demoData({ tutorCaption: neuralCapped, provenance: neuralLabel }));
        const physicsAgent = report.rows.find(([k]) => k === "Physics Agent");
        expect(physicsAgent?.[1].endsWith(TUTOR_CAPTION_CAVEAT_NEURAL)).toBe(true);
        expect(physicsAgent?.[1].endsWith(TUTOR_CAPTION_CAVEAT)).toBe(false);
    });
    it("retips a stale analytic tail to the LBM tail via buildReportData provenance", () => {
        const lbmLabel = "lbm-binary, solved instantaneous snapshot";
        const stale = `Cl 0.823 at alpha 6. ${TUTOR_CAPTION_CAVEAT}`;
        const report = buildReportData(demoData({ tutorCaption: stale, provenance: lbmLabel }));
        const physicsAgent = report.rows.find(([k]) => k === "Physics Agent");
        expect(physicsAgent?.[1].endsWith(TUTOR_CAPTION_CAVEAT_LBM)).toBe(true);
        expect(physicsAgent?.[1].endsWith(TUTOR_CAPTION_CAVEAT)).toBe(false);
    });
});
