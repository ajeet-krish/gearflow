// FieldBar Phase 12b: TKE and RECIRC chips gate on frame channels.
// A disabled chip carries a reason and can never fire onVariable because
// native disabled buttons do not dispatch click events.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import FieldBar, { fallbackVariableFor } from "./FieldBar";

const noop = () => {};

function render(variable: "speed" | "k" | "recirc" = "speed", extra: Record<string, boolean> = {}) {
    return renderToStaticMarkup(
        <FieldBar variable={variable} onVariable={noop} {...extra} />,
    );
}

function buttonTag(html: string, label: string): string {
    const close = `>${label}</button>`;
    const end = html.indexOf(close);
    expect(end).toBeGreaterThan(-1);
    const start = html.lastIndexOf("<button", end);
    return html.slice(start, end + close.length);
}

describe("FieldBar TKE and RECIRC gating", () => {
    it("renders TKE and RECIRC chips beside the existing three", () => {
        const html = render();
        for (const label of ["SPEED", "PRESSURE", "VORTICITY", "TKE", "RECIRC"]) {
            expect(html).toContain(label);
        }
    });

    it("disables TKE without the channel and names the reason", () => {
        const html = render("speed", {});
        const tag = buttonTag(html, "TKE");
        expect(tag).toContain("disabled");
        expect(tag).toContain("Available after the first LBM statistics sample");
    });

    it("disables RECIRC without the channel and names the reason", () => {
        const html = render();
        const tag = buttonTag(html, "RECIRC");
        expect(tag).toContain("disabled");
        expect(tag).toContain("Available after the first LBM statistics sample");
    });

    it("enables TKE and RECIRC when the frame carries the channels", () => {
        const html = render("speed", { hasTke: true, hasRecirc: true });
        expect(buttonTag(html, "TKE")).not.toContain("disabled");
        expect(buttonTag(html, "RECIRC")).not.toContain("disabled");
    });

    it("marks the active chip when TKE or RECIRC is selected", () => {
        const tke = render("k", { hasTke: true, hasRecirc: true });
        expect(buttonTag(tke, "TKE")).toContain("active");
        const recirc = render("recirc", { hasTke: true, hasRecirc: true });
        expect(buttonTag(recirc, "RECIRC")).toContain("active");
    });

    it("a disabled chip cannot change the variable", () => {
        // Native disabled buttons never dispatch click, so onVariable is
        // unreachable through the UI. The markup proof is the attribute.
        const html = render("speed", {});
        expect(buttonTag(html, "TKE")).toContain("disabled");
        expect(buttonTag(html, "RECIRC")).toContain("disabled");
    });
});

describe("fallbackVariableFor", () => {
    it("returns k to speed when the frame has no k channel", () => {
        expect(fallbackVariableFor("k", {})).toBe("speed");
    });

    it("returns recirc to speed when the frame has no recirc channel", () => {
        expect(fallbackVariableFor("recirc", {})).toBe("speed");
    });

    it("keeps k when the frame carries the channel", () => {
        expect(fallbackVariableFor("k", { k: new Float32Array(4) })).toBe("k");
    });

    it("keeps recirc when the frame carries the channel", () => {
        expect(fallbackVariableFor("recirc", { recirc: new Float32Array(4) })).toBe("recirc");
    });

    it("leaves the base quantities untouched", () => {
        for (const v of ["speed", "cp", "omega", "u", "v"] as const) {
            expect(fallbackVariableFor(v, {})).toBe(v);
        }
    });
});
