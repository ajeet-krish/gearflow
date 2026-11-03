// P2 theory companion test: the airfoil textbook renders every agent
// chat section with anchored headings, a table of contents, and KaTeX
// hooks. Static markup only: KaTeX effects do not run under
// renderToStaticMarkup, so the math spans assert as mount points.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import TheoryPage from "./TheoryPage";

describe("TheoryPage companion", () => {
    it("renders the airfoil textbook headings with anchors", () => {
        const html = renderToStaticMarkup(<TheoryPage />);
        expect(html).toContain("Airfoil Theory Companion");
        for (const id of [
            "what-this-guide-is",
            "naca-geometry",
            "potential-flow",
            "lift-coefficient",
            "pressure-coefficient",
            "angle-of-attack",
            "reynolds-number",
            "stall-limits",
            "before-after",
        ]) {
            expect(html).toContain(`id="${id}"`);
            expect(html).toContain(`href="#${id}"`);
        }
    });

    it("covers the agent chat topics in physics only copy", () => {
        const html = renderToStaticMarkup(<TheoryPage />);
        expect(html).toContain("NACA 2412");
        expect(html).toContain("Lift Coefficient");
        expect(html).toContain("Pressure Coefficient");
        expect(html).toContain("Angle of Attack");
        expect(html).toContain("Reynolds Number");
        expect(html).toContain("Stall and Separation");
        expect(html).toContain("Before/After Table");
    });

    it("mounts KaTeX math hooks and the worked before/after example", () => {
        const html = renderToStaticMarkup(<TheoryPage />);
        expect(html).toContain("theoryInlineMath");
        expect(html).toContain("theoryBlockMath");
        expect(html).toContain("NACA 0012");
        expect(html).toContain("Min Cp");
    });

    it("keeps the contents nav labelled for assistive tech", () => {
        const html = renderToStaticMarkup(<TheoryPage />);
        expect(html).toContain('aria-label="Theory contents"');
    });
});
