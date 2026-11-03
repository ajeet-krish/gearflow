// Body selector shell tests: caseTabs store plus static shell. The store
// proves tab memories are data only and isolated, the frame cache caps at
// 4. The static shell proves the excision: TopNav is the sole topmost bar,
// the Body tabs sit above the FIELD bar inside SceneBars, and the IDE
// sidebar plus the right rail are deleted with zero .runTerm nodes.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
    BODY_TABS,
    CaseFrameCache,
    bodyTabLabelFor,
    createCaseTabsStore,
    defaultCaseTabs,
    selectErrorCount,
    selectWarningCount,
    storeActivate,
    storeActive,
    storeUpdate,
    FRAME_CACHE_CAP,
} from "./caseTabs";
import TopNav from "./TopNav";
import EditorTabs from "./EditorTabs";
import FieldBar from "./FieldBar";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const noop = () => {};

describe("bodyTabs store", () => {
    it("ships four body tabs with fixed ids and display labels", () => {
        const tabs = defaultCaseTabs();
        expect(tabs).toHaveLength(4);
        expect(tabs.map((t) => t.id)).toEqual(["airfoil", "cylinder", "block", "orifice"]);
        expect(tabs.map((t) => t.title)).toEqual(["NACA Airfoil", "Cylinder", "Rectangle", "Orifice"]);
        expect(BODY_TABS.map((t) => t.id)).toEqual(["airfoil", "cylinder", "block", "orifice"]);
    });

    it("labels read from the body kind, block reads as Rectangle", () => {
        const tabs = defaultCaseTabs();
        for (const t of tabs) expect(bodyTabLabelFor(t.spec)).toBe(t.title);
        expect(tabs[0].title).toBe("NACA Airfoil");
        expect(tabs[2].title).toBe("Rectangle");
    });

    it("memories are isolated: updating one tab leaves the others by value", () => {
        const store = createCaseTabsStore();
        const second = store.tabs[1];
        const beforeFirst = JSON.stringify(store.tabs[0].spec);
        const next = storeUpdate(store, second.id, { reynolds: 700 });
        expect(next.tabs[1].reynolds).toBe(700);
        expect(next.tabs[0].reynolds).toBe(store.tabs[0].reynolds);
        expect(JSON.stringify(next.tabs[0].spec)).toBe(beforeFirst);
        expect(next.tabs[0]).toBe(store.tabs[0]);
    });

    it("updating a tab marks it dirty but keeps the fixed label", () => {
        const store = createCaseTabsStore();
        expect(store.tabs[1].dirty).toBe(false);
        const next = storeUpdate(store, store.tabs[1].id, { reynolds: 700 });
        expect(next.tabs[1].dirty).toBe(true);
        expect(next.tabs[1].title).toBe("Cylinder");
        expect(next.tabs[0].dirty).toBe(false);
    });

    it("per-body alpha and Re memories stay isolated across tabs", () => {
        const store = createCaseTabsStore();
        const airfoil = storeUpdate(store, "airfoil", { reynolds: 60000 });
        const cylinder = storeUpdate(airfoil, "cylinder", { reynolds: 200 });
        const airfoilBack = storeActivate(cylinder, "airfoil");
        expect(storeActive(airfoilBack)?.reynolds).toBe(60000);
        expect(cylinder.tabs.find((t) => t.id === "cylinder")?.reynolds).toBe(200);
    });

    it("activation switches the active memory without mutating tabs", () => {
        const store = createCaseTabsStore();
        const second = store.tabs[1];
        const next = storeActivate(store, second.id);
        expect(next.activeId).toBe(second.id);
        expect(storeActive(next)?.id).toBe(second.id);
        expect(store.activeId).not.toBe(second.id);
    });

    it("unknown activation leaves the store unchanged", () => {
        const store = createCaseTabsStore();
        expect(storeActivate(store, "missing").activeId).toBe(store.activeId);
    });

    it("frame cache caps at 4 with oldest eviction", () => {
        expect(FRAME_CACHE_CAP).toBe(4);
        const cache = new CaseFrameCache<number>();
        for (let i = 0; i < 6; i++) cache.set(`k${i}`, i);
        expect(cache.size).toBe(4);
        expect(cache.has("k0")).toBe(false);
        expect(cache.has("k1")).toBe(false);
        expect(cache.get("k5")).toBe(5);
        cache.clear();
        expect(cache.size).toBe(0);
    });

    it("errorCount selector counts fail rows without doubling blocking", () => {
        expect(selectErrorCount({ fail: 2, blocking: 1 })).toBe(2);
        expect(selectErrorCount({ fail: 0 })).toBe(0);
        expect(selectErrorCount(null)).toBe(0);
        expect(selectWarningCount({ warn: 3 })).toBe(3);
    });
});

