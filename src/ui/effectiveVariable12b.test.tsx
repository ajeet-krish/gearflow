// Effective field variable Phase 12b: selecting k or recirc without the
// channel renders speed on the very first pass. App derives the effective
// variable during render and never patches the stored preference, so
// returning to LBM mode restores the user's choice. Chips additionally
// require the first statistics sample, since the worker always ships the
// channels (all zero before sampling).

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import FieldBar, { fallbackVariableFor } from "./FieldBar";
import type { FlowField } from "@/contracts/types";
import { DEFAULT_DOMAIN } from "@/contracts/types";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = resolve(here, "../App.tsx");

const noop = () => {};

function makeFlow(over: Partial<FlowField> = {}): FlowField {
    const nx = 8;
    const ny = 6;
    const n = nx * ny;
    return {
        nx, ny, domain: { ...DEFAULT_DOMAIN },
        u: new Float32Array(n).fill(1),
        v: new Float32Array(n),
        p: new Float32Array(n),
        omega: new Float32Array(n),
        obstacle: new Float32Array(n),
        ...over,
    };
}

function buttonTag(html: string, label: string): string {
    const close = `>${label}</button>`;
    const end = html.indexOf(close);
    expect(end).toBeGreaterThan(-1);
    const start = html.lastIndexOf("<button", end);
    return html.slice(start, end + close.length);
}

describe("effective field variable on the first pass", () => {
    it("renders velocity when k is selected but the frame lacks k, with no effect", () => {
        const flow = makeFlow();
        const effective = fallbackVariableFor("k", flow);
        expect(effective).toBe("speed");
        // Static markup never runs effects, so this is the first pass.
        const html = renderToStaticMarkup(
            <FieldBar variable={effective} onVariable={noop} hasTke={false} hasRecirc={false} />,
        );
        expect(buttonTag(html, "VELOCITY")).toContain("active");
        expect(buttonTag(html, "TKE")).not.toContain("active");
    });

    it("renders velocity when recirc is selected but the frame lacks recirc, with no effect", () => {
        const flow = makeFlow();
        const effective = fallbackVariableFor("recirc", flow);
        expect(effective).toBe("speed");
        const html = renderToStaticMarkup(
            <FieldBar variable={effective} onVariable={noop} hasTke={false} hasRecirc={false} />,
        );
        expect(buttonTag(html, "VELOCITY")).toContain("active");
        expect(buttonTag(html, "RECIRC")).not.toContain("active");
    });

    it("keeps k when the frame carries the channel", () => {
        const flow = makeFlow({ k: new Float32Array(48).fill(0.01) });
        const effective = fallbackVariableFor("k", flow);
        expect(effective).toBe("k");
        const html = renderToStaticMarkup(
            <FieldBar variable={effective} onVariable={noop} hasTke={true} hasRecirc={false} />,
        );
        expect(buttonTag(html, "TKE")).toContain("active");
    });
});

describe("App effective variable wiring", () => {
    it("derives the effective variable during render and recouples overlays through the funnel", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).toContain("const effectiveVariable = fallbackVariableFor(prefs.variable, flow)");
        expect(src).toContain("resolveOverlays(effectiveVariable, prefs)");
        // The single chip funnel recouple the overlays and clears the pin.
        expect(src).toContain("overlayPatchForFieldChange(next)");
    });

    it("passes the effective variable to the FIELD bar, canvas, and colorbar", async () => {
        const src = await readFile(appPath, "utf8");
        // FIELD bar chips plus the vertical colorbar share the derived
        // variable, the canvas takes it as the field mode. The terminal
        // strip carries engine/grid/Re/step.
        expect(src).toContain("fieldMode={effectiveVariable}");
        expect(src.match(/variable=\{effectiveVariable\}/g)?.length).toBeGreaterThanOrEqual(2);
        expect(src).toContain("<RunTerminal");
    });

    it("requires the statistics sample as well as the channel for the chips", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).toContain("lbmStatsReady && flow.k !== undefined");
        expect(src).toContain("lbmStatsReady && flow.recirc !== undefined");
    });
});
