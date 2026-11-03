// Selected style contract: Body tabs are Field chips (same chip classes)
// with an outlined Dracula purple selected box and a black seat, no fill
// change and no glow. The tunnel hero (colorbar, latch notch) keeps the
// only glow. Static CSS plus markup checks, no live solves.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import EditorTabs from "./EditorTabs";
import FieldBar from "./FieldBar";
import { defaultCaseTabs } from "./caseTabs";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, "../styles.css"), "utf8");

function ruleOf(selector: string): string {
    const at = css.indexOf(selector);
    expect(at).toBeGreaterThan(-1);
    const open = css.indexOf("{", at);
    const close = css.indexOf("}", open);
    return css.slice(open + 1, close);
}

describe("unified selected style", () => {
    it("Field chips and Body tabs share the outlined box through the chip rule", () => {
        const chip = ruleOf(".chip.active");
        const field = ruleOf(".sceneBar.fieldBar .chip.active");
        for (const rule of [chip, field]) {
            expect(rule).toContain("1px solid var(--purple)");
            expect(rule).toContain("background: transparent");
            expect(rule).toContain("color: var(--purple)");
            expect(rule).toContain("box-shadow: none");
            expect(rule).toContain("text-shadow: none");
        }
    });

    it("Body tabs sit on black while the selected box stays outlined", () => {
        const seat = ruleOf(".bodyBar .chip");
        expect(seat).toContain("#000");
        const selectedSeat = ruleOf(".bodyBar .chip.active");
        expect(selectedSeat).toContain("#000");
    });

    it("the unified selected rules carry no fill change and no glow", () => {
        const chip = ruleOf(".chip.active");
        const field = ruleOf(".sceneBar.fieldBar .chip.active");
        for (const rule of [chip, field]) {
            expect(rule).not.toContain("rgba(189, 147, 249");
            expect(rule).not.toContain("8px");
            expect(rule).not.toContain("#007acc");
            expect(rule).not.toContain("007ACC");
        }
    });

    it("the selected Body tab renders with the shared chip active class", () => {
        const tabs = defaultCaseTabs();
        const html = renderToStaticMarkup(
            <EditorTabs tabs={tabs} activeId={tabs[1].id} onActivate={() => {}} />,
        );
        expect(html).toContain("chip active");
        expect(html).toContain('aria-selected="true"');
    });

    it("the selected Field chip renders with the shared active class", () => {
        const html = renderToStaticMarkup(
            <FieldBar variable="cp" onVariable={() => {}} />,
        );
        expect(html).toContain("chip active");
        expect(html).toContain("PRESSURE");
        expect(html).toContain('aria-pressed="true"');
    });
});
