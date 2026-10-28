// SettingsModal Phase 13: the time mean velocity toggle renders and
// reflects the persisted preference; the FIELD section carries effective
// overlay checkboxes with their source instead of quantity chips.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import SettingsModal from "./SettingsModal";
import { DEFAULT_DISPLAY_PREFS, type FieldMode } from "@/contracts/types";
import { overlayPatchForFieldChange } from "./fieldOverlay";

const noop = () => {};

function render(
    meanFields: boolean,
    extra: { variable?: FieldMode } = {},
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

describe("SettingsModal effective overlays", () => {
    it("renders overlay checkboxes with an auto source for the speed field", () => {
        const html = render(false, { variable: "speed" });
        expect(html).toContain("Contour lines");
        expect(html).toContain("Streamlines");
        expect(html).toContain("Auto from field");
        expect(html).toContain('id="settingsContours"');
        expect(html).toContain('id="settingsStream"');
    });

    it("checks streamlines and unchecks contours for the speed default", () => {
        const html = render(false, { variable: "speed" });
        const contours = html.indexOf('id="settingsContours"');
        expect(contours).toBeGreaterThan(-1);
        expect(html.slice(contours, contours + 160)).not.toContain("checked");
        const stream = html.indexOf('id="settingsStream"');
        expect(stream).toBeGreaterThan(-1);
        expect(html.slice(stream, stream + 160)).toContain("checked");
    });

    it("checks contours and unchecks streamlines for the pressure default", () => {
        const html = render(false, { variable: "cp" });
        const contours = html.indexOf('id="settingsContours"');
        expect(html.slice(contours, contours + 160)).toContain("checked");
        const stream = html.indexOf('id="settingsStream"');
        expect(html.slice(stream, stream + 160)).not.toContain("checked");
    });

    it("names the manual hold once the overlays are pinned", () => {
        const pinned = {
            ...DEFAULT_DISPLAY_PREFS,
            ...overlayPatchForFieldChange("speed"),
            contours: true,
            showStreamlines: false,
            overlayPinned: true as const,
            overlayPinnedField: "speed" as const,
        };
        const html = renderToStaticMarkup(
            <SettingsModal
                open={true}
                onClose={noop}
                prefs={pinned}
                onPatch={noop}
                gridMode="auto"
                activeGrid={256}
                onGridMode={noop}
                variable="speed"
            />,
        );
        expect(html).toContain("Manual until field change");
    });

    it("renders the particle size slider with the persisted readout", () => {
        const html = renderToStaticMarkup(
            <SettingsModal
                open={true}
                onClose={noop}
                prefs={{ ...DEFAULT_DISPLAY_PREFS, particleSize: 0.024 }}
                onPatch={noop}
                gridMode="auto"
                activeGrid={256}
                onGridMode={noop}
                variable="speed"
            />,
        );
        expect(html).toContain('id="settingsParticleSize"');
        expect(html).toContain("0.024");
    });
});
