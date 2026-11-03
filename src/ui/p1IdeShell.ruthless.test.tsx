// P1 IDE shell ruthless verification: status bar, tabs, sidebar,
// RunTerminal eradication, tab memory isolation with full key coverage.
// Static markup only (vitest node env), plus App source pins.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
    caseKeyFor,
    createCaseTabsStore,
    defaultCaseTabs,
    storeActivate,
    storeActive,
    storeUpdate,
    tabTitleFor,
} from "./caseTabs";
import type { GeometrySpec } from "@/contracts/types";
import EditorTabs from "./EditorTabs";
import IdeSidebar from "./IdeSidebar";
import IdeStatusBar from "./IdeStatusBar";
import ActivityBar from "./ActivityBar";
import IdeTitleBar from "./IdeTitleBar";
import { IDE_ACTIVITY_VIEWS } from "./ideData";

const noop = () => {};
const noopView = (_v: string) => {};

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

describe("P1 status bar: git plus errors only, zero solver tokens", () => {
    it("renders branch, changed count, and error count with honest labels", () => {
        const html = renderToStaticMarkup(<IdeStatusBar branch="main" changedCount={2} errorCount={1} />);
        expect(html).toContain("main");
        expect(html).toContain("2 changed");
        expect(html).toContain("1 errors");
        expect(html).toContain('role="status"');
        expect(html).toContain('aria-label="IDE status bar"');
        expect(html).toContain('aria-label="Git branch main"');
        expect(html).toContain('aria-label="2 changed files"');
        expect(html).toContain('aria-label="1 errors"');
    });

    it("carries zero solver or provenance tokens in markup", () => {
        const html = renderToStaticMarkup(<IdeStatusBar branch="main" changedCount={0} errorCount={0} />);
        const banned = [
            "ANALYTIC", "LIVE", "NEURAL", "LBM", "FIXTURE", "HELD",
            "provenance", "engine", "grid", "field", "Cl", "CpMin",
            "256", "128", "Re ", "telemetry", "runTerm", "RunTerminal",
        ];
        for (const token of banned) expect(html).not.toContain(token);
    });

    it("zero counts render without hiding the items", () => {
        const html = renderToStaticMarkup(<IdeStatusBar branch="main" changedCount={0} errorCount={0} />);
        expect(html).toContain("0 changed");
        expect(html).toContain("0 errors");
        expect(count(html, "ideStatusItem")).toBe(3);
    });

    it("large counts render verbatim with matching aria labels", () => {
        const html = renderToStaticMarkup(<IdeStatusBar branch="feature/x" changedCount={128} errorCount={9} />);
        expect(html).toContain("feature/x");
        expect(html).toContain("128 changed");
        expect(html).toContain("9 errors");
        expect(html).toContain('aria-label="128 changed files"');
        expect(html).toContain('aria-label="9 errors"');
    });

    it("App wires exactly branch, changedCount, errorCount and no solver props", () => {
        const src = readFileSync(resolve(__dirname, "../App.tsx"), "utf8");
        const at = src.indexOf("<IdeStatusBar");
        expect(at).toBeGreaterThan(-1);
        const block = src.slice(at, at + 400);
        expect(block).toContain("branch=");
        expect(block).toContain("changedCount=");
        expect(block).toContain("errorCount=");
        for (const banned of ["engine=", "provenanceLabel=", "grid=", "variable=", "reynolds=", "cl=", "cpMin=", "warningCount=", "backend="]) {
            expect(block).not.toContain(banned);
        }
    });

    it("App error count flows from selectErrorCount, never a raw fail field", () => {
        const src = readFileSync(resolve(__dirname, "../App.tsx"), "utf8");
        expect(src).toContain("selectErrorCount");
    });
});

