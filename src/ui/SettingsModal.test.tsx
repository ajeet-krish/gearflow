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
            gridMode="auto"
            activeGrid={256}
            onGridMode={noop}
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

    it("renders the resolution control with the active grid hint", () => {
        const html = render();
        expect(html).toContain("RESOLUTION");
        expect(html).toContain("256 x 256");
        expect(html).toContain("Surrogate and fixture stay at 128.");
    });

    it("renders particle count and color swatches", () => {
        const html = render();
        expect(html).toContain("PARTICLES");
        expect(html).toContain("Particle color");
        for (const label of ["Auto", "White", "Black", "Cyan", "Magenta", "Orange"]) {
            expect(html).toContain(label);
        }
        expect(html).toContain('role="radio"');
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

    it("does not contain a field variable control", () => {
        const html = render();
        expect(html).not.toContain("Field variable");
    });

    it("offers Reset defaults", () => {
        const html = render();
        expect(html).toContain("Reset defaults");
    });

    it("renders a labeled dialog", () => {
        const html = render();
        expect(html).toContain('role="dialog"');
        expect(html).toContain('aria-modal="true"');
    });

    it("renders nothing when closed", () => {
        const html = renderToStaticMarkup(
            <SettingsModal
                open={false}
                onClose={noop}
                prefs={DEFAULT_DISPLAY_PREFS}
                onPatch={noop}
                gridMode="auto"
                activeGrid={256}
                onGridMode={noop}
            />,
        );
        expect(html).toBe("");
    });
});
