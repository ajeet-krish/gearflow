// GearFlow Phase 5 export report tests. Filename, NaN guard, rows, PDF smoke.
// Copy assertions use escapes so the suite itself carries no decoration runs.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { asFixtureExport, buildReportData, composePng, downloadBlob, exportFilename, exportPdf, type ExportData } from "./exportReport";
import { buildAppExportData } from "@/App";

const { saveCalls } = vi.hoisted(() => ({ saveCalls: [] as Array<string> }));
const { imageCalls } = vi.hoisted(() => ({ imageCalls: [] as Array<{ x: number; y: number; w: number; h: number }> }));

vi.mock("jspdf", () => ({
    jsPDF: class {
        setFont(..._args: Array<unknown>): void {
            void _args;
        }
        setFontSize(..._args: Array<unknown>): void {
            void _args;
        }
        text(..._args: Array<unknown>): void {
            void _args;
        }
        splitTextToSize(text: string, _w: number): Array<string> {
            void _w;
            return [text];
        }
        addImage(..._args: Array<unknown>): void {
            const [, , x, y, w, h] = _args as Array<unknown>;
            imageCalls.push({ x: x as number, y: y as number, w: w as number, h: h as number });
        }
        save(name: string): void {
            saveCalls.push(name);
        }
    },
}));

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
const EMDASH = String.fromCharCode(0x2014);

describe("exportFilename", () => {
    it("builds the canonical name", () => {
        expect(exportFilename(demoData(), "png")).toBe("gearflow-naca2412-a6-re50000.png");
    });
    it("normalizes extension casing and label spacing", () => {
        expect(exportFilename(demoData({ specLabel: "NACA 2412" }), ".PDF")).toBe("gearflow-naca-2412-a6-re50000.pdf");
    });
    it("collapses separator runs to one hyphen and trims edges", () => {
        expect(exportFilename(demoData({ specLabel: "  NACA!!2412  " }), "png")).toBe("gearflow-naca-2412-a6-re50000.png");
        expect(exportFilename(demoData({ specLabel: "---" }), "png")).toBe("gearflow-flow-a6-re50000.png");
        expect(exportFilename(demoData({ specLabel: "" }), "png")).toBe("gearflow-flow-a6-re50000.png");
    });
    it("keeps negative alpha free of double hyphens", () => {
        const name = exportFilename(demoData({ alphaDeg: -2 }), "png");
        expect(name).toBe("gearflow-naca2412-am2-re50000.png");
        expect(name).not.toContain(DOUBLE);
    });
});

describe("buildReportData", () => {
    it("returns title, twelve rows, and footer", () => {
        const report = buildReportData(demoData());
        expect(report.title).toContain("naca2412");
        expect(report.rows.length).toBe(12);
        expect(report.rows.find(([k]) => k === "Cl")?.[1]).toBe("0.823");
        expect(report.rows.find(([k]) => k === "Validation")?.[1]).toBe("3 pass, 2 warn, 0 fail, 4 info");
        expect(report.footer).toContain("1.0.0");
    });
    it("guards non finite numbers with n/a", () => {
        const report = buildReportData(demoData({ cl: Number.NaN, cpMin: Number.POSITIVE_INFINITY, solveMs: Number.NaN }));
        expect(report.rows.find(([k]) => k === "Cl")?.[1]).toBe("n/a");
        expect(report.rows.find(([k]) => k === "Cp min")?.[1]).toBe("n/a");
        expect(report.rows.find(([k]) => k === "Solve")?.[1]).toBe("n/a");
    });
    it("coerces NaN and negative validation counts to zero", () => {
        const report = buildReportData(
            demoData({ validation: { pass: Number.NaN, warn: Number.POSITIVE_INFINITY, fail: -3, info: 2.7 } })
        );
        expect(report.rows.find(([k]) => k === "Validation")?.[1]).toBe("0 pass, 0 warn, 0 fail, 2 info");
    });
    it("renders fixture exports with n/a metrics from pack provenance", () => {
        const base = demoData({ cl: 0.9, cpMin: -1.1, solveMs: 4.4, backend: "analytic live", provenance: "analytic" });
        const fixture = buildAppExportData(base, true, {
            source: "fake-fixture",
            label: "fixture preview, baked demo pack",
            generatedAt: "2026-10-26T00:00:00.000Z",
            gridLabel: "128x128",
            geometryLabel: "naca4",
        });
        expect(Number.isNaN(fixture.cl)).toBe(true);
        expect(Number.isNaN(fixture.cpMin)).toBe(true);
        expect(Number.isNaN(fixture.solveMs)).toBe(true);
        expect(fixture.provenance).toBe("fixture preview, baked demo pack");
        const report = buildReportData(fixture);
        expect(report.rows.find(([k]) => k === "Cl")?.[1]).toBe("n/a");
        expect(report.rows.find(([k]) => k === "Cp min")?.[1]).toBe("n/a");
        expect(report.rows.find(([k]) => k === "Solve")?.[1]).toBe("n/a");
        const live = buildAppExportData(base, false, null);
        expect(live.cl).toBe(0.9);
    });
    it("asFixtureExport keeps the generated stamp from the pack", () => {
        const out = asFixtureExport(demoData(), "pack label", "2026-01-01T00:00:00.000Z");
        expect(out.generatedAt).toBe("2026-01-01T00:00:00.000Z");
        expect(out.provenance).toBe("pack label");
    });
    it("keeps copy free of em dashes and double hyphens", () => {
        const report = buildReportData(demoData());
        const text = [report.title, report.footer, ...report.rows.flat()].join(" ");
        expect(text).not.toContain(EMDASH);
        expect(text).not.toContain(DOUBLE);
    });
});