describe("P1 tabs: no close buttons, dirty dot only", () => {
    it("clean tabs carry zero dots and zero close affordances", () => {
        const tabs = defaultCaseTabs();
        const html = renderToStaticMarkup(<EditorTabs tabs={tabs} activeId={tabs[0].id} onActivate={noop} />);
        expect(html).not.toContain("ideTabDot");
        expect(html).not.toContain("ideTabClose");
        expect(html.toLowerCase()).not.toContain("close");
        expect(html).not.toContain("&times;");
    });

    it("exactly one dot appears when exactly one memory is dirty", () => {
        const tabs = defaultCaseTabs();
        const dirty = tabs.map((t, i) => (i === 1 ? { ...t, dirty: true } : t));
        const html = renderToStaticMarkup(<EditorTabs tabs={dirty} activeId={dirty[1].id} onActivate={noop} />);
        expect(count(html, "ideTabDot")).toBe(1);
        expect(html).not.toContain("ideTabClose");
        expect(html.toLowerCase()).not.toContain("close");
    });

    it("all dirty tabs each carry a dot and still no close button", () => {
        const tabs = defaultCaseTabs().map((t) => ({ ...t, dirty: true }));
        const html = renderToStaticMarkup(<EditorTabs tabs={tabs} activeId={tabs[0].id} onActivate={noop} />);
        expect(count(html, "ideTabDot")).toBe(tabs.length);
        expect(html).not.toContain("ideTabClose");
    });

    it("dot is aria hidden decoration, tab label names unsaved state for AT", () => {
        const tabs = defaultCaseTabs().map((t, i) => (i === 0 ? { ...t, dirty: true } : t));
        const html = renderToStaticMarkup(<EditorTabs tabs={tabs} activeId={tabs[0].id} onActivate={noop} />);
        expect(html).toContain('aria-hidden="true"');
        expect(html).toContain("unsaved changes");
    });

    it("empty tab list renders the tablist with zero tabs and no crash", () => {
        const html = renderToStaticMarkup(<EditorTabs tabs={[]} activeId="" onActivate={noop} />);
        expect(html).toContain('aria-label="Open cases"');
        expect(html).toContain('role="tablist"');
        expect(html).not.toContain('role="tab"');
    });

    it("exactly one tab is aria selected", () => {
        const tabs = defaultCaseTabs();
        const html = renderToStaticMarkup(<EditorTabs tabs={tabs} activeId={tabs[2].id} onActivate={noop} />);
        expect(count(html, 'aria-selected="true"')).toBe(1);
        expect(count(html, 'aria-selected="false"')).toBe(tabs.length - 1);
    });

    it("EditorTabs source offers keyboard activation with no close handler", () => {
        const src = readFileSync(resolve(__dirname, "./EditorTabs.tsx"), "utf8");
        expect(src).toContain("onKeyDown");
        expect(src).toContain("Enter");
        for (const token of ["ideTabClose", "onClose", "closeTab", "aria-label=\"Close", "&times;"]) {
            expect(src).not.toContain(token);
        }
    });
});

describe("P1 right sidebar: four disclosures wired to the activity view", () => {
    it("declares exactly the four activity views", () => {
        expect(IDE_ACTIVITY_VIEWS.map((v) => v.id)).toEqual(["explorer", "source-control", "extensions", "analysis"]);
    });

    it("renders exactly four disclosure sections with the VS Code labels", () => {
        const tabs = defaultCaseTabs();
        const html = renderToStaticMarkup(
            <IdeSidebar tabs={tabs} activeId={tabs[0].id} onActivate={noop} view="explorer" onSelectView={noopView} />,
        );
        expect(count(html, 'class="ideSec"')).toBe(4);
        for (const label of ["Explorer", "Source Control", "Extensions", "Analysis"]) {
            expect(html).toContain(label);
        }
        expect(html).toContain('aria-label="Right sidebar"');
    });

    it("explorer view opens the curated tree and case list only", () => {
        const tabs = defaultCaseTabs();
        const html = renderToStaticMarkup(
            <IdeSidebar tabs={tabs} activeId={tabs[0].id} onActivate={noop} view="explorer" onSelectView={noopView} />,
        );
        for (const name of ["docs", "src-agent", "src-ui", "src-render"]) expect(html).toContain(name);
        for (const t of tabs) expect(html).toContain(t.title);
        expect(html).not.toContain("GearFlow Solver");
        expect(html).not.toContain("snapshot, not live git");
        expect(html).not.toContain("Analysis mounts here");
    });

    it("source control view is a labelled snapshot, never live git", () => {
        const tabs = defaultCaseTabs();
        const html = renderToStaticMarkup(
            <IdeSidebar tabs={tabs} activeId={tabs[0].id} onActivate={noop} view="source-control" onSelectView={noopView} />,
        );
        expect(html).toContain("snapshot, not live git");
        expect(html).not.toContain("GearFlow Solver");
        expect(html).not.toContain("src-agent");
    });

    it("extensions view lists the static solver entries only", () => {
        const tabs = defaultCaseTabs();
        const html = renderToStaticMarkup(
            <IdeSidebar tabs={tabs} activeId={tabs[0].id} onActivate={noop} view="extensions" onSelectView={noopView} />,
        );
        expect(html).toContain("GearFlow Solver");
        expect(html).toContain("Validation Ledger");
        expect(html).toContain("Export");
        expect(html).not.toContain("src-agent");
        expect(html).not.toContain("snapshot, not live git");
    });

    it("analysis view mounts the default placeholder and a custom node when supplied", () => {
        const tabs = defaultCaseTabs();
        const fallback = renderToStaticMarkup(
            <IdeSidebar tabs={tabs} activeId={tabs[0].id} onActivate={noop} view="analysis" onSelectView={noopView} />,
        );
        expect(fallback).toContain("Analysis mounts here");
        expect(fallback).not.toContain("GearFlow Solver");
        const custom = renderToStaticMarkup(
            <IdeSidebar
                tabs={tabs}
                activeId={tabs[0].id}
                onActivate={noop}
                view="analysis"
                onSelectView={noopView}
                analysis={<p>custom-analysis-node</p>}
            />,
        );
        expect(custom).toContain("custom-analysis-node");
        expect(custom).not.toContain("Analysis mounts here");
    });

    it("aria expanded tracks the active view one hot, three cold", () => {
        const tabs = defaultCaseTabs();
        const html = renderToStaticMarkup(
            <IdeSidebar tabs={tabs} activeId={tabs[0].id} onActivate={noop} view="analysis" onSelectView={noopView} />,
        );
        expect(count(html, 'aria-expanded="true"')).toBe(1);
        expect(count(html, 'aria-expanded="false"')).toBe(3);
    });

    it("App binds the sidebar view to ActivityBar selection state", () => {
        const src = readFileSync(resolve(__dirname, "../App.tsx"), "utf8");
        expect(src).toContain("view={activityView}");
        expect(src).toContain("onSelectView={setActivityView}");
        expect(src).toContain("<ActivityBar active={activityView} onSelect={setActivityView} />");
    });
});

