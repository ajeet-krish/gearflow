// GearFlow shell test: Zenith instrument-room layout pieces render with
// pure presentational props. DOM free via react-dom/server static markup.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import TopNav from "./TopNav";
import SolverBar from "./SolverBar";
import FieldBar from "./FieldBar";
import TelemetryBar from "./TelemetryBar";
import AnalysisPanel from "./AnalysisPanel";
import VerticalColorbar from "./VerticalColorbar";
import { RailShell, SceneBars, isActiveInside, isEditableTarget, needsFocusRescue, resolveShellShortcut, setInert } from "./shellRegions";
import { shellVisibility } from "./layoutStore";
import { fitDomainView } from "@/render/fitView";
import { DEFAULT_DOMAIN } from "@/contracts/types";

const noop = () => {};

describe("GearFlow shell", () => {
    it("renders a top navbar with the GearFlow wordmark and a single STUDIO link", () => {
        const html = renderToStaticMarkup(
            <TopNav
                active="studio"
                onNav={noop}
                settingsOpen={false}
                onOpenSettings={noop}
                wasmActive={false}
            />
        );
        expect(html).toContain("GearFlow");
        expect(html).toContain("STUDIO");
        expect(html).not.toContain("VALIDATE");
        expect(html).not.toContain("EXPORT");
        expect(html).not.toContain("ONLINE");
        expect(html).not.toContain("OFFLINE");
        expect(html).not.toContain("navExport");
    });

    it("top navbar renders a Settings button bound to the dialog", () => {
        const html = renderToStaticMarkup(
            <TopNav
                active="studio"
                onNav={noop}
                settingsOpen={true}
                onOpenSettings={noop}
                wasmActive={false}
            />
        );
        expect(html).toContain("Open settings");
        expect(html).toContain('aria-haspopup="dialog"');
        expect(html).toContain('aria-expanded="true"');
    });

    it("solver bar contains both a BODY control and an RE control", () => {
        const html = renderToStaticMarkup(
            <SolverBar
                mode="analytic"
                onMode={noop}
                body="naca2412"
                onBody={noop}
                alpha={6}
                onAlpha={noop}
                reynolds={50000}
                onReynolds={noop}
                live={true}
            />
        );
        expect(html).toContain("BODY");
        expect(html).toContain("RE");
        expect(html).toContain("NACA 2412");
    });

    it("solver bar has no GRID chips", () => {
        const html = renderToStaticMarkup(
            <SolverBar
                mode="analytic"
                onMode={noop}
                body="naca2412"
                onBody={noop}
                alpha={6}
                onAlpha={noop}
                reynolds={50000}
                onReynolds={noop}
                live={true}
            />
        );
        expect(html).not.toContain("GRID");
        expect(html).not.toContain(">256<");
        expect(html).not.toContain(">128<");
    });

    it("field bar contains VELOCITY, PRESSURE, VORTICITY", () => {
        const html = renderToStaticMarkup(
            <FieldBar
                variable="speed"
                onVariable={noop}
            />
        );
        expect(html).toContain("VELOCITY");
        expect(html).toContain("PRESSURE");
        expect(html).toContain("VORTICITY");
    });

    it("field bar has no particle chips", () => {
        const html = renderToStaticMarkup(
            <FieldBar
                variable="speed"
                onVariable={noop}
            />
        );
        expect(html).not.toContain("1200");
        expect(html).not.toContain("2000");
        expect(html).not.toContain("3000");
        expect(html).not.toContain("CONTOURS");
        expect(html).not.toContain("Field layers");
    });

    it("right panel renders all five section labels", () => {
        const html = renderToStaticMarkup(
            <AnalysisPanel
                sections={[
                    { id: "geometry", label: "GEOMETRY", content: <p>geom</p> },
                    { id: "display", label: "DISPLAY", content: <p>disp</p> },
                    { id: "validation", label: "VALIDATION", content: <p>val</p> },
                    { id: "eval", label: "EVAL LEDGER", content: <p>eval</p> },
                    { id: "export", label: "EXPORT", content: <p>exp</p> },
                ]}
                open={new Set(["geometry", "display"])}
                onToggle={noop}
            />
        );
        for (const label of ["GEOMETRY", "DISPLAY", "VALIDATION", "EVAL LEDGER", "EXPORT"]) {
            expect(html).toContain(label);
        }
        // Collapsed content stays mounted so slider and ledger state resets never.
        expect(html).toContain("val");
        expect(html).toContain("eval");
    });

    it("vertical colorbar carries an accessible label", () => {
        const html = renderToStaticMarkup(
            <VerticalColorbar
                flow={null}
                variable="speed"
                colormap="viridis"
                visible={true}
                min={0}
                max={2}
            />
        );
        expect(html).toContain('aria-label="Vertical colorbar"');
    });

    it("vertical colorbar hides when visible is false", () => {
        const html = renderToStaticMarkup(
            <VerticalColorbar
                flow={null}
                variable="speed"
                colormap="viridis"
                visible={false}
            />
        );
        expect(html).toBe("");
    });

    it("telemetry bar reports engine, grid, and validation counts", () => {
        const html = renderToStaticMarkup(
            <TelemetryBar
                engine="ANALYTIC"
                dotClass="analytic"
                gridLabel="256 x 256"
                cells={65536}
                solveMs={12.4}
                cl={0.62}
                cpMin={-1.2}
                regime="laminar, attached"
                provenanceLabel="analytic-potential, computed locally at 256"
                pass={3}
                warn={2}
                fail={0}
                isFixture={false}
            />
        );
        expect(html).toContain("ANALYTIC");
        expect(html).toContain("256 x 256");
        expect(html).toContain("CL");
        expect(html).toContain("CPMIN");
    });
});

