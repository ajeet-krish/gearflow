// GearFlow Phase 5 export report. Pure report logic plus browser download helpers.
// Text stays plain ASCII with commas and colons only, so PNG, PDF, and print agree.

export interface ValidationCounts {
    pass: number;
    warn: number;
    fail: number;
    info: number;
}

export interface ExportData {
    specLabel: string;
    alphaDeg: number;
    reynolds: number;
    regime: string;
    cl: number;
    cpMin: number;
    solveMs: number;
    backend: string;
    provenance: string;
    gridLabel: string;
    validation: ValidationCounts;
    generatedAt: string;
}

export interface ReportData {
    title: string;
    rows: Array<[string, string]>;
    footer: string;
}

function finiteCount(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return 0;
    const floored = Math.floor(value);
    return floored < 0 ? 0 : floored;
}

function finiteText(value: number, digits: number): string {
    if (!Number.isFinite(value)) return "n/a";
    return value.toFixed(digits);
}

function slugify(label: string): string {
    const slug = label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+/, "")
        .replace(/-+$/, "");
    return slug.length > 0 ? slug : "flow";
}

function alphaToken(alphaDeg: number): string {
    if (!Number.isFinite(alphaDeg)) return "ana";
    const rounded = Math.round(alphaDeg * 10) / 10;
    return `a${String(rounded).replace("-", "m").replace(".", "p")}`;
}

function reToken(reynolds: number): string {
    if (!Number.isFinite(reynolds)) return "re0";
    return `re${Math.round(reynolds)}`;
}

/** Stable download name with single hyphens only, for example gearflow-naca2412-a6-re50000.png. */
export function exportFilename(d: ExportData, ext: string): string {
    const clean = ext.toLowerCase().replace(/^\./, "").replace(/[^a-z0-9]+/g, "");
    const suffix = clean.length > 0 ? clean : "png";
    return `gearflow-${slugify(d.specLabel)}-${alphaToken(d.alphaDeg)}-${reToken(d.reynolds)}.${suffix}`;
}

export function buildReportData(d: ExportData): ReportData {
    const alphaText = Number.isFinite(d.alphaDeg) ? `${d.alphaDeg} deg` : "n/a";
    const reText = Number.isFinite(d.reynolds) ? String(Math.round(d.reynolds)) : "n/a";
    const solveText = Number.isFinite(d.solveMs) ? `${d.solveMs.toFixed(1)} ms` : "n/a";
    const v = d.validation;
    const pass = finiteCount(v.pass);
    const warn = finiteCount(v.warn);
    const fail = finiteCount(v.fail);
    const info = finiteCount(v.info);
    const title = `GearFlow report, ${d.specLabel} at alpha ${alphaText}, Re ${reText}`;
    const rows: Array<[string, string]> = [
        ["Spec", d.specLabel],
        ["Alpha", alphaText],
        ["Reynolds", reText],
        ["Regime", d.regime],
        ["Cl", finiteText(d.cl, 3)],
        ["Cp min", finiteText(d.cpMin, 3)],
        ["Solve", solveText],
        ["Backend", d.backend],
        ["Provenance", d.provenance],
        ["Grid", d.gridLabel],
        ["Validation", `${pass} pass, ${warn} warn, ${fail} fail, ${info} info`],
        ["Generated", d.generatedAt],
    ];
    const footer = "GearFlow 1.0.0, Phase 5 export. Offline capable, analytic core.";
    return { title, rows, footer };
}

/** Fixture mode carries no solved numbers. Clamp metrics to NaN so the
 *  sheet renders n/a instead of misattributing the last analytic solve. */
export function asFixtureExport(base: ExportData, provenance: string, generatedAt: string): ExportData {
    return { ...base, cl: Number.NaN, cpMin: Number.NaN, solveMs: Number.NaN, provenance, generatedAt };
}

type SizedImage = CanvasImageSource & { width: number; height: number; close?: () => void };

async function loadImageSource(blob: Blob): Promise<SizedImage> {
    if (typeof createImageBitmap === "function") {
        const bmp = await createImageBitmap(blob);
        return bmp as unknown as SizedImage;
    }
    const url = URL.createObjectURL(blob);
    try {
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
            const el = new Image();
            el.onload = () => resolve(el);
            el.onerror = () => reject(new Error("snapshot decode failed"));
            el.src = url;
        });
        return img as unknown as SizedImage;
    } finally {
        URL.revokeObjectURL(url);
    }
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
    return new Promise((resolve, reject) => {
        canvas.toBlob((b) => {
            if (b) resolve(b);
            else reject(new Error("canvas encode failed"));
        }, "image/png");
    });
}