describe("body selector shell", () => {
    function shellHtml(): string {
        const tabs = defaultCaseTabs();
        return renderToStaticMarkup(
            <div className="page idePage">
                <TopNav active="studio" onNav={noop} settingsOpen={false} onOpenSettings={noop} />
                <EditorTabs tabs={tabs} activeId={tabs[0].id} onActivate={noop} />
                <FieldBar variable="speed" onVariable={noop} />
            </div>,
        );
    }

    it("renders TopNav plus the BODY selector plus FIELD with no sidebar", () => {
        const html = shellHtml();
        expect(html).toContain("topNav");
        expect(html).toContain("GearFlow");
        expect(html).toContain("BODY");
        expect(html).toContain("NACA Airfoil");
        expect(html).toContain("Cylinder");
        expect(html).toContain("Rectangle");
        expect(html).toContain("Orifice");
        expect(html).toContain("FIELD");
        expect(html).not.toContain("ideTitleBar");
        expect(html).not.toContain("ideActivity");
        expect(html).not.toContain("ideStatus");
        expect(html).not.toContain('aria-label="IDE status bar"');
        expect(html).not.toContain("ideSide");
        expect(html).not.toContain("Right sidebar");
    });

    it("the excised sidebar modules are deleted", () => {
        for (const name of ["IdeSidebar.tsx", "ideData.ts"]) {
            expect(existsSync(resolve(__dirname, name))).toBe(false);
        }
        const names = readdirSync(__dirname);
        expect(names.some((n) => n === "IdeSidebar.tsx" || n === "ideData.ts")).toBe(false);
    });

    it("the excised bar modules stay deleted", () => {
        for (const name of ["IdeTitleBar.tsx", "ActivityBar.tsx", "IdeStatusBar.tsx"]) {
            expect(existsSync(resolve(__dirname, name))).toBe(false);
        }
        const names = readdirSync(__dirname);
        expect(names.some((n) => n === "IdeTitleBar.tsx" || n === "ActivityBar.tsx" || n === "IdeStatusBar.tsx")).toBe(false);
    });

    it("body tabs render as Field chips with no dots and no close buttons", () => {
        const tabs = defaultCaseTabs();
        const clean = renderToStaticMarkup(<EditorTabs tabs={tabs} activeId={tabs[0].id} onActivate={noop} />);
        expect(clean).toContain("chip active");
        expect(clean).not.toContain("ideTabDot");
        expect(clean).not.toContain("ideTabClose");
        // Unsaved state rides the accessible label only, never a dot.
        const dirty = tabs.map((t, i) => (i === 0 ? { ...t, dirty: true } : t));
        const dirtyHtml = renderToStaticMarkup(<EditorTabs tabs={dirty} activeId={dirty[0].id} onActivate={noop} />);
        expect(dirtyHtml).toContain("chip active");
        expect(dirtyHtml).toContain("unsaved changes");
        expect(dirtyHtml).not.toContain("ideTabDot");
        expect(dirtyHtml).not.toContain("ideTabClose");
    });

    it("has zero .runTerm nodes", () => {
        expect(shellHtml()).not.toContain("runTerm");
    });

    it("keeps tab memories isolated in markup: all bodies render, active is marked", () => {
        const tabs = defaultCaseTabs();
        const html = renderToStaticMarkup(
            <EditorTabs tabs={tabs} activeId={tabs[1].id} onActivate={noop} />,
        );
        for (const t of tabs) expect(html).toContain(t.title);
        expect(html).toContain('aria-selected="true"');
    });

    it("App owns useCaseTabs, mounts TopNav plus Body tabs inside SceneBars, and unmounts the sidebar", () => {
        const src = readFileSync(resolve(__dirname, "../App.tsx"), "utf8");
        expect(src).toContain("useCaseTabs");
        expect(src).toContain("<TopNav");
        expect(src).toContain("<EditorTabs");
        expect(src).toContain("<SceneBars");
        expect(src).toContain("<FieldBar");
        expect(src).toContain("CaseFrameCache");
        expect(src).not.toContain("<IdeSidebar");
        expect(src).not.toContain("<AnalysisPanel");
        expect(src).not.toContain("<IdeTitleBar");
        expect(src).not.toContain("<ActivityBar");
        expect(src).not.toContain("<IdeStatusBar");
        expect(src).not.toContain("from \"@/ui/IdeSidebar\"");
        expect(src).not.toContain("from \"@/ui/AnalysisPanel\"");
        expect(src).not.toContain("from \"@/ui/IdeTitleBar\"");
        expect(src).not.toContain("from \"@/ui/ActivityBar\"");
        expect(src).not.toContain("from \"@/ui/IdeStatusBar\"");
        expect(src).not.toContain("<RunTerminal");
        expect(src).not.toContain("<TelemetryBar");
        expect(src).not.toContain("from \"@/ui/RunTerminal\"");
        expect(src).not.toContain("from \"@/ui/TelemetryBar\"");
    });

    it("RunTerminal module is deleted", () => {
        let missing = false;
        try {
            readFileSync(resolve(__dirname, "./RunTerminal.tsx"), "utf8");
        } catch {
            missing = true;
        }
        expect(missing).toBe(true);
    });
});
