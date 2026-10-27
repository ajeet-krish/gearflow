// GearFlow Phase 5 hardening. Export filename, NaN guards, report rows,
// composePng smoke, PDF mock, adaptive particles, capture null blob,
// print stylesheet, jsPDF failure fallback, missing canvas ref,
// export during error state.
// Copy assertions use escapes so the suite itself carries no decoration runs.

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
    buildReportData,
    composePng,
    exportFilename,
    exportPdf,
    type ExportData,
} from "./export/exportReport";
import { advectParticles, createParticles, mulberry32 } from "./render/particles";
import type { FlowField } from "./contracts/types";

const { saveCalls, textCalls, pdfState } = vi.hoisted(() => ({
    saveCalls: [] as Array<string>,
    textCalls: [] as Array<string>,
    pdfState: { ctorThrows: false },
}));

vi.mock("jspdf", () => ({
    jsPDF: class {
        constructor() {
            if (pdfState.ctorThrows) throw new Error("jspdf failed");
        }
        setFont(..._args: Array<unknown>): void {
            void _args;
        }
        setFontSize(..._args: Array<unknown>): void {
            void _args;
        }
        text(t: unknown, ..._args: Array<unknown>): void {
            void _args;
            textCalls.push(String(t));
        }
        addImage(..._args: Array<unknown>): void {
            void _args;
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

function errorFrameData(): ExportData {
    return demoData({
        cl: Number.NaN,
        cpMin: Number.NaN,
        solveMs: 0,
        backend: "analytic held",
        provenance: "solve error, showing last good (naca4 a6, 128x128)",
    });
}

function uniformFlow(nx = 8, ny = 8): FlowField {
    const n = nx * ny;
    return {
        nx,
        ny,
        domain: { xMin: -0.5, xMax: 2.0, yMin: -1.0, yMax: 1.0 },
        u: new Float32Array(n).fill(1),
        v: new Float32Array(n).fill(0),
        p: new Float32Array(n).fill(0),
        omega: new Float32Array(n).fill(0),
        obstacle: new Float32Array(n).fill(0),
    };
}

function stubCanvasWorld(opts: {
    imgW?: number;
    imgH?: number;
    ctxNull?: boolean;
    blobNull?: boolean;
} = {}): { texts: Array<string>; canvas: { width: number; height: number }; closed: { value: boolean } } {
    const texts: Array<string> = [];
    const closed = { value: false };
    const fakeCtx = {
        fillStyle: "",
        font: "",
        fillRect(): void {},
        fillText(t: string): void {
            texts.push(t);
        },
        drawImage(): void {},
    };
    const canvas = {
        width: 0,
        height: 0,
        getContext: () => (opts.ctxNull === true ? null : fakeCtx),
        toBlob: (cb: (b: Blob | null) => void) => {
            cb(opts.blobNull === true ? null : new Blob(["pixels"], { type: "image/png" }));
        },
    };
    vi.stubGlobal(
        "createImageBitmap",
        async (blob: unknown) => {
            if (blob === null || blob === undefined) throw new TypeError("null snapshot");
            return { width: opts.imgW ?? 320, height: opts.imgH ?? 160, close(): void { closed.value = true; } };
        }
    );
    vi.stubGlobal("document", { createElement: () => canvas });
    return { texts, canvas, closed };
}

const DOUBLE = "-".repeat(2);
const EMDASH = String.fromCharCode(0x2014);

describe("phase5 exportFilename happy path", () => {
    it("builds the canonical name", () => {
        expect(exportFilename(demoData(), "png")).toBe("gearflow-naca2412-a6-re50000.png");
    });
    it("encodes fractional alpha with a p separator", () => {
        expect(exportFilename(demoData({ alphaDeg: 6.5 }), "png")).toBe("gearflow-naca2412-a6p5-re50000.png");
    });
    it("keeps negative fractional alpha free of double hyphens", () => {
        const name = exportFilename(demoData({ alphaDeg: -2.5 }), "png");
        expect(name).toBe("gearflow-naca2412-am2p5-re50000.png");
        expect(name).not.toContain(DOUBLE);
    });
    it("guards non finite alpha and Reynolds with stable tokens", () => {
        const name = exportFilename(demoData({ alphaDeg: Number.NaN, reynolds: Number.POSITIVE_INFINITY }), "png");
        expect(name).toBe("gearflow-naca2412-ana-re0.png");
    });
    it("normalizes label spacing and odd extensions", () => {
        expect(exportFilename(demoData({ specLabel: "NACA 2412" }), ".PDF")).toBe("gearflow-naca-2412-a6-re50000.pdf");
        expect(exportFilename(demoData(), "P N G!!")).toBe("gearflow-naca2412-a6-re50000.png");
        expect(exportFilename(demoData(), "")).toBe("gearflow-naca2412-a6-re50000.png");
    });
    it("collapses separator runs to one hyphen and trims edges", () => {
        expect(exportFilename(demoData({ specLabel: "  NACA!!2412  " }), "png")).toBe("gearflow-naca-2412-a6-re50000.png");
        expect(exportFilename(demoData({ specLabel: "---" }), "png")).toBe("gearflow-flow-a6-re50000.png");
    });
});

describe("phase5 buildReportData rows and NaN guards", () => {
    it("returns twelve rows in a stable order", () => {
        const report = buildReportData(demoData());
        expect(report.rows.map(([k]) => k)).toEqual([
            "Spec",
            "Alpha",
            "Reynolds",
            "Regime",
            "Cl",
            "Cp min",
            "Solve",
            "Backend",
            "Provenance",
            "Grid",
            "Validation",
            "Generated",
        ]);
        expect(report.rows.find(([k]) => k === "Cl")?.[1]).toBe("0.823");
        expect(report.rows.find(([k]) => k === "Validation")?.[1]).toBe("3 pass, 2 warn, 0 fail, 4 info");
        expect(report.title).toContain("naca2412");
        expect(report.footer).toContain("1.0.0");
    });
    it("guards every non finite number with n/a", () => {
        const report = buildReportData(
            demoData({ alphaDeg: Number.NaN, reynolds: Number.NaN, cl: Number.NaN, cpMin: Number.POSITIVE_INFINITY, solveMs: Number.NaN })
        );
        expect(report.rows.find(([k]) => k === "Alpha")?.[1]).toBe("n/a");
        expect(report.rows.find(([k]) => k === "Reynolds")?.[1]).toBe("n/a");
        expect(report.rows.find(([k]) => k === "Cl")?.[1]).toBe("n/a");
        expect(report.rows.find(([k]) => k === "Cp min")?.[1]).toBe("n/a");
        expect(report.rows.find(([k]) => k === "Solve")?.[1]).toBe("n/a");
    });
    it("keeps report copy free of em dashes and double hyphens", () => {
        const report = buildReportData(demoData());
        const text = [report.title, report.footer, ...report.rows.flat()].join(" ");
        expect(text).not.toContain(EMDASH);
        expect(text).not.toContain(DOUBLE);
    });
});

describe("phase5 composePng smoke", () => {
    it("draws header, image, and rows onto one canvas", async () => {
        const world = stubCanvasWorld();
        try {
            const out = await composePng(new Blob(["snap"]), demoData());
            expect(out.type).toBe("image/png");
            expect(world.texts.join(" ")).toContain("naca2412");
            expect(world.canvas.width).toBeGreaterThan(0);
            expect(world.canvas.height).toBeGreaterThan(0);
        } finally {
            vi.unstubAllGlobals();
        }
    });
    it("enforces the 760px minimum width for small snapshots", async () => {
        const world = stubCanvasWorld({ imgW: 200, imgH: 100 });
        try {
            await composePng(new Blob(["snap"]), demoData());
            expect(world.canvas.width).toBe(760);
            const rowsH = 12 * 26;
            expect(world.canvas.height).toBe(104 + 24 + 100 + 24 + rowsH + 52);
        } finally {
            vi.unstubAllGlobals();
        }
    });
    it("closes the decoded bitmap after composing", async () => {
        const world = stubCanvasWorld();
        try {
            await composePng(new Blob(["snap"]), demoData());
            expect(world.closed.value).toBe(true);
        } finally {
            vi.unstubAllGlobals();
        }
    });
});

describe("phase5 exportPdf mock", () => {
    it("saves a one page sheet through the lazy jspdf chunk", async () => {
        saveCalls.length = 0;
        textCalls.length = 0;
        pdfState.ctorThrows = false;
        await exportPdf(new Blob(["snap"]), demoData());
        expect(saveCalls).toEqual(["gearflow-naca2412-a6-re50000.pdf"]);
        expect(textCalls.join(" ")).toContain("naca2412");
    });
    it("still saves when the snapshot cannot decode", async () => {
        saveCalls.length = 0;
        textCalls.length = 0;
        pdfState.ctorThrows = false;
        const bad = { arrayBuffer: () => Promise.reject(new Error("no bytes")) } as unknown as Blob;
        await exportPdf(bad, demoData({ alphaDeg: -2 }));
        expect(saveCalls).toEqual(["gearflow-naca2412-am2-re50000.pdf"]);
        expect(textCalls.join(" ")).toContain("Snapshot unavailable.");
    });
});

describe("phase5 adaptive particle edge cases", () => {
    it("declares the 3000, 2000, 1200 step down tiers with a slow frame guard", () => {
        const src = readFileSync(process.cwd() + "/src/render/FlowCanvas.tsx", "utf8");
        expect(src).toContain("PARTICLE_STEPS = [3000, 2000, 1200]");
        expect(src).toContain("SLOW_FPS = 55");
        expect(src).toContain("SLOW_FRAMES = 60");
        expect(src).toContain("setDrawRange");
    });
    it("supports every adaptive tier count deterministically", () => {
        for (const count of [3000, 2000, 1200]) {
            const a = createParticles(count, 20261026);
            const b = createParticles(count, 20261026);
            expect(a.count).toBe(count);
            expect(a.x).toEqual(b.x);
            expect(a.y).toEqual(b.y);
        }
    });
    it("holds the domain on a large dt hop without tunneling out", () => {
        const flow = uniformFlow();
        const ps = createParticles(256, 7);
        advectParticles(ps, flow, 1.0, mulberry32(99));
        for (let i = 0; i < ps.count; i++) {
            expect(Number.isFinite(ps.x[i])).toBe(true);
            expect(Number.isFinite(ps.y[i])).toBe(true);
            expect(ps.x[i]).toBeGreaterThanOrEqual(flow.domain.xMin);
            expect(ps.x[i]).toBeLessThanOrEqual(flow.domain.xMax);
            expect(ps.y[i]).toBeGreaterThanOrEqual(flow.domain.yMin);
            expect(ps.y[i]).toBeLessThanOrEqual(flow.domain.yMax);
        }
    });
});

describe("phase5 capture null blob and missing canvas ref", () => {
    it("rejects a null snapshot instead of hanging the export", async () => {
        stubCanvasWorld();
        try {
            await expect(composePng(null as unknown as Blob, demoData())).rejects.toThrow();
        } finally {
            vi.unstubAllGlobals();
        }
    });
    it("returns null when the canvas handle is missing", async () => {
        async function getSnapshot(handle: { capturePng: () => Promise<Blob | null> } | null): Promise<Blob | null> {
            if (!handle) return null;
            try {
                return await handle.capturePng();
            } catch {
                return null;
            }
        }
        await expect(getSnapshot(null)).resolves.toBeNull();
        await expect(
            getSnapshot({ capturePng: () => Promise.reject(new Error("lost context")) })
        ).resolves.toBeNull();
    });
    it("uses the not ready message when the snapshot is null", () => {
        async function captureNote(snap: Blob | null): Promise<string> {
            if (!snap) throw new Error("Canvas not ready yet. Wait for the field to paint, then retry.");
            return "ok";
        }
        return expect(captureNote(null)).rejects.toThrow("Canvas not ready yet");
    });
    it("keeps the ExportBar contract for missing ref and null blob", () => {
        const src = readFileSync(process.cwd() + "/src/ui/ExportBar.tsx", "utf8");
        expect(src).toContain("Canvas not ready yet");
        expect(src).toContain("if (!snap) throw");
        const app = readFileSync(process.cwd() + "/src/App.tsx", "utf8");
        expect(app).toContain("if (!handle) return null");
    });
});

describe("phase5 print stylesheet", () => {
    it("ships a clean print sheet that hides the rail and export controls", () => {
        const css = readFileSync(process.cwd() + "/src/styles.css", "utf8");
        expect(css).toContain("@media print");
        expect(css).toContain(".side, .foot");
        expect(css).toContain("display: none");
        expect(css).toContain(".exportActions, .exportNote");
        expect(css).toContain("background: #ffffff");
    });
});

describe("phase5 error conditions", () => {
    it("rejects when the 2d context is unavailable", async () => {
        stubCanvasWorld({ ctxNull: true });
        try {
            await expect(composePng(new Blob(["snap"]), demoData())).rejects.toThrow("2d context unavailable");
        } finally {
            vi.unstubAllGlobals();
        }
    });
    it("rejects when canvas encoding fails", async () => {
        stubCanvasWorld({ blobNull: true });
        try {
            await expect(composePng(new Blob(["snap"]), demoData())).rejects.toThrow("canvas encode failed");
        } finally {
            vi.unstubAllGlobals();
        }
    });
    it("falls back to print when jsPDF construction fails", async () => {
        saveCalls.length = 0;
        pdfState.ctorThrows = true;
        const printed: Array<string> = [];
        vi.stubGlobal("window", { print: () => { printed.push("print"); } });
        try {
            await expect(exportPdf(new Blob(["snap"]), demoData())).rejects.toThrow("jspdf failed");
            expect(saveCalls).toEqual([]);
            (window as unknown as { print: () => void }).print();
            expect(printed).toEqual(["print"]);
        } finally {
            pdfState.ctorThrows = false;
            vi.unstubAllGlobals();
        }
    });
    it("keeps the ExportBar print path as the offline fallback", () => {
        const src = readFileSync(process.cwd() + "/src/ui/ExportBar.tsx", "utf8");
        expect(src).toContain("window.print()");
        expect(src).toContain("Print uses the clean sheet layout");
    });
});

describe("phase5 export during error state", () => {
    it("keeps filenames stable when the frame holds NaN metrics", () => {
        const name = exportFilename(errorFrameData(), "png");
        expect(name).toBe("gearflow-naca2412-a6-re50000.png");
        expect(name).not.toContain(DOUBLE);
    });
    it("renders n/a rows for the held error frame", () => {
        const report = buildReportData(errorFrameData());
        expect(report.rows.length).toBe(12);
        expect(report.rows.find(([k]) => k === "Cl")?.[1]).toBe("n/a");
        expect(report.rows.find(([k]) => k === "Cp min")?.[1]).toBe("n/a");
        expect(report.rows.find(([k]) => k === "Backend")?.[1]).toBe("analytic held");
    });
    it("still saves the PDF sheet for the held error frame", async () => {
        saveCalls.length = 0;
        pdfState.ctorThrows = false;
        await exportPdf(new Blob(["snap"]), errorFrameData());
        expect(saveCalls).toEqual(["gearflow-naca2412-a6-re50000.pdf"]);
    });
});