/** Compose the live snapshot plus header and report rows onto one PNG. Browser only. */
export async function composePng(snapshot: Blob, d: ExportData): Promise<Blob> {
    if (snapshot === null || snapshot === undefined) throw new TypeError("snapshot is null, canvas not ready yet");
    const MAX_EXPORT_DIM = 4096;
    const MAX_EXPORT_PIXELS = 16777216;
    const report = buildReportData(d);
    const img = await loadImageSource(snapshot);
    try {
        const PAD = 24;
        const HEADER_H = 104;
        const ROW_H = 26;
        const FOOTER_H = 52;
        const rawW = Number.isFinite(img.width) ? Math.round(img.width) : 0;
        const rawH = Number.isFinite(img.height) ? Math.round(img.height) : 0;
        if (rawW <= 0 || rawH <= 0) throw new Error("snapshot has no pixels");
        if (rawW > MAX_EXPORT_DIM || rawH > MAX_EXPORT_DIM || rawW * rawH > MAX_EXPORT_PIXELS) {
            throw new Error("snapshot too large, reduce the canvas size and retry");
        }
        const imgW = Math.max(1, rawW);
        const imgH = Math.max(1, rawH);
        const width = Math.max(imgW + PAD * 2, 760);
        const rowsH = report.rows.length * ROW_H;
        const height = HEADER_H + PAD + imgH + PAD + rowsH + FOOTER_H;
        if (width > MAX_EXPORT_DIM || height > MAX_EXPORT_DIM || width * height > MAX_EXPORT_PIXELS) {
            throw new Error("composed sheet too large, reduce the canvas size and retry");
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("2d context unavailable");
        ctx.fillStyle = "#0e141b";
        ctx.fillRect(0, 0, width, HEADER_H);
        ctx.fillStyle = "#f4f1e8";
        ctx.font = "650 26px system-ui, sans-serif";
        ctx.fillText(report.title, PAD, 40);
        ctx.font = "13px ui-monospace, monospace";
        ctx.fillStyle = "#cfd6cd";
        ctx.fillText(`${d.backend}, ${d.gridLabel}, generated ${d.generatedAt}`, PAD, 68);
        ctx.fillStyle = "#f4f1e8";
        ctx.fillRect(0, HEADER_H, width, height - HEADER_H);
        ctx.drawImage(img, PAD, HEADER_H + PAD, imgW, imgH);
        let y = HEADER_H + PAD + imgH + PAD + 18;
        ctx.font = "13px ui-monospace, monospace";
        for (const [label, value] of report.rows) {
            const cell = value.length > 160 ? `${value.slice(0, 157)}...` : value;
            ctx.fillStyle = "#5a6b7a";
            ctx.fillText(label, PAD, y);
            ctx.fillStyle = "#0e141b";
            ctx.fillText(cell, PAD + 150, y);
            y += ROW_H;
        }
        ctx.fillStyle = "#5a6b7a";
        ctx.fillText(report.footer, PAD, height - 18);
        return await canvasToBlob(canvas);
    } finally {
        if (typeof img.close === "function") img.close();
    }
}

async function blobToDataUrl(blob: Blob): Promise<string> {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
    }
    return `data:image/png;base64,${btoa(binary)}`;
}

/** Export a one page A4 landscape PDF. jsPDF loads lazily here only, never on boot. */
export async function exportPdf(snapshot: Blob, d: ExportData): Promise<void> {
    const { jsPDF } = await import("jspdf");
    const report = buildReportData(d);
    const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
    const splitLines = (text: string, maxWidth: number): Array<string> => {
        const peer = doc as unknown as { splitTextToSize?: (t: string, w: number) => Array<string> };
        if (typeof peer.splitTextToSize === "function") return peer.splitTextToSize(text, maxWidth);
        const out: Array<string> = [];
        let rest = text;
        while (rest.length > 90) {
            out.push(rest.slice(0, 90));
            rest = rest.slice(90);
        }
        out.push(rest);
        return out;
    };
    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    for (const line of splitLines(report.title, 270)) {
        doc.text(line, 14, 16);
    }
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    let y = 26;
    const ROW_MAX_Y = 182;
    let truncated = false;
    for (const [label, rawValue] of report.rows) {
        const value = rawValue.length > 500 ? `${rawValue.slice(0, 497)}...` : rawValue;
        const lines = splitLines(`${label}: ${value}`, 124);
        for (const line of lines) {
            if (y > ROW_MAX_Y) {
                truncated = true;
                break;
            }
            doc.text(line, 14, y);
            y += 7;
        }
        if (truncated) break;
    }
    if (truncated && y <= ROW_MAX_Y + 7) {
        doc.text("(rows truncated to fit one page)", 14, Math.min(y, 189));
    }
    doc.setFontSize(9);
    doc.text(report.footer, 14, 196);
    try {
        const dims = await snapshotDims(snapshot);
        const IMG_X = 150;
        const IMG_MAX_W = 130;
        const IMG_MAX_H = 110;
        let imgW = IMG_MAX_W;
        let imgH = 80;
        if (dims !== null && dims.w > 0 && dims.h > 0) {
            const hFromW = (IMG_MAX_W * dims.h) / dims.w;
            if (hFromW <= IMG_MAX_H) {
                imgW = IMG_MAX_W;
                imgH = hFromW;
            } else {
                imgW = (IMG_MAX_H * dims.w) / dims.h;
                imgH = IMG_MAX_H;
            }
        }
        const dataUrl = await blobToDataUrl(snapshot);
        doc.addImage(dataUrl, "PNG", IMG_X, 26, imgW, imgH);
    } catch {
        doc.text("Snapshot unavailable.", 150, 30);
    }
    doc.save(exportFilename(d, "pdf"));
}

async function snapshotDims(snapshot: Blob): Promise<{ w: number; h: number } | null> {
    try {
        const img = await loadImageSource(snapshot);
        try {
            return { w: img.width, h: img.height };
        } finally {
            if (typeof img.close === "function") img.close();
        }
    } catch {
        return null;
    }
}

export function downloadBlob(blob: Blob, filename: string): void {
    if (typeof document === "undefined" || typeof URL === "undefined") return;
    const base = String(filename ?? "").split("/").pop()?.split("\\").pop()?.trim() ?? "";
    const stripped = base.replace(/[\0-\x1f\x7f]+/g, "").replace(/\.+/g, (m) => (m.length > 1 ? "." : m));
    const safe = stripped.length > 0 ? stripped.slice(0, 128) : "gearflow-export.png";
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = safe;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
