// Body selector ruthless verification: excised bars and sidebar, Body
// tabs with fixed labels and dirty dots, RunTerminal eradication, tab
// memory isolation with full key coverage. Static markup only (vitest
// node env), plus App source pins.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
    BODY_TABS,
    bodyTabLabelFor,
    caseKeyFor,
    createCaseTabsStore,
    defaultCaseTabs,
    storeActivate,
    storeActive,
    storeUpdate,
} from "./caseTabs";
import type { GeometrySpec } from "@/contracts/types";
import EditorTabs from "./EditorTabs";
import TopNav from "./TopNav";

const noop = () => {};

function baseSpec(): GeometrySpec {
    return {
        kind: "naca4",
        naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 },
        chord: 1,
        alphaDeg: 6,
        nPoints: 120,
    };
}

function count(hay: string, needle: string): number {
    return hay.split(needle).length - 1;
}

describe("Excised bars plus sidebar: modules gone, zero tokens", () => {
    it("deletes the title, activity, status bar, and sidebar modules", () => {
        for (const name of ["IdeTitleBar.tsx", "ActivityBar.tsx", "IdeStatusBar.tsx", "IdeSidebar.tsx", "ideData.ts"]) {
            expect(existsSync(resolve(__dirname, name))).toBe(false);
        }
        const names = readdirSync(__dirname);
        expect(names.some((n) => n === "IdeTitleBar.tsx" || n === "ActivityBar.tsx" || n === "IdeStatusBar.tsx" || n === "IdeSidebar.tsx" || n === "ideData.ts")).toBe(false);
    });

    it("carries zero excised tokens in App source or markup", () => {
        const src = readFileSync(resolve(__dirname, "../App.tsx"), "utf8");
        for (const token of ["IdeTitleBar", "ActivityBar", "IdeStatusBar", "IdeSidebar", "ideData", "activityView", "ideTitleBar", "ideActivity", "ideStatus", "ideSide", "gripRight", "railRightBody"]) {
            expect(src).not.toContain(token);
        }
        const tabs = defaultCaseTabs();
        const html = renderToStaticMarkup(
            <div className="page idePage">
                <TopNav active="studio" onNav={noop} settingsOpen={false} onOpenSettings={noop} />
                <EditorTabs tabs={tabs} activeId={tabs[0].id} onActivate={noop} />
            </div>,
        );
        expect(html.toLowerCase()).not.toContain("idetitlebar");
        expect(html).not.toContain("ideActivity");
        expect(html).not.toContain("ideStatus");
        expect(html).not.toContain("ideSide");
        expect(html).not.toContain("Right sidebar");
        expect(html).toContain("topNav");
    });

    it("TopNav is the sole topmost bar", () => {
        const src = readFileSync(resolve(__dirname, "../App.tsx"), "utf8");
        expect(src).toContain("<TopNav");
        expect(src.indexOf("<TopNav")).toBeLessThan(src.indexOf("<main"));
    });

    it("AnalysisPanel stays in code but unmounted", () => {
        expect(existsSync(resolve(__dirname, "./AnalysisPanel.tsx"))).toBe(true);
        const src = readFileSync(resolve(__dirname, "../App.tsx"), "utf8");
        expect(src).not.toContain("<AnalysisPanel");
    });
});

