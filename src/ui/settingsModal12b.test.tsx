// SettingsModal Phase 13: the FIELD section carries effective overlay
// checkboxes with their source instead of quantity chips. The retired time
// mean velocity toggle stays out of the panel; the canvas prop persists but
// no Settings control owns it.

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
            gridMode="512"
            activeGrid={512}
            onGridMode={noop}
            variable="speed"
            {...extra}
        />,
    );
}

describe("SettingsModal mean fields", () => {
    it("retires the time mean velocity toggle and its copy", () => {
        for (const html of [render(false), render(true)]) {
            expect(html).not.toContain("Time mean velocity fields");
            expect(html).not.toContain('id="settingsMeanFields"');
            expect(html).not.toContain("time averaged u and v");
        }
    });

    it("still accepts a meanFields pref without rendering a control", () => {
        const html = render(true);
        expect(html).toContain("FIELD");
        expect(html).toContain("PARTICLES");
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
                gridMode="512"
                activeGrid={512}
                onGridMode={noop}
                variable="speed"
            />,
        );
        expect(html).toContain("Manual until field change");
    });

    it("renders no particle size control, the count slider owns particles", () => {
        const html = renderToStaticMarkup(
            <SettingsModal
                open={true}
                onClose={noop}
                prefs={{ ...DEFAULT_DISPLAY_PREFS, particleSize: 0.024 }}
                onPatch={noop}
                gridMode="512"
                activeGrid={512}
                onGridMode={noop}
                variable="speed"
            />,
        );
        expect(html).not.toContain('id="settingsParticleSize"');
        expect(html).toContain('id="settingsParticles"');
    });
});
