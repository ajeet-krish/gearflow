// Settings modal markup: every control present, no field variable control.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import SettingsModal from "./SettingsModal";
import { DEFAULT_DISPLAY_PREFS } from "@/contracts/types";

const noop = () => {};

function render(prefs = DEFAULT_DISPLAY_PREFS) {
    return renderToStaticMarkup(
        <SettingsModal
            open={true}
            onClose={noop}
            prefs={prefs}
            onPatch={noop}
            gridMode="512"
            activeGrid={512}
            onGridMode={noop}
            variable="speed"
        />,
    );
}

describe("SettingsModal", () => {
    it("renders the theme control", () => {
        const html = render();
        expect(html).toContain("Theme");
        expect(html).toContain("Dark");
        expect(html).toContain("Light");
    });

    it("renders the colormap control", () => {
        const html = render();
        expect(html).toContain("Colormap");
        expect(html).toContain("Viridis");
    });

    it("renders the display settings title with no resolution section", () => {
        const html = render();
        expect(html).toContain("DISPLAY SETTINGS");
        expect(html).not.toContain("RESOLUTION");
        expect(html).not.toContain("Fixed grid");
        expect(html).not.toContain("512 x 512");
        expect(html).not.toContain("512 only");
        expect(html).not.toContain("Grid mode");
        expect(html).not.toContain("Custom square");
        expect(html).not.toContain('id="settingsGrid"');
        expect(html).not.toContain('id="settingsCustomGrid"');
        expect(html).not.toContain("Surrogate and fixture stay at 128.");
    });

    it("renders particle count and color swatches with no Auto option", () => {
        const html = render();
        expect(html).toContain("PARTICLES");
        expect(html).toContain("Particle color");
        expect(html).not.toContain(">Auto<");
        for (const label of ["White", "Black", "Cyan", "Magenta", "Orange"]) {
            expect(html).toContain(label);
        }
        expect(html).toContain('role="radio"');
    });

    it("renders particle count as a wide range slider with an Off readout", () => {
        const html = render();
        expect(html).toContain('id="settingsParticles"');
        expect(html).toContain('type="range"');
        expect(html).toContain('min="0"');
        expect(html).toContain('max="8000"');
        expect(html).toContain('id="settingsParticlesValue"');
        const off = renderToStaticMarkup(
            <SettingsModal
                open={true}
                onClose={noop}
                prefs={{ ...DEFAULT_DISPLAY_PREFS, particleCount: 0 }}
                onPatch={noop}
                gridMode="512"
                activeGrid={512}
                onGridMode={noop}
                variable="speed"
            />,
        );
        expect(off).toContain("Off");
    });

    it("groups the particle color swatches as a radiogroup", () => {
        const html = render();
        expect(html).toContain('role="radiogroup"');
        expect(html).toContain('aria-labelledby="particleColorLabel"');
    });

    it("renders field layer, contour, legend, and streamline toggles", () => {
        const html = render();
        expect(html).toContain("Field layer visible");
        expect(html).toContain("Contour lines");
        expect(html).toContain("Legend visible");
        expect(html).toContain("Streamlines");
    });

    it("renders effective overlay toggles with their source instead of quantity chips", () => {
        const html = render();
        expect(html).toContain("Contour lines");
        expect(html).toContain("Streamlines");
        expect(html).toContain("Auto from field");
        expect(html).not.toContain("Field quantity");
        expect(html).not.toContain("VELOCITY");
        expect(html).not.toContain("RECIRC");
    });

    it("renders no particle size control", () => {
        const html = render();
        expect(html).not.toContain("Particle size");
        expect(html).not.toContain('id="settingsParticleSize"');
        expect(html).not.toContain('id="settingsParticleSizeValue"');
    });

    it("renders no solver line in the footer", () => {
        const html = render();
        expect(html).toContain("Reset defaults");
        expect(html).not.toContain("handled by the solver");
    });

    it("renders a labeled popover, not a dimmed modal", () => {
        const html = render();
        expect(html).toContain('role="dialog"');
        expect(html).toContain('aria-modal="false"');
        expect(html).toContain("settingsPopoverWrap");
        expect(html).toContain("settingsPopover");
        expect(html).not.toContain("modalBackdrop");
    });

    it("renders nothing when closed", () => {
        const html = renderToStaticMarkup(
            <SettingsModal
                open={false}
                onClose={noop}
                prefs={DEFAULT_DISPLAY_PREFS}
                onPatch={noop}
                gridMode="512"
                activeGrid={512}
                onGridMode={noop}
                variable="speed"
            />,
        );
        expect(html).toBe("");
    });
});