describe("Body tabs: fixed labels, chip style, no dots, no close buttons", () => {
    it("ships four body tabs with fixed ids and labels", () => {
        const tabs = defaultCaseTabs();
        expect(tabs).toHaveLength(4);
        expect(tabs.map((t) => t.id)).toEqual(["airfoil", "cylinder", "block", "orifice"]);
        expect(tabs.map((t) => t.title)).toEqual(["NACA Airfoil", "Cylinder", "Rectangle", "Orifice"]);
        expect(BODY_TABS.map((t) => t.id)).toEqual(["airfoil", "cylinder", "block", "orifice"]);
        for (const t of tabs) expect(bodyTabLabelFor(t.spec)).toBe(t.title);
    });

    it("clean tabs carry zero dots and zero close affordances", () => {
        const tabs = defaultCaseTabs();
        const html = renderToStaticMarkup(<EditorTabs tabs={tabs} activeId={tabs[0].id} onActivate={noop} />);
        expect(html).not.toContain("ideTabDot");
        expect(html).not.toContain("ideTabClose");
        expect(html.toLowerCase()).not.toContain("close");
        expect(html).not.toContain("&times;");
    });

    it("dirty memories carry no dot either, unsaved state stays in the label", () => {
        const tabs = defaultCaseTabs();
        const dirty = tabs.map((t, i) => (i === 1 ? { ...t, dirty: true } : t));
        const html = renderToStaticMarkup(<EditorTabs tabs={dirty} activeId={dirty[1].id} onActivate={noop} />);
        expect(html).not.toContain("ideTabDot");
        expect(html).toContain("unsaved changes");
        expect(html).not.toContain("ideTabClose");
        expect(html.toLowerCase()).not.toContain("close");
    });

    it("all dirty tabs still carry zero dots and zero close buttons", () => {
        const tabs = defaultCaseTabs().map((t) => ({ ...t, dirty: true }));
        const html = renderToStaticMarkup(<EditorTabs tabs={tabs} activeId={tabs[0].id} onActivate={noop} />);
        expect(html).not.toContain("ideTabDot");
        expect(html).not.toContain("ideTabClose");
    });

    it("tab label names unsaved state for AT with no dot decoration", () => {
        const tabs = defaultCaseTabs().map((t, i) => (i === 0 ? { ...t, dirty: true } : t));
        const html = renderToStaticMarkup(<EditorTabs tabs={tabs} activeId={tabs[0].id} onActivate={noop} />);
        expect(html).not.toContain("ideTabDot");
        expect(html).toContain("unsaved changes");
    });

    it("tabs render as Field chip buttons with the shared active class", () => {
        const tabs = defaultCaseTabs();
        const html = renderToStaticMarkup(<EditorTabs tabs={tabs} activeId={tabs[1].id} onActivate={noop} />);
        expect(html).toContain("<button");
        expect(html).toContain("chip active");
        expect(html).not.toContain("ideTab");
    });

    it("renders the BODY label with the Body tablist", () => {
        const tabs = defaultCaseTabs();
        const html = renderToStaticMarkup(<EditorTabs tabs={tabs} activeId={tabs[0].id} onActivate={noop} />);
        expect(html).toContain("BODY");
        expect(html).toContain('aria-label="Body"');
        expect(html).toContain('aria-label="Body selector"');
        expect(html).toContain("NACA Airfoil");
        expect(html).toContain("Rectangle");
    });

    it("exactly one tab is aria selected", () => {
        const tabs = defaultCaseTabs();
        const html = renderToStaticMarkup(<EditorTabs tabs={tabs} activeId={tabs[2].id} onActivate={noop} />);
        expect(count(html, 'aria-selected="true"')).toBe(1);
        expect(count(html, 'aria-selected="false"')).toBe(tabs.length - 1);
    });

    it("EditorTabs source offers native button activation with no close handler", () => {
        const src = readFileSync(resolve(__dirname, "./EditorTabs.tsx"), "utf8");
        // Native buttons fire onClick on Enter and Space, so no manual key
        // handler is needed; keyboard support rides the button element.
        expect(src).toContain("<button");
        expect(src).toContain("onClick");
        expect(src).toContain('role="tab"');
        for (const token of ["ideTabClose", "onClose", "closeTab", "aria-label=\"Close", "&times;"]) {
            expect(src).not.toContain(token);
        }
    });

    it("tabs sit above the Field selector inside the scene bars", () => {
        const src = readFileSync(resolve(__dirname, "../App.tsx"), "utf8");
        const bars = src.indexOf("<SceneBars");
        const tabs = src.indexOf("<EditorTabs");
        const field = src.indexOf("<FieldBar");
        expect(bars).toBeGreaterThan(-1);
        expect(tabs).toBeGreaterThan(bars);
        expect(field).toBeGreaterThan(tabs);
    });
});

