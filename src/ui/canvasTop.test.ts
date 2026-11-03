// Body selector canvas top contract: TopNav is the sole topmost bar, the
// tunnel column keeps the Body tabs above the FIELD bar inside the
// collapsible SceneBars plus the run card. IdeSidebar plus the right
// RailShell plus the right ResizeHandle are deleted, AnalysisPanel stays in
// code but unmounted. Reads App.tsx source so the contract cannot drift
// without a test failure. No DOM needed.

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = resolve(here, "../App.tsx");

describe("Body selector canvas top", () => {
    it("keeps TopNav as the sole topmost bar with Body tabs, FIELD bar, and run card, no sidebar", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).toContain("<TopNav");
        expect(src).not.toContain("<IdeSidebar");
        expect(src).not.toContain("from \"@/ui/IdeSidebar\"");
        expect(src).toContain("<EditorTabs");
        expect(src).toContain("<SceneBars");
        expect(src).toContain("<FieldBar");
        expect(src).not.toContain("<IdeTitleBar");
        expect(src).not.toContain("<ActivityBar");
        expect(src).not.toContain("<IdeStatusBar");
        expect(src).not.toContain("from \"@/ui/IdeTitleBar\"");
        expect(src).not.toContain("from \"@/ui/ActivityBar\"");
        expect(src).not.toContain("from \"@/ui/IdeStatusBar\"");
        expect(src).not.toContain("<TelemetryBar");
        expect(src).not.toContain("<RunTerminal");
        expect(src).toContain('className="runCard"');
    });

    it("mounts Body tabs above the Field selector inside the scene bars", async () => {
        const src = await readFile(appPath, "utf8");
        const editorPath = resolve(here, "./EditorTabs.tsx");
        const editorSrc = await readFile(editorPath, "utf8");
        const barsOpen = src.indexOf("<SceneBars");
        const tabs = src.indexOf("<EditorTabs");
        const field = src.indexOf("<FieldBar");
        expect(barsOpen).toBeGreaterThan(-1);
        expect(tabs).toBeGreaterThan(-1);
        expect(field).toBeGreaterThan(-1);
        expect(tabs).toBeGreaterThan(barsOpen);
        expect(field).toBeGreaterThan(tabs);
        expect(editorSrc).toContain("BODY");
        expect(editorSrc).toContain('aria-label="Body"');
        expect(editorSrc).toContain('aria-label="Body selector"');
    });

    it("unmounts the right sidebar, right rail, and analysis panel", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).not.toContain("<IdeSidebar");
        expect(src).not.toContain("gripRight");
        expect(src).not.toContain("<AnalysisPanel");
        expect(src).not.toContain("from \"@/ui/AnalysisPanel\"");
        expect(src).not.toContain('side="right"');
        expect(src).not.toContain("railRightBody");
    });

    it("routes studio versus theory through the top navbar with the canvas hidden on theory", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).toContain("<TheoryPage");
        expect(src).toContain("activeNav");
        expect(src).toContain("handleNav");
        expect(src).toContain('activeNav === "theory"');
        expect(src).toContain("FULL SCREEN");
        expect(src).toContain("Exit full screen mode and restore panels");
        expect(src).not.toContain("EXIT FOCUS");
    });

    it("mounts no solver or LBM setup bars above the canvas", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).not.toContain("<SolverBar");
        expect(src).not.toContain("<LbmSetupRow");
    });

    it("routes field selection through the single funnel with the same gating", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).toContain("variable={effectiveVariable}");
        expect(src).toContain("hasTke={hasTke}");
        expect(src).toContain("hasRecirc={hasRecirc}");
        expect(src).toContain("overlays={effectiveOverlays}");
        expect(src).toContain("overlayPatchForFieldChange(next)");
    });

    it("derives effective overlays and passes booleans plus particle size to the canvas", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).toContain("resolveOverlays(effectiveVariable, prefs)");
        expect(src).toContain("showContours={effectiveOverlays.contours}");
        expect(src).toContain("showStreamlines={effectiveOverlays.showStreamlines}");
        expect(src).toContain("particleSize={prefs.particleSize}");
    });

    it("carries no DISPLAY section", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).not.toMatch(/id:\s*"display"/);
        expect(src).not.toContain("displaySummary");
    });

    it("run card shows BODY, ALPHA, RE, CL, CPMIN with no GRID or REGIME rows", async () => {
        const src = await readFile(appPath, "utf8");
        for (const row of ["<dt>BODY</dt>", "<dt>ALPHA</dt>", "<dt>RE</dt>", "<dt>CL</dt>", "<dt>CPMIN</dt>"]) {
            expect(src).toContain(row);
        }
        expect(src).not.toContain("<dt>GRID</dt>");
        expect(src).not.toContain("<dt>REGIME</dt>");
    });

    it("unmounts the eval ledger from the analysis rail", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).not.toContain("<EvalLogPanel");
        expect(src).not.toContain('id: "eval"');
        expect(src).not.toContain("EVAL LEDGER");
    });

    it("owns no terminal or excised shell state: Escape only exits focus, no status bar", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).not.toContain("terminalOpen");
        expect(src).not.toContain("clearTerminal");
        expect(src).not.toContain("<RunTerminal");
        expect(src).toContain("exitFocus");
        expect(src).not.toContain("<IdeStatusBar");
        expect(src).not.toContain("activityView");
        expect(src).not.toContain("errorCount");
    });
});