describe("P1 RunTerminal eradication: module gone, zero nodes", () => {
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

    it("static IDE shell markup carries zero runTerm nodes", () => {
        const tabs = defaultCaseTabs();
        const html = renderToStaticMarkup(
            <div className="page idePage">
                <IdeTitleBar title="GearFlow, naca2412" subtitle="analytic" offline={false} onOpenSettings={noop} />
                <ActivityBar active="explorer" onSelect={noopView} />
                <EditorTabs tabs={tabs} activeId={tabs[0].id} onActivate={noop} />
                <IdeSidebar tabs={tabs} activeId={tabs[0].id} onActivate={noop} view="explorer" onSelectView={noopView} />
                <IdeStatusBar branch="main" changedCount={0} errorCount={0} />
            </div>,
        );
        expect(html.toLowerCase()).not.toContain("runterm");
        expect(html.toLowerCase()).not.toContain("telemetrybar");
    });
});

describe("P1 tab memories: isolated data with full serialization keys", () => {
    it("ships three isolated default tabs with file style titles", () => {
        const tabs = defaultCaseTabs();
        expect(tabs).toHaveLength(3);
        expect(new Set(tabs.map((t) => t.id)).size).toBe(3);
        expect(new Set(tabs.map((t) => t.title)).size).toBe(3);
        expect(tabs[0].title).toContain("naca2412");
        for (const t of tabs) expect(tabTitleFor(t.spec, t.reynolds)).toBe(t.title);
        expect(tabs[0].spec).not.toBe(tabs[1].spec);
        expect(tabs[0].spec.naca).not.toBe(tabs[2].spec.naca);
    });

    it("updating one memory leaves siblings untouched by reference and by value", () => {
        const store = createCaseTabsStore();
        const before = JSON.stringify(store.tabs.map((t) => t.spec));
        const next = storeUpdate(store, store.tabs[1].id, { reynolds: 700 });
        expect(next.tabs[1].reynolds).toBe(700);
        expect(next.tabs[1].dirty).toBe(true);
        expect(next.tabs[0]).toBe(store.tabs[0]);
        expect(next.tabs[2]).toBe(store.tabs[2]);
        expect(JSON.stringify(store.tabs.map((t) => t.spec))).toBe(before);
        expect(next.tabs[0].dirty).toBe(false);
    });

    it("spec patch clones input and retitles the tab", () => {
        const store = createCaseTabsStore();
        const id = store.tabs[0].id;
        const patch: GeometrySpec = { ...baseSpec(), alphaDeg: 9 };
        const next = storeUpdate(store, id, { spec: patch });
        patch.alphaDeg = 99;
        expect(next.tabs[0].spec.alphaDeg).toBe(9);
        expect(next.tabs[0].title).toBe(tabTitleFor(next.tabs[0].spec, next.tabs[0].reynolds));
        expect(next.tabs[0].title).toContain("a9");
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
