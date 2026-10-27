// InstrumentTabs WAI-APG wiring: roving tabindex, tab and panel linkage,
// arrow plus Home and End targets with wrap-around. DOM free: the key map
// is pure and the rendered markup is asserted via react-dom/server.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import InstrumentTabs, { panelId, tabId, tabKeyTarget } from "./InstrumentTabs";

describe("InstrumentTabs keyboard map", () => {
    it("moves forward and wraps on ArrowRight and ArrowDown", () => {
        expect(tabKeyTarget(3, 0, "ArrowRight")).toBe(1);
        expect(tabKeyTarget(3, 2, "ArrowRight")).toBe(0);
        expect(tabKeyTarget(3, 1, "ArrowDown")).toBe(2);
        expect(tabKeyTarget(3, 2, "ArrowDown")).toBe(0);
    });

    it("moves backward and wraps on ArrowLeft and ArrowUp", () => {
        expect(tabKeyTarget(3, 1, "ArrowLeft")).toBe(0);
        expect(tabKeyTarget(3, 0, "ArrowLeft")).toBe(2);
        expect(tabKeyTarget(3, 0, "ArrowUp")).toBe(2);
        expect(tabKeyTarget(3, 2, "ArrowUp")).toBe(1);
    });

    it("jumps on Home and End and ignores other keys", () => {
        expect(tabKeyTarget(4, 2, "Home")).toBe(0);
        expect(tabKeyTarget(4, 1, "End")).toBe(3);
        expect(tabKeyTarget(4, 1, "Enter")).toBeNull();
        expect(tabKeyTarget(4, 1, " ")).toBeNull();
        expect(tabKeyTarget(0, 0, "ArrowRight")).toBeNull();
    });
});

describe("InstrumentTabs APG markup", () => {
    it("links tabs to panels with roving tabindex", () => {
        const html = renderToStaticMarkup(
            <InstrumentTabs
                tabs={[
                    { id: "flow", label: "Flow", content: <p>flow panel</p> },
                    { id: "probe", label: "Probe", content: <p>probe panel</p> },
                ]}
                initial="probe"
            />
        );
        for (const id of ["flow", "probe"]) {
            expect(html).toContain(`id="${tabId(id)}"`);
            expect(html).toContain(`aria-controls="${panelId(id)}"`);
            expect(html).toContain(`id="${panelId(id)}"`);
            expect(html).toContain(`aria-labelledby="${tabId(id)}"`);
        }
        expect(html).toContain('role="tablist"');
        expect(html.match(/role="tab"/g)?.length).toBe(2);
        expect(html.match(/role="tabpanel"/g)?.length).toBe(2);
        // Active tab owns tabindex 0, the inactive tab sits at minus 1.
        expect(html).toContain(`id="${tabId("probe")}"`);
        const probeAt = html.indexOf(`id="${tabId("probe")}"`);
        const probeTab = html.slice(Math.max(0, probeAt - 120), probeAt + 200);
        expect(probeTab).toContain('tabindex="0"');
        expect(probeTab).toContain('aria-selected="true"');
        const flowAt = html.indexOf(`id="${tabId("flow")}"`);
        const flowTab = html.slice(Math.max(0, flowAt - 120), flowAt + 200);
        expect(flowTab).toContain('tabindex="-1"');
        expect(flowTab).toContain('aria-selected="false"');
    });
});
