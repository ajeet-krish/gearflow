// P1 IDE shell tests: caseTabs store plus static shell. The store proves
// tab memories are data only and isolated, the frame cache caps at 4, and
// the errorCount selector feeds the status bar. The static shell proves the
// VS Code Dark+ emulation mounts with zero .runTerm nodes.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
    CaseFrameCache,
    createCaseTabsStore,
    defaultCaseTabs,
    selectErrorCount,
    selectWarningCount,
    storeActivate,
    storeActive,
    storeUpdate,
    tabTitleFor,
    FRAME_CACHE_CAP,
} from "./caseTabs";
import IdeTitleBar from "./IdeTitleBar";
import ActivityBar from "./ActivityBar";
import EditorTabs from "./EditorTabs";
import IdeSidebar from "./IdeSidebar";
import IdeStatusBar from "./IdeStatusBar";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const noop = () => {};
const noopView = () => {};

describe("caseTabs store", () => {
    it("ships three default tabs with distinct titles", () => {
        const tabs = defaultCaseTabs();
        expect(tabs).toHaveLength(3);
        const titles = tabs.map((t) => t.title);
        expect(new Set(titles).size).toBe(3);
        expect(titles[0]).toContain("naca2412");
    });

    it("tab titles read file style from spec plus Re", () => {
        const tabs = defaultCaseTabs();
        expect(tabTitleFor(tabs[0].spec, tabs[0].reynolds)).toBe(tabs[0].title);
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

    it("updating a tab marks it dirty", () => {
        const store = createCaseTabsStore();
        expect(store.tabs[1].dirty).toBe(false);
        const next = storeUpdate(store, store.tabs[1].id, { reynolds: 700 });
        expect(next.tabs[1].dirty).toBe(true);
        expect(next.tabs[0].dirty).toBe(false);
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

describe("IDE static shell", () => {
    function shellHtml(): string {
        const tabs = defaultCaseTabs();
        return renderToStaticMarkup(
            <div className="page idePage">
                <IdeTitleBar title="GearFlow, naca2412" subtitle="analytic" offline={false} onOpenSettings={noop} />
                <ActivityBar active="explorer" onSelect={noopView} />
                <EditorTabs tabs={tabs} activeId={tabs[0].id} onActivate={noop} />
                <IdeSidebar tabs={tabs} activeId={tabs[0].id} onActivate={noop} view="explorer" onSelectView={noopView} />
                <IdeStatusBar branch="main" changedCount={0} errorCount={0} />
            </div>,
        );
    }

    it("renders VS Code chrome: title bar, activity, tabs, right sidebar, status", () => {
        const html = shellHtml();
        expect(html).toContain("ideTitleBar");
        expect(html).toContain("ideActivity");
        expect(html).toContain("ideTabs");
        expect(html).toContain("Right sidebar");
        expect(html).toContain("Explorer");
        expect(html).toContain("Source Control");
        expect(html).toContain("Extensions");
        expect(html).toContain("Analysis");
        expect(html).toContain("ideStatus");
        expect(html).toContain('aria-label="IDE status bar"');
        expect(html).toContain("main");
    });

    it("status bar carries branch, changed, and error items only", () => {
        const html = renderToStaticMarkup(<IdeStatusBar branch="main" changedCount={2} errorCount={1} />);
        expect(html).toContain("main");
        expect(html).toContain("2 changed");
        expect(html).toContain('aria-label="1 errors"');
        expect(html).not.toContain("ANALYTIC");
        expect(html).not.toContain("LIVE");
        expect(html).not.toContain("provenance");
    });

    it("sidebar explorer carries the curated tree", () => {
        const tabs = defaultCaseTabs();
        const html = renderToStaticMarkup(
            <IdeSidebar tabs={tabs} activeId={tabs[0].id} onActivate={noop} view="explorer" onSelectView={noopView} />,
        );
        for (const name of ["docs", "src-agent", "src-ui", "src-render"]) {
            expect(html).toContain(name);
        }
    });

    it("sidebar source control is a labelled snapshot, not live git", () => {
        const tabs = defaultCaseTabs();
        const html = renderToStaticMarkup(
            <IdeSidebar tabs={tabs} activeId={tabs[0].id} onActivate={noop} view="source-control" onSelectView={noopView} />,
        );
        expect(html).toContain("snapshot, not live git");
    });

    it("activity selection drives the sidebar disclosure", () => {
        const tabs = defaultCaseTabs();
        const extensions = renderToStaticMarkup(
            <IdeSidebar tabs={tabs} activeId={tabs[0].id} onActivate={noop} view="extensions" onSelectView={noopView} />,
        );
        expect(extensions).toContain("Extensions");
        expect(extensions).toContain("GearFlow Solver");
        const explorer = renderToStaticMarkup(
            <IdeSidebar tabs={tabs} activeId={tabs[0].id} onActivate={noop} view="explorer" onSelectView={noopView} />,
        );
        expect(explorer).not.toContain("GearFlow Solver");
    });

    it("editor tabs show a dot only when dirty and expose no close buttons", () => {
        const tabs = defaultCaseTabs();
        const clean = renderToStaticMarkup(<EditorTabs tabs={tabs} activeId={tabs[0].id} onActivate={noop} />);
        expect(clean).not.toContain("ideTabDot");
        expect(clean).not.toContain("ideTabClose");
        const dirty = tabs.map((t, i) => (i === 0 ? { ...t, dirty: true } : t));
        const dirtyHtml = renderToStaticMarkup(<EditorTabs tabs={dirty} activeId={dirty[0].id} onActivate={noop} />);
        expect(dirtyHtml).toContain("ideTabDot");
        expect(dirtyHtml).not.toContain("ideTabClose");
    });

    it("has zero .runTerm nodes", () => {
        expect(shellHtml()).not.toContain("runTerm");
    });

    it("keeps tab memories isolated in markup: both tabs render, active is marked", () => {
        const tabs = defaultCaseTabs();
        const html = renderToStaticMarkup(
            <EditorTabs tabs={tabs} activeId={tabs[1].id} onActivate={noop} />,
        );
        for (const t of tabs) expect(html).toContain(t.title);
        expect(html).toContain('aria-selected="true"');
    });

    it("App owns useCaseTabs, mounts the IDE shell, and unmounts TelemetryBar plus RunTerminal", () => {
        const src = readFileSync(resolve(__dirname, "../App.tsx"), "utf8");
        expect(src).toContain("useCaseTabs");
        expect(src).toContain("IdeTitleBar");
        expect(src).toContain("ActivityBar");
        expect(src).toContain("EditorTabs");
        expect(src).toContain("IdeSidebar");
        expect(src).toContain("IdeStatusBar");
        expect(src).toContain("selectErrorCount");
        expect(src).toContain("CaseFrameCache");
        expect(src).not.toContain("<RunTerminal");
        expect(src).not.toContain("<TelemetryBar");
        expect(src).not.toContain("from \"@/ui/RunTerminal\"");
        expect(src).not.toContain("from \"@/ui/RunTerminal\"");
        expect(src).not.toContain("from \"@/ui/TelemetryBar\"");
    });

    it("App status bar passes branch, changed, and error counts only", () => {
        const src = readFileSync(resolve(__dirname, "../App.tsx"), "utf8");
        const status = src.slice(src.indexOf("<IdeStatusBar"));
        expect(status).toContain("branch=");
        expect(status).toContain("changedCount=");
        expect(status).toContain("errorCount=");
        expect(status).not.toContain("engine=");
        expect(status).not.toContain("provenanceLabel=");
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