describe("RunTerminal eradication: module gone, zero nodes", () => {
    it("RunTerminal module files are deleted", () => {
        expect(existsSync(resolve(__dirname, "./RunTerminal.tsx"))).toBe(false);
        expect(existsSync(resolve(__dirname, "./RunTerminal.ts"))).toBe(false);
        const names = readdirSync(__dirname);
        expect(names.some((n) => n.toLowerCase().startsWith("runterminal"))).toBe(false);
    });

    it("App owns zero terminal imports and zero terminal JSX", () => {
        const src = readFileSync(resolve(__dirname, "../App.tsx"), "utf8");
        for (const token of ["<RunTerminal", "<TelemetryBar", "ui/RunTerminal", "ui/TelemetryBar", "runTerm"]) {
            expect(src).not.toContain(token);
        }
    });

    it("static shell markup carries zero runTerm nodes and zero excised bars", () => {
        const tabs = defaultCaseTabs();
        const html = renderToStaticMarkup(
            <div className="page idePage">
                <TopNav active="studio" onNav={noop} settingsOpen={false} onOpenSettings={noop} />
                <EditorTabs tabs={tabs} activeId={tabs[0].id} onActivate={noop} />
            </div>,
        );
        expect(html.toLowerCase()).not.toContain("runterm");
        expect(html).not.toContain("ideTitleBar");
        expect(html).not.toContain("ideActivity");
        expect(html).not.toContain("ideStatus");
        expect(html.toLowerCase()).not.toContain("telemetrybar");
    });
});

