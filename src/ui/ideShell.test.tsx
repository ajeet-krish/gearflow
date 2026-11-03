// Phase 25 shell excision tests: caseTabs store plus static shell. The
// store proves tab memories are data only and isolated, the frame cache
// caps at 4. The static shell proves the excision: TopNav is the sole
// topmost bar, the sidebar owns its disclosure state, and the title,
// activity, and status bars are deleted with zero .runTerm nodes.

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
import TopNav from "./TopNav";
import EditorTabs from "./EditorTabs";
import IdeSidebar from "./IdeSidebar";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const noop = () => {};

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

describe("excised shell", () => {
    function shellHtml(): string {
        const tabs = defaultCaseTabs();
        return renderToStaticMarkup(
            <div className="page idePage">
                <TopNav active="studio" onNav={noop} settingsOpen={false} onOpenSettings={noop} />
                <EditorTabs tabs={tabs} activeId={tabs[0].id} onActivate={noop} />
                <IdeSidebar tabs={tabs} activeId={tabs[0].id} onActivate={noop} />
            </div>,
        );
    }

    it("renders TopNav as the sole topmost bar with tabs and the right sidebar", () => {
        const html = shellHtml();
        expect(html).toContain("topNav");
        expect(html).toContain("GearFlow");
        expect(html).toContain("ideTabs");
        expect(html).toContain("Right sidebar");
        expect(html).toContain("Explorer");
        expect(html).toContain("Source Control");
        expect(html).toContain("Extensions");
        expect(html).toContain("Analysis");
        expect(html).not.toContain("ideTitleBar");
        expect(html).not.toContain("ideActivity");
        expect(html).not.toContain("ideStatus");
        expect(html).not.toContain('aria-label="IDE status bar"');
        expect(html).toContain("ideSide");
    });

    it("the excised bar modules are deleted", () => {
        for (const name of ["IdeTitleBar.tsx", "ActivityBar.tsx", "IdeStatusBar.tsx"]) {
            expect(existsSync(resolve(__dirname, name))).toBe(false);
        }
        const names = readdirSync(__dirname);
        expect(names.some((n) => n === "IdeTitleBar.tsx" || n === "ActivityBar.tsx" || n === "IdeStatusBar.tsx")).toBe(false);
    });

    it("sidebar explorer carries the curated tree", () => {
        const tabs = defaultCaseTabs();
        const html = renderToStaticMarkup(
            <IdeSidebar tabs={tabs} activeId={tabs[0].id} onActivate={noop} />,
        );
        for (const name of ["docs", "src-agent", "src-ui", "src-render"]) {
            expect(html).toContain(name);
        }
    });

    it("sidebar owns its disclosure state internally with explorer open by default", () => {
        const tabs = defaultCaseTabs();
        const html = renderToStaticMarkup(
            <IdeSidebar tabs={tabs} activeId={tabs[0].id} onActivate={noop} />,
        );
        expect(html).toContain('aria-expanded="true"');
        expect(html).toContain("src-agent");
        expect(html).not.toContain("GearFlow Solver");
        const src = readFileSync(resolve(__dirname, "./IdeSidebar.tsx"), "utf8");
        expect(src).toContain("useState");
        expect(src).not.toContain("onSelectView");
        expect(src).not.toContain("view={activityView}");
    });

    it("sidebar analysis view mounts the default placeholder and a custom node when supplied", () => {
        const tabs = defaultCaseTabs();
        const fallback = renderToStaticMarkup(
            <IdeSidebar tabs={tabs} activeId={tabs[0].id} onActivate={noop} initialView="analysis" />,
        );
        expect(fallback).toContain("Analysis mounts here");
        const custom = renderToStaticMarkup(
            <IdeSidebar
                tabs={tabs}
                activeId={tabs[0].id}
                onActivate={noop}
                initialView="analysis"
                analysis={<p>custom-analysis-node</p>}
            />,
        );
        expect(custom).toContain("custom-analysis-node");
        expect(custom).not.toContain("Analysis mounts here");
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

    it("App owns useCaseTabs, mounts TopNav plus the sidebar, and unmounts the excised bars", () => {
        const src = readFileSync(resolve(__dirname, "../App.tsx"), "utf8");
        expect(src).toContain("useCaseTabs");
        expect(src).toContain("<TopNav");
        expect(src).toContain("<EditorTabs");
        expect(src).toContain("<IdeSidebar");
        expect(src).toContain("CaseFrameCache");
        expect(src).not.toContain("<IdeTitleBar");
        expect(src).not.toContain("<ActivityBar");
        expect(src).not.toContain("<IdeStatusBar");
        expect(src).not.toContain("activityView");
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