describe("composePng", () => {
    it("draws header, image, and rows onto one canvas", async () => {
        const texts: Array<string> = [];
        const fakeCtx = {
            fillStyle: "",
            font: "",
            fillRect(): void {},
            fillText(t: string): void {
                texts.push(t);
            },
            drawImage(): void {},
        };
        const fakeCanvas = {
            width: 0,
            height: 0,
            getContext: () => fakeCtx,
            toBlob: (cb: (b: Blob | null) => void) => {
                cb(new Blob(["pixels"], { type: "image/png" }));
            },
        };
        vi.stubGlobal("createImageBitmap", async () => ({ width: 320, height: 160, close(): void {} }));
        vi.stubGlobal("document", { createElement: () => fakeCanvas });
        try {
            const out = await composePng(new Blob(["snap"]), demoData());
            expect(out.type).toBe("image/png");
            expect(texts.join(" ")).toContain("naca2412");
            expect(fakeCanvas.width).toBeGreaterThan(0);
            expect(fakeCanvas.height).toBeGreaterThan(0);
        } finally {
            vi.unstubAllGlobals();
        }
    });
});

describe("downloadBlob", () => {
    it("creates a link, clicks it, and cleans up", () => {
        const clicked: Array<string> = [];
        const link = {
            href: "",
            download: "",
            click(): void {
                clicked.push(link.download);
            },
            remove(): void {},
        };
        vi.stubGlobal("document", { createElement: () => link, body: { appendChild(): void {} } });
        try {
            downloadBlob(new Blob(["x"]), "gearflow-naca2412-a6-re50000.png");
            expect(clicked).toEqual(["gearflow-naca2412-a6-re50000.png"]);
        } finally {
            vi.unstubAllGlobals();
        }
    });
    it("strips directory separators inside the function", () => {
        const clicked: Array<string> = [];
        const link = {
            href: "",
            download: "",
            click(): void {
                clicked.push(link.download);
            },
            remove(): void {},
        };
        vi.stubGlobal("document", { createElement: () => link, body: { appendChild(): void {} } });
        try {
            downloadBlob(new Blob(["x"]), "../../etc/gearflow.png");
            expect(clicked).toEqual(["gearflow.png"]);
            expect(clicked[0]).not.toContain("/");
        } finally {
            vi.unstubAllGlobals();
        }
    });
    it("rejects oversized snapshots before allocation", async () => {
        vi.stubGlobal("createImageBitmap", async () => ({ width: 8000, height: 8000, close(): void {} }));
        vi.stubGlobal("document", { createElement: () => { throw new Error("must not allocate"); } });
        try {
            await expect(composePng(new Blob(["snap"]), demoData())).rejects.toThrow("too large");
        } finally {
            vi.unstubAllGlobals();
        }
    });
});

describe("exportPdf", () => {
    beforeEach(() => {
        saveCalls.length = 0;
        imageCalls.length = 0;
    });
    it("saves a one page sheet through the lazy jspdf chunk", async () => {
        await exportPdf(new Blob(["snap"]), demoData());
        expect(saveCalls).toEqual(["gearflow-naca2412-a6-re50000.pdf"]);
    });
    it("sizes the image from the snapshot aspect instead of a fixed box", async () => {
        vi.stubGlobal("createImageBitmap", async () => ({ width: 400, height: 100, close(): void {} }));
        try {
            await exportPdf(new Blob(["snap"]), demoData());
            expect(imageCalls.length).toBe(1);
            expect(imageCalls[0].w).toBeCloseTo(130, 3);
            expect(imageCalls[0].h).toBeCloseTo(32.5, 3);
        } finally {
            vi.unstubAllGlobals();
        }
    });
    it("splits long provenance rows without throwing", async () => {
        await exportPdf(new Blob(["snap"]), demoData({ provenance: "p ".repeat(400) }));
        expect(saveCalls.length).toBe(1);
    });
    it("still saves when the snapshot cannot decode", async () => {
        const bad = { arrayBuffer: () => Promise.reject(new Error("no bytes")) } as unknown as Blob;
        await exportPdf(bad, demoData({ alphaDeg: -2 }));
        expect(saveCalls).toEqual(["gearflow-naca2412-am2-re50000.pdf"]);
    });
});