describe("Body tab memories: isolated data with full serialization keys", () => {
    it("ships four isolated default tabs with fixed labels", () => {
        const tabs = defaultCaseTabs();
        expect(tabs).toHaveLength(4);
        expect(new Set(tabs.map((t) => t.id)).size).toBe(4);
        expect(new Set(tabs.map((t) => t.title)).size).toBe(4);
        expect(tabs[0].title).toBe("NACA Airfoil");
        expect(tabs[2].title).toBe("Rectangle");
        expect(tabs[0].spec).not.toBe(tabs[1].spec);
    });

    it("updating one memory leaves siblings untouched by reference and by value", () => {
        const store = createCaseTabsStore();
        const before = JSON.stringify(store.tabs.map((t) => t.spec));
        const next = storeUpdate(store, store.tabs[1].id, { reynolds: 700 });
        expect(next.tabs[1].reynolds).toBe(700);
        expect(next.tabs[1].dirty).toBe(true);
        expect(next.tabs[1].title).toBe("Cylinder");
        expect(next.tabs[0]).toBe(store.tabs[0]);
        expect(next.tabs[2]).toBe(store.tabs[2]);
        expect(JSON.stringify(store.tabs.map((t) => t.spec))).toBe(before);
        expect(next.tabs[0].dirty).toBe(false);
    });

    it("spec patch clones input and keeps the fixed label", () => {
        const store = createCaseTabsStore();
        const id = store.tabs[0].id;
        const patch: GeometrySpec = { ...baseSpec(), alphaDeg: 9 };
        const next = storeUpdate(store, id, { spec: patch });
        patch.alphaDeg = 99;
        expect(next.tabs[0].spec.alphaDeg).toBe(9);
        expect(next.tabs[0].title).toBe("NACA Airfoil");
        expect(next.tabs[0].dirty).toBe(true);
    });

    it("same NACA code with different m, p, or t fractions yields distinct keys", () => {
        const grid = 128;
        const re = 50000;
        const key = (m: number, p: number, t: number) =>
            caseKeyFor({ ...baseSpec(), naca: { code: "2412", m, p, t } }, re, grid);
        const base = key(0.02, 0.4, 0.12);
        expect(key(0.025, 0.4, 0.12)).not.toBe(base);
        expect(key(0.02, 0.5, 0.12)).not.toBe(base);
        expect(key(0.02, 0.4, 0.15)).not.toBe(base);
        expect(key(0.02, 0.4, 0.12)).toBe(base);
    });

    it("grid stripped comparison still separates fraction edits, equal edits match", () => {
        const strip = (k: string) => k.split("|g")[0];
        const a = caseKeyFor(baseSpec(), 50000, 128);
        const thicker = caseKeyFor({ ...baseSpec(), naca: { code: "2412", m: 0.02, p: 0.4, t: 0.15 } }, 50000, 128);
        expect(strip(a)).not.toBe(strip(thicker));
        expect(strip(a)).toBe(strip(caseKeyFor(baseSpec(), 50000, 256)));
        expect(a).not.toBe(caseKeyFor(baseSpec(), 50000, 256));
    });

    it("every solved field dimension of the key separates: alpha, chord, nPoints, Re, grid", () => {
        const k0 = caseKeyFor(baseSpec(), 50000, 128);
        expect(caseKeyFor({ ...baseSpec(), alphaDeg: 8 }, 50000, 128)).not.toBe(k0);
        expect(caseKeyFor({ ...baseSpec(), chord: 2 }, 50000, 128)).not.toBe(k0);
        expect(caseKeyFor({ ...baseSpec(), nPoints: 60 }, 50000, 128)).not.toBe(k0);
        expect(caseKeyFor(baseSpec(), 100000, 128)).not.toBe(k0);
        expect(caseKeyFor(baseSpec(), 50000, 64)).not.toBe(k0);
        expect(caseKeyFor(baseSpec(), 50000, 128)).toBe(k0);
    });

    it("every body field of the key separates: kind, code, radius, width, height, center, polygon", () => {
        const k0 = caseKeyFor(baseSpec(), 50000, 128);
        expect(caseKeyFor({ kind: "cylinder", chord: 1, alphaDeg: 6, nPoints: 120, radius: 0.25 }, 50000, 128)).not.toBe(k0);
        expect(caseKeyFor({ ...baseSpec(), naca: { code: "0012", m: 0, p: 0.4, t: 0.12 } }, 50000, 128)).not.toBe(k0);
        expect(caseKeyFor({ kind: "cylinder", chord: 1, alphaDeg: 0, nPoints: 120, radius: 0.25 }, 100, 128)).not.toBe(
            caseKeyFor({ kind: "cylinder", chord: 1, alphaDeg: 0, nPoints: 120, radius: 0.35 }, 100, 128),
        );
        expect(caseKeyFor({ ...baseSpec(), center: { x: 0, y: 0 } }, 50000, 128)).not.toBe(k0);
        expect(caseKeyFor({ ...baseSpec(), width: 0.05, height: 0.5 }, 50000, 128)).not.toBe(k0);
        const customA: GeometrySpec = { kind: "custom", chord: 1, alphaDeg: 0, nPoints: 4, polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }] };
        const customB: GeometrySpec = { kind: "custom", chord: 1, alphaDeg: 0, nPoints: 4, polygon: [{ x: 0, y: 0 }, { x: 1, y: 0.5 }] };
        expect(caseKeyFor(customA, 100, 128)).not.toBe(caseKeyFor(customB, 100, 128));
    });

    it("non-finite inputs never throw and never collide with a valid key", () => {
        const valid = caseKeyFor(baseSpec(), 50000, 128);
        const nanAlpha = caseKeyFor({ ...baseSpec(), alphaDeg: Number.NaN }, 50000, 128);
        const infRe = caseKeyFor(baseSpec(), Number.POSITIVE_INFINITY, 128);
        const nanGrid = caseKeyFor(baseSpec(), 50000, Number.NaN);
        expect(typeof nanAlpha).toBe("string");
        expect(typeof infRe).toBe("string");
        expect(typeof nanGrid).toBe("string");
        expect(nanAlpha).not.toBe(valid);
        expect(infRe).not.toBe(valid);
        expect(nanGrid).not.toBe(valid);
    });

    it("activation and unknown ids keep the store stable", () => {
        const store = createCaseTabsStore();
        const second = store.tabs[1];
        const next = storeActivate(store, second.id);
        expect(next.activeId).toBe(second.id);
        expect(storeActive(next)?.id).toBe(second.id);
        expect(store.activeId).not.toBe(second.id);
        expect(storeActivate(store, "missing").activeId).toBe(store.activeId);
        expect(storeUpdate(store, "missing", { reynolds: 1 })).toBe(store);
    });
});
