// GearFlow Phase 5 export bar. Quiet utility row under the hero canvas.
// PNG composes live pixels plus report rows, PDF renders a one page A4 sheet
// through lazily loaded jsPDF, Print uses the clean print stylesheet.
// No animation, reduced motion safe by construction.

import { useState } from "react";
import { composePng, downloadBlob, exportFilename, exportPdf, type ExportData } from "@/export/exportReport";

interface ExportBarProps {
    getSnapshot: () => Promise<Blob | null>;
    data: ExportData | null;
}

type BusyKind = "png" | "pdf" | "print" | null;

function finite(v: number, digits: number): string {
    return Number.isFinite(v) ? v.toFixed(digits) : "n/a";
}

export default function ExportBar({ getSnapshot, data }: ExportBarProps) {
    const [busy, setBusy] = useState<BusyKind>(null);
    const [note, setNote] = useState<string | null>(null);

    const summary = data
        ? `Cl ${finite(data.cl, 3)}, CpMin ${finite(data.cpMin, 3)}, Re${Number.isFinite(data.reynolds) ? Math.round(data.reynolds) : "n/a"}, ${data.gridLabel}, ${data.specLabel}. ${data.provenance}`
        : "Solve a field to enable export.";

    async function onPng(): Promise<void> {
        if (!data || busy !== null) return;
        setBusy("png");
        setNote(null);
        try {
            const snap = await getSnapshot();
            if (!snap) throw new Error("Canvas not ready yet. Wait for the field to paint, then retry.");
            const composed = await composePng(snap, data);
            downloadBlob(composed, exportFilename(data, "png"));
            setNote(`Saved ${exportFilename(data, "png")}.`);
        } catch (e) {
            setNote(e instanceof Error ? e.message : "PNG export failed. Retry once.");
        } finally {
            setBusy(null);
        }
    }

    async function onPdf(): Promise<void> {
        if (!data || busy !== null) return;
        setBusy("pdf");
        setNote(null);
        try {
            const snap = await getSnapshot();
            if (!snap) throw new Error("Canvas not ready yet. Wait for the field to paint, then retry.");
            await exportPdf(snap, data);
            setNote(`Saved ${exportFilename(data, "pdf")}.`);
        } catch (e) {
            setNote(e instanceof Error ? e.message : "PDF export failed. Retry once.");
        } finally {
            setBusy(null);
        }
    }

    function onPrint(): void {
        if (busy !== null) return;
        setBusy("print");
        setNote(null);
        try {
            window.print();
        } catch (e) {
            setNote(e instanceof Error ? e.message : "Print failed. Retry once.");
        } finally {
            window.setTimeout(() => setBusy(null), 300);
        }
    }

    return (
        <div className="exportBar" role="group" aria-label="Export this run">
            <p className="exportSummary mono" role="status" aria-label="Current run summary for export">
                {summary}
            </p>
            <div className="exportActions">
                <button
                    type="button"
                    className="exportBtn"
                    onClick={() => void onPng()}
                    disabled={busy !== null || data === null}
                    aria-busy={busy === "png"}
                    aria-label="Export canvas plus report rows as PNG image"
                >
                    {busy === "png" ? "Capturing" : "PNG"}
                </button>
                <button
                    type="button"
                    className="exportBtn"
                    onClick={() => void onPdf()}
                    disabled={busy !== null || data === null}
                    aria-busy={busy === "pdf"}
                    aria-label="Export report as PDF, one page A4 sheet"
                    aria-describedby="exportPdfHint"
                >
                    {busy === "pdf" ? "Composing" : "PDF"}
                </button>
                <button
                    type="button"
                    className="exportBtn"
                    onClick={onPrint}
                    disabled={busy !== null}
                    aria-busy={busy === "print"}
                    aria-label="Print the clean report layout"
                >
                    {busy === "print" ? "Opening" : "Print"}
                </button>
            </div>
            <p className="exportHint mono" id="exportPdfHint">
                PNG saves pixels plus rows. PDF renders a one page sheet offline. Print uses the clean sheet layout.
            </p>
            {note !== null && (
                <p className="exportNote" role="alert">
                    {note}
                </p>
            )}
        </div>
    );
}
