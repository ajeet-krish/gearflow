// SettingsModal Phase 12b: the time mean velocity toggle renders and
// reflects the persisted preference.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import SettingsModal from "./SettingsModal";
import { DEFAULT_DISPLAY_PREFS, type FieldMode } from "@/contracts/types";

const noop = () => {};

function render(
    meanFields: boolean,
    extra: { variable?: FieldMode; hasTke?: boolean; hasRecirc?: boolean } = {},
) {
    return renderToStaticMarkup(
        <SettingsModal
            open={true}
            onClose={noop}
            prefs={{ ...DEFAULT_DISPLAY_PREFS, meanFields }}
            onPatch={noop}
            gridMode="auto"
            activeGrid={256}
            onGridMode={noop}
            variable="speed"
            onVariable={noop}
            {...extra}
        />,
    );
}

describe("SettingsModal mean fields", () => {
    it("renders the time mean velocity toggle unchecked by default", () => {
        const html = render(false);
        expect(html).toContain("Time mean velocity fields");
        expect(html).toContain('id="settingsMeanFields"');
    });

    it("checks the toggle when mean fields are on", () => {
        const html = render(true);
        const at = html.indexOf('id="settingsMeanFields"');
        expect(at).toBeGreaterThan(-1);
        expect(html.slice(at, at + 160)).toContain("checked");
    });

    it("leaves the toggle unchecked when mean fields are off", () => {
        const html = render(false);
        const at = html.indexOf('id="settingsMeanFields"');
        expect(at).toBeGreaterThan(-1);
        expect(html.slice(at, at + 160)).not.toContain("checked");
    });
});

describe("SettingsModal field quantity chips", () => {
    function buttonTag(html: string, label: string): string {
        const close = `>${label}</button>`;
        const end = html.indexOf(close);
        expect(end).toBeGreaterThan(-1);
        const start = html.lastIndexOf("<button", end);
        return html.slice(start, end + close.length);
    }

    it("renders the field quantity group beside the colormap", () => {
        const html = render(false);
        expect(html).toContain("Field quantity");
        for (const label of ["SPEED", "PRESSURE", "VORTICITY", "TKE", "RECIRC"]) {
            expect(html).toContain(label);
        }
    });

    it("gates TKE and RECIRC exactly like the scene FieldBar", () => {
        const gated = render(false);
        const tke = buttonTag(gated, "TKE");
        expect(tke).toContain("disabled");
        expect(tke).toContain("Available after the first LBM statistics sample");
        const recirc = buttonTag(gated, "RECIRC");
        expect(recirc).toContain("disabled");
        expect(recirc).toContain("Available after the first LBM statistics sample");
        const open = render(false, { hasTke: true, hasRecirc: true });
        expect(buttonTag(open, "TKE")).not.toContain("disabled");
        expect(buttonTag(open, "RECIRC")).not.toContain("disabled");
    });

    it("marks the active field quantity chip", () => {
        const html = render(false, { variable: "cp", hasTke: true, hasRecirc: true });
        expect(buttonTag(html, "PRESSURE")).toContain("active");
    });
});