describe("GearFlow collapsible shell phase 12a", () => {
    function ctx(over: Partial<{ settingsOpen: boolean; target: unknown; ctrl: boolean; meta: boolean; alt: boolean; repeat: boolean }> = {}) {
        return {
            settingsOpen: false,
            target: { tagName: "DIV" },
            ctrl: false,
            meta: false,
            alt: false,
            repeat: false,
            ...over,
        };
    }
    function rail(collapsed: boolean, side: "left" | "right" = "left") {
        return renderToStaticMarkup(
            <RailShell
                side={side}
                label={side === "left" ? "Agent console: conversational assistant" : "Analysis rail"}
                region={side === "left" ? "agent console" : "analysis rail"}
                bladeLabel={side === "left" ? "AGENT" : "ANALYSIS"}
                bodyId={side === "left" ? "railLeftBody" : "railRightBody"}
                collapsed={collapsed}
                onToggle={noop}
                width={320}
            >
                <button type="button">chat send</button>
            </RailShell>
        );
    }

    function bodyTagOf(html: string, bodyId: string): string {
        const idStart = html.indexOf(`id="${bodyId}"`);
        expect(idStart).toBeGreaterThan(-1);
        const tagStart = html.lastIndexOf("<div", idStart);
        const tagEnd = html.indexOf(">", idStart);
        return html.slice(tagStart, tagEnd);
    }

    it("a rail toggle flips aria-expanded and names the action", () => {
        const open = rail(false);
        expect(open).toContain('aria-expanded="true"');
        expect(open).toContain('aria-label="Collapse agent console"');
        const shut = rail(true);
        expect(shut).toContain('aria-expanded="false"');
        expect(shut).toContain('aria-label="Expand agent console"');
        expect(shut).toContain('aria-controls="railLeftBody"');
    });

    it("the right rail toggle names the analysis rail", () => {
        const shut = rail(true, "right");
        expect(shut).toContain('aria-label="Expand analysis rail"');
        expect(shut).toContain('aria-controls="railRightBody"');
        expect(shut).toContain("ANALYSIS");
    });

    it("a collapsed rail keeps its blade label so the region stays legible", () => {
        const shut = rail(true);
        expect(shut).toContain("AGENT");
        expect(shut).toContain("railLatch");
    });

    it("a collapsed rail hides its body from sight and assistive tech", () => {
        expect(bodyTagOf(rail(true), "railLeftBody")).toContain("hidden");
        expect(bodyTagOf(rail(true), "railLeftBody")).toContain('aria-hidden="true"');
        expect(bodyTagOf(rail(false), "railLeftBody")).not.toContain("hidden");
        expect(bodyTagOf(rail(false), "railLeftBody")).not.toContain("aria-hidden");
    });

    it("a collapsed rail exposes no focusable controls", () => {
        // The inner control stays mounted for conversation state but sits
        // inside a body node carrying all three hiding layers, so sequential
        // focus and assistive tech skip it in supporting browsers.
        const shut = rail(true);
        const tag = bodyTagOf(shut, "railLeftBody");
        expect(tag).toContain("hidden");
        expect(tag).toContain('aria-hidden="true"');
        expect(tag).toContain("inert");
        // The inner control renders after the body node opens, and the only
        // button outside it is the latch, which now owns focus order.
        expect(shut.indexOf("chat send")).toBeGreaterThan(shut.indexOf('id="railLeftBody"'));
        const buttons = shut.match(/<button/g) ?? [];
        expect(buttons.length).toBe(2);
        expect(shut).toContain('aria-label="Expand agent console"');
    });

    it("an expanded rail releases inert and returns its controls to tab order", () => {
        const open = rail(false);
        const tag = bodyTagOf(open, "railLeftBody");
        expect(tag).not.toContain("hidden");
        expect(tag).not.toContain("aria-hidden");
        expect(tag).not.toContain("inert");
        expect(open).toContain("chat send");
    });

    it("setInert applies and releases inert without throwing", () => {
        const calls: Array<[string, string?]> = [];
        const callsRemove: string[] = [];
        let prop: boolean | undefined;
        const el = {
            setAttribute: (n: string, v: string): void => {
                calls.push([n, v]);
            },
            removeAttribute: (n: string): void => {
                callsRemove.push(n);
            },
            set inert(v: boolean) {
                prop = v;
            },
            get inert(): boolean {
                return prop === true;
            },
        };
        setInert(el, true);
        expect(calls).toEqual([["inert", ""]]);
        expect(prop).toBe(true);
        setInert(el, false);
        expect(callsRemove).toEqual(["inert"]);
        expect(prop).toBe(false);
        expect(() => setInert(null, true)).not.toThrow();
    });

    it("focus mode hides both rails and the bars", () => {
        const vis = shellVisibility({
            leftCollapsed: false,
            rightCollapsed: false,
            barsCollapsed: false,
            focusMode: true,
        });
        expect(vis).toEqual({ left: true, right: true, bars: true });
        const left = rail(vis.left, "left");
        const right = renderToStaticMarkup(
            <RailShell
                side="right"
                label="Analysis rail"
                region="analysis rail"
                bladeLabel="ANALYSIS"
                bodyId="railRightBody"
                collapsed={vis.right}
                onToggle={noop}
            >
                <p>rack</p>
            </RailShell>
        );
        const bars = renderToStaticMarkup(
            <SceneBars bodyId="sceneBarsBody" collapsed={vis.bars} summary="FIELD SPEED . LBM . Re 100" onToggle={noop}>
                <p>bars</p>
            </SceneBars>
        );
        expect(left).toContain("hidden");
        expect(right).toContain("hidden");
        expect(bars).not.toContain('id="sceneBarsBody"');
        expect(bars).toContain("FIELD SPEED . LBM . Re 100");
    });

    it("the scene bars body id has a single owner and the handle resolves to it", () => {
        const open = renderToStaticMarkup(
            <SceneBars bodyId="sceneBarsBody" collapsed={false} summary="FIELD SPEED . LBM . Re 100" onToggle={noop}>
                <div>
                    <button type="button">Run</button>
                </div>
            </SceneBars>
        );
        const ids = open.match(/id="sceneBarsBody"/g) ?? [];
        expect(ids.length).toBe(1);
        expect(open).toContain('aria-controls="sceneBarsBody"');
        // Handle target resolves: the labelled element opens before the
        // inner control and wraps it.
        const bodyOpen = open.indexOf('id="sceneBarsBody"');
        expect(bodyOpen).toBeGreaterThan(open.indexOf('aria-controls="sceneBarsBody"'));
        expect(open.indexOf("Run")).toBeGreaterThan(bodyOpen);
    });

    it("isActiveInside reports subtree focus without a DOM", () => {
        const inner = { marker: "chip" };
        const body = { contains: (node: unknown): boolean => node === inner };
        expect(isActiveInside(inner, body)).toBe(true);
        expect(isActiveInside({ marker: "latch" }, body)).toBe(false);
        expect(isActiveInside(null, body)).toBe(false);
        expect(isActiveInside(inner, null)).toBe(false);
        expect(isActiveInside("text", body)).toBe(false);
    });

    it("needsFocusRescue only fires when lost focus was inside the bars", () => {
        const docBody = { marker: "body" };
        // Focus was on a chip or select inside the bars and the unmount
        // dropped it to body: rescue to the handle.
        expect(needsFocusRescue(true, docBody, docBody)).toBe(true);
        expect(needsFocusRescue(true, null, docBody)).toBe(true);
        // Focus was elsewhere and survived the collapse: never steal it.
        expect(needsFocusRescue(true, { marker: "agent input" }, docBody)).toBe(false);
        expect(needsFocusRescue(false, docBody, docBody)).toBe(false);
        expect(needsFocusRescue(false, null, docBody)).toBe(false);
    });

    it("late focus entry after expansion still rescues to the handle on collapse", () => {
        // No DOM runner ships in this repo, so the focusin listener cannot
        // be driven through real events. This drives the same pure decision
        // sequence the wired listener plus the collapse effect use.
        const chip = { marker: "chip" };
        const elsewhere = { marker: "agent input" };
        const docBody = { marker: "body" };
        const barsBody = { contains: (node: unknown): boolean => node === chip };
        // Expansion lands with focus elsewhere, so nothing is recorded yet.
        let hadFocusInside = isActiveInside(elsewhere, barsBody);
        expect(hadFocusInside).toBe(false);
        // A focusin inside the bars subtree after expansion records entry.
        if (isActiveInside(chip, barsBody)) hadFocusInside = true;
        expect(hadFocusInside).toBe(true);
        // Collapse unmounts the chip and drops focus to body, so rescue fires.
        expect(needsFocusRescue(hadFocusInside, docBody, docBody)).toBe(true);
        // The collapse resets the flag so a later unrelated collapse is quiet.
        hadFocusInside = false;
        expect(needsFocusRescue(hadFocusInside, docBody, docBody)).toBe(false);
    });

    it("a collapse with focus outside the bars never moves focus", () => {
        const docBody = { marker: "body" };
        const agentInput = { marker: "agent input" };
        expect(needsFocusRescue(false, agentInput, docBody)).toBe(false);
        expect(needsFocusRescue(false, docBody, docBody)).toBe(false);
        expect(needsFocusRescue(true, agentInput, docBody)).toBe(false);
        // Structural wiring: the collapsed bars keep the single handle bound
        // to the bars body id, which is the rescue target the effect focuses.
        const shut = renderToStaticMarkup(
            <SceneBars bodyId="sceneBarsBody" collapsed={true} summary="FIELD SPEED . LBM . Re 100" onToggle={noop}>
                <p>bars</p>
            </SceneBars>
        );
        expect(shut).toContain('aria-controls="sceneBarsBody"');
        expect(shut).toContain("Expand solver and field bars");
    });

    it("the scene bars handle expands on click and keeps the summary honest", () => {
        const shut = renderToStaticMarkup(
            <SceneBars bodyId="sceneBarsBody" collapsed={true} summary="FIELD SPEED . LBM . Re 100" onToggle={noop}>
                <FieldBar variable="speed" onVariable={noop} />
            </SceneBars>
        );
        expect(shut).toContain('aria-expanded="false"');
        expect(shut).toContain('aria-controls="sceneBarsBody"');
        expect(shut).toContain("Expand solver and field bars");
        expect(shut).not.toContain("PRESSURE");
        const open = renderToStaticMarkup(
            <SceneBars bodyId="sceneBarsBody" collapsed={false} summary="FIELD SPEED . LBM . Re 100" onToggle={noop}>
                <FieldBar variable="speed" onVariable={noop} />
            </SceneBars>
        );
        expect(open).toContain('aria-expanded="true"');
        expect(open).toContain("Collapse solver and field bars");
        expect(open).toContain("PRESSURE");
    });

    it("the backtick shortcut toggles focus mode", () => {
        expect(resolveShellShortcut("`", ctx())).toBe("focus");
    });

    it("the bracket shortcuts toggle the rails", () => {
        expect(resolveShellShortcut("[", ctx())).toBe("left");
        expect(resolveShellShortcut("]", ctx())).toBe("right");
    });

    it("Escape exits focus mode but never enters it, and stays quiet under Settings", () => {
        expect(resolveShellShortcut("Escape", ctx())).toBe("exitFocus");
        expect(resolveShellShortcut("Escape", ctx({ settingsOpen: true }))).toBeNull();
        expect(resolveShellShortcut("`", ctx({ settingsOpen: true }))).toBeNull();
    });

    it("shortcuts are ignored while an input is focused", () => {
        for (const target of [
            { tagName: "INPUT" },
            { tagName: "textarea" },
            { tagName: "select" },
            { tagName: "DIV", isContentEditable: true },
        ]) {
            expect(resolveShellShortcut("`", ctx({ target }))).toBeNull();
            expect(resolveShellShortcut("[", ctx({ target }))).toBeNull();
            expect(resolveShellShortcut("]", ctx({ target }))).toBeNull();
            expect(resolveShellShortcut("Escape", ctx({ target }))).toBeNull();
        }
        expect(isEditableTarget({ tagName: "div" })).toBe(false);
        expect(isEditableTarget(null)).toBe(false);
    });

    it("shortcuts are ignored with modifiers and unknown keys stay quiet", () => {
        expect(resolveShellShortcut("`", ctx({ ctrl: true }))).toBeNull();
        expect(resolveShellShortcut("[", ctx({ meta: true }))).toBeNull();
        expect(resolveShellShortcut("]", ctx({ alt: true }))).toBeNull();
        expect(resolveShellShortcut("f", ctx())).toBeNull();
    });

    it("held keys do not repeat toggles or storage writes", () => {
        expect(resolveShellShortcut("`", ctx({ repeat: true }))).toBeNull();
        expect(resolveShellShortcut("[", ctx({ repeat: true }))).toBeNull();
        expect(resolveShellShortcut("]", ctx({ repeat: true }))).toBeNull();
        expect(resolveShellShortcut("Escape", ctx({ repeat: true }))).toBeNull();
    });

    it("fit to domain keeps the whole tunnel visible with a margin", () => {
        const fit = fitDomainView(DEFAULT_DOMAIN, 1200, 600);
        expect(fit.left).toBeLessThanOrEqual(DEFAULT_DOMAIN.xMin);
        expect(fit.right).toBeGreaterThanOrEqual(DEFAULT_DOMAIN.xMax);
        expect(fit.bottom).toBeLessThanOrEqual(DEFAULT_DOMAIN.yMin);
        expect(fit.top).toBeGreaterThanOrEqual(DEFAULT_DOMAIN.yMax);
        // DEFAULT_DOMAIN is 2.5 by 2.0, aspect 1.25. A 2.0 aspect view fits
        // height, so the height matches the margin exactly.
        expect(fit.top - fit.bottom).toBeCloseTo(2.0 * 1.04, 9);
        expect((fit.right - fit.left) / (fit.top - fit.bottom)).toBeCloseTo(2.0, 9);
    });

    it("fit to domain grows the smaller axis on narrow views", () => {
        const fit = fitDomainView(DEFAULT_DOMAIN, 400, 800);
        expect(fit.left).toBeLessThanOrEqual(DEFAULT_DOMAIN.xMin);
        expect(fit.right).toBeGreaterThanOrEqual(DEFAULT_DOMAIN.xMax);
        expect(fit.bottom).toBeLessThanOrEqual(DEFAULT_DOMAIN.yMin);
        expect(fit.top).toBeGreaterThanOrEqual(DEFAULT_DOMAIN.yMax);
        expect(fit.right - fit.left).toBeCloseTo(2.5 * 1.04, 9);
    });

    it("fit to domain falls back to a unit half extent on a zero width domain", () => {
        const fit = fitDomainView({ xMin: 1, xMax: 1, yMin: 0, yMax: 2 }, 1200, 600);
        for (const v of [fit.left, fit.right, fit.top, fit.bottom]) {
            expect(Number.isFinite(v)).toBe(true);
        }
        expect(fit.left).toBeLessThan(fit.right);
        expect(fit.bottom).toBeLessThan(fit.top);
        expect(fit.left).toBeLessThanOrEqual(1);
        expect(fit.right).toBeGreaterThanOrEqual(1);
    });

    it("fit to domain falls back to a unit half extent on a negative height domain", () => {
        const fit = fitDomainView({ xMin: 0, xMax: 3, yMin: 2, yMax: 0 }, 1200, 600);
        for (const v of [fit.left, fit.right, fit.top, fit.bottom]) {
            expect(Number.isFinite(v)).toBe(true);
        }
        expect(fit.left).toBeLessThan(fit.right);
        expect(fit.bottom).toBeLessThan(fit.top);
    });

    it("fit to domain stays finite on a NaN domain value", () => {
        const fit = fitDomainView({ xMin: 0, xMax: Number.NaN, yMin: 0, yMax: 2 }, 1200, 600);
        for (const v of [fit.left, fit.right, fit.top, fit.bottom]) {
            expect(Number.isFinite(v)).toBe(true);
        }
        expect(fit.left).toBeLessThan(fit.right);
        expect(fit.bottom).toBeLessThan(fit.top);
    });
});
