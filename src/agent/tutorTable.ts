// Phase T1 tutor table. Pure before vs after snapshot diff for the flow
// tutor, no React, no DOM, no network. Finite guards on every number, n/a
// for non finite cells, numeric deltas only inside one source family, and
// the source changed marker whenever the family moves. LBM frames never
// quote CpMin, the cell always reads n/a. Never throws.

export type TutorSourceFamily = "lbm" | "neural" | "analytic" | "unknown";

/** Minimal snapshot the tutor table can diff. Numbers may be null when the
 *  run has no clean value yet, labels fall back to n/a in the cells. */
export interface TutorSnapshotLite {
    caseKey: string;
    bodyLabel: string;
    alpha: number | null;
    reynolds: number | null;
    cl: number | null;
    cpMin: number | null;
    regime: string;
    pathLabel: string;
    strouhal: number | null;
}

/** One table row: metric name plus the before, after, and delta cells. */
export interface TutorTableRow {
    metric: string;
    before: string;
    after: string;
    delta: string;
}

function finiteOrNull(v: unknown): number | null {
    return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Tutor text cell cap, matching the agentContext LABEL_MAX of 80 chars
 *  so oversized labels cannot blow the tutor prompt budget. */
const TEXT_MAX = 80;

function capCell(v: string): string {
    return v.length > TEXT_MAX ? `${v.slice(0, TEXT_MAX - 3)}...` : v;
}

function cleanText(v: unknown): string {
    if (typeof v !== "string") return "n/a";
    const t = v.trim().replace(/\s+/g, " ");
    if (t.length === 0) return "n/a";
    return capCell(t);
}

/** Source family from the provenance path label. LBM wins on any lbm
 *  token, neural on any neural token, analytic on analytic or potential
 *  flow tokens, unknown otherwise. Never throws. */
export function tutorSourceFamily(pathLabel: unknown): TutorSourceFamily {
    try {
        const lower = typeof pathLabel === "string" ? pathLabel.toLowerCase() : "";
        if (lower.includes("lbm")) return "lbm";
        if (lower.includes("neural")) return "neural";
        if (lower.includes("analytic") || lower.includes("potential")) return "analytic";
        return "unknown";
    } catch {
        return "unknown";
    }
}

function safeLite(v: TutorSnapshotLite | null | undefined): TutorSnapshotLite {
    const raw = (v ?? {}) as Partial<TutorSnapshotLite>;
    const rawKey = typeof raw.caseKey === "string" ? raw.caseKey.trim().replace(/\s+/g, " ") : "";
    return {
        caseKey: rawKey.length > 0 ? capCell(rawKey) : "n/a",
        bodyLabel: cleanText(raw.bodyLabel),
        alpha: finiteOrNull(raw.alpha),
        reynolds: finiteOrNull(raw.reynolds),
        cl: finiteOrNull(raw.cl),
        cpMin: finiteOrNull(raw.cpMin),
        regime: cleanText(raw.regime),
        pathLabel: cleanText(raw.pathLabel),
        strouhal: finiteOrNull(raw.strouhal),
    };
}

function fmtAlpha(v: number | null): string {
    return v === null ? "n/a" : `${v.toFixed(1)} deg`;
}

function fmtRe(v: number | null): string {
    return v === null ? "n/a" : `${Math.round(v)}`;
}

function fmtCl(v: number | null): string {
    return v === null ? "n/a" : v.toFixed(3);
}

function fmtCp(v: number | null): string {
    return v === null ? "n/a" : v.toFixed(3);
}

function fmtSt(v: number | null): string {
    return v === null ? "n/a" : v.toFixed(2);
}

/** Signed numeric delta when both sides are finite inside one family.
 *  A family move reads source changed, a missing side reads n/a. */
function numericDelta(
    before: number | null,
    after: number | null,
    sameFamily: boolean,
    format: (d: number) => string,
): string {
    if (!sameFamily) return "source changed";
    if (before === null || after === null) return "n/a";
    const d = after - before;
    if (!Number.isFinite(d)) return "n/a";
    const signed = d >= 0 ? `+${format(d)}` : format(d);
    return signed;
}

/**
 * Diff two tutor snapshots into table rows. LBM CpMin cells always read
 * n/a on the LBM side, so the model cannot quote an untrusted suction
 * number. Never throws: null snapshots diff as n/a against n/a.
 */
export function buildTutorTable(
    beforeIn: TutorSnapshotLite | null | undefined,
    afterIn: TutorSnapshotLite | null | undefined,
): TutorTableRow[] {
    try {
        const before = safeLite(beforeIn);
        const after = safeLite(afterIn);
        const sameFamily = tutorSourceFamily(before.pathLabel) === tutorSourceFamily(after.pathLabel);
        const lbmBefore = tutorSourceFamily(before.pathLabel) === "lbm";
        const lbmAfter = tutorSourceFamily(after.pathLabel) === "lbm";
        const cpBefore = lbmBefore ? null : before.cpMin;
        const cpAfter = lbmAfter ? null : after.cpMin;
        return [
            { metric: "Body", before: before.bodyLabel, after: after.bodyLabel, delta: "n/a" },
            {
                metric: "Alpha",
                before: fmtAlpha(before.alpha),
                after: fmtAlpha(after.alpha),
                delta: numericDelta(before.alpha, after.alpha, sameFamily, (d) => `${d.toFixed(1)} deg`),
            },
            {
                metric: "Re",
                before: fmtRe(before.reynolds),
                after: fmtRe(after.reynolds),
                delta: numericDelta(before.reynolds, after.reynolds, sameFamily, (d) => `${Math.round(d)}`),
            },
            {
                metric: "Cl",
                before: fmtCl(before.cl),
                after: fmtCl(after.cl),
                delta: numericDelta(before.cl, after.cl, sameFamily, (d) => d.toFixed(3)),
            },
            {
                metric: "CpMin",
                before: fmtCp(cpBefore),
                after: fmtCp(cpAfter),
                delta: numericDelta(cpBefore, cpAfter, sameFamily, (d) => d.toFixed(3)),
            },
            { metric: "Regime", before: before.regime, after: after.regime, delta: "n/a" },
            { metric: "Path", before: before.pathLabel, after: after.pathLabel, delta: "n/a" },
            {
                metric: "Strouhal",
                before: fmtSt(before.strouhal),
                after: fmtSt(after.strouhal),
                delta: numericDelta(before.strouhal, after.strouhal, sameFamily, (d) => d.toFixed(2)),
            },
        ];
    } catch {
        return [];
    }
}

/** Plain text rendering of tutor rows, one line per row with pipes. */
export function tutorRowsText(rows: TutorTableRow[] | null | undefined): string {
    try {
        if (!Array.isArray(rows) || rows.length === 0) return "pending, no table rows yet";
        const lines = ["Metric | Before | After | Delta"];
        for (const row of rows) {
            const metric = typeof row.metric === "string" ? capCell(row.metric) : "n/a";
            const before = typeof row.before === "string" ? capCell(row.before) : "n/a";
            const after = typeof row.after === "string" ? capCell(row.after) : "n/a";
            const delta = typeof row.delta === "string" ? capCell(row.delta) : "n/a";
            lines.push(`${metric} | ${before} | ${after} | ${delta}`);
        }
        return lines.join("\n");
    } catch {
        return "pending, no table rows yet";
    }
}
