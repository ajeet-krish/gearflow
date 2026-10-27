// RunTerminal Phase B: collapsed 24px strip with engine, grid, Re, step
// mono groups plus a Log toggle with the row count, expandable log panel
// above it with auto scroll, sticky Clear, and red tinted fault rows.
// Static markup for structure, direct element calls for the toggle, Clear,
// and Escape wiring. Collapsed on load, focus never moves on new rows.

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import RunTerminal, { RunTerminalView, type TerminalRow, type TerminalStatus } from "./RunTerminal";

const noop = () => {};

const ROWS: TerminalRow[] = [
    { key: "run-0-s0", text: "step 0: Run blocked: over the Re ceiling", tone: "block" },
    { key: "failover", text: "LBM tau floor fault at Re 800, analytic fallback serving frames.", tone: "error" },
];

function render(over: Partial<Parameters<typeof RunTerminal>[0]> = {}) {
    return renderToStaticMarkup(
        <RunTerminal
            status="ready"
            engine="LBM"
            gridLabel="128 x 128"
            reynolds={200}
            stepText="step 512 of 40000 (1 percent)"
            rows={ROWS}
            expanded={false}
            onToggle={noop}
            onClear={noop}
            {...over}
        />,
    );
}

interface TestEl {
    type: unknown;
    props: Record<string, unknown>;
}

function isEl(node: unknown): node is TestEl {
    return typeof node === "object" && node !== null && "type" in node && "props" in node;
}

function walk(node: unknown, visit: (el: TestEl) => void): void {
    if (Array.isArray(node)) {
        for (const child of node) walk(child, visit);
        return;
    }
    if (isEl(node)) {
        visit(node);
        walk(node.props.children, visit);
    }
}

function findAll(tree: unknown, pred: (el: TestEl) => boolean): TestEl[] {
    const out: TestEl[] = [];
    walk(tree, (el) => {
        if (pred(el)) out.push(el);
    });
    return out;
}

describe("RunTerminal strip", () => {
    it("renders the 24px status strip with engine, grid, Re, and step groups", () => {
        const html = render();
        expect(html).toContain('aria-label="Run terminal"');
        expect(html).toContain("LBM");
        expect(html).toContain("128 x 128");
        expect(html).toContain("200");
        expect(html).toContain("step 512 of 40000 (1 percent)");
        for (const label of ["ENGINE", "GRID", "RE", "STEP"]) {
            expect(html).toContain(label);
        }
    });

    it("is collapsed on load: no log panel, toggle names expansion with the row count", () => {
        const html = render({ expanded: false });
        expect(html).not.toContain('id="runTermPanel"');
        expect(html).not.toContain("Run blocked");
        expect(html).not.toContain("tau floor fault");
        expect(html).toContain('aria-expanded="false"');
        expect(html).toContain('aria-label="Expand run log"');
        expect(html).toContain('aria-controls="runTermPanel"');
        expect(html).toContain("LOG");
        expect(html).toContain(">2<");
    });

    it("maps the status to the dot language: grey idle, green ready, accent running, red failed", () => {
        const dotOf = (status: TerminalStatus): string => {
            const html = render({ status });
            const at = html.indexOf('class="dot');
            expect(at).toBeGreaterThan(-1);
            return html.slice(at, html.indexOf('"', at + 8) + 1);
        };
        expect(dotOf("idle")).toBe('class="dot"');
        expect(dotOf("ready")).toContain("analytic");
        expect(dotOf("running")).toContain("running");
        expect(dotOf("failed")).toContain("failed");
    });

    it("the toggle fires onToggle", () => {
        const onToggle = vi.fn();
        const tree = RunTerminalView({
            status: "ready",
            engine: "LBM",
            gridLabel: "128 x 128",
            reynolds: 200,
            stepText: "single pass",
            rows: ROWS,
            expanded: false,
            onToggle,
            onClear: noop,
        }) as unknown;
        const toggles = findAll(tree, (el) => el.type === "button" && el.props["aria-label"] === "Expand run log");
        expect(toggles).toHaveLength(1);
        (toggles[0].props.onClick as () => void)();
        expect(onToggle).toHaveBeenCalledTimes(1);
    });
});

describe("RunTerminal panel", () => {
    it("expands a log panel above the strip with the rows and a role of log", () => {
        const html = render({ expanded: true });
        expect(html).toContain('id="runTermPanel"');
        expect(html).toContain('role="log"');
        expect(html).toContain('aria-label="Run event log"');
        expect(html).toContain("step 0: Run blocked");
        expect(html).toContain("LBM tau floor fault");
        expect(html).toContain('aria-expanded="true"');
        expect(html).toContain('aria-label="Collapse run log"');
    });

    it("tints block and error rows red while info rows stay quiet", () => {
        const html = render({
            expanded: true,
            rows: [
                { key: "a", text: "step 1: note", tone: "info" },
                { key: "b", text: "step 2: blocked", tone: "block" },
                { key: "c", text: "failover", tone: "error" },
            ],
        });
        const rowOf = (text: string): string => {
            const end = html.indexOf(text);
            expect(end).toBeGreaterThan(-1);
            return html.slice(html.lastIndexOf("<li", end), end);
        };
        expect(rowOf("step 1: note")).not.toContain("tone-");
        expect(rowOf("step 2: blocked")).toContain("tone-block");
        expect(rowOf("failover")).toContain("tone-error");
    });

    it("shows an empty session note with Clear still reachable", () => {
        const html = render({ expanded: true, rows: [] });
        expect(html).toContain("No run events this session");
        expect(html).toContain('aria-label="Clear run log"');
    });

    it("Clear fires onClear without touching the strip", () => {
        const onClear = vi.fn();
        const tree = RunTerminalView({
            status: "failed",
            engine: "LBM",
            gridLabel: "128 x 128",
            reynolds: 200,
            stepText: "step 0 of 40000 (0 percent)",
            rows: ROWS,
            expanded: true,
            onToggle: noop,
            onClear,
        }) as unknown;
        const clears = findAll(tree, (el) => el.type === "button" && el.props["aria-label"] === "Clear run log");
        expect(clears).toHaveLength(1);
        (clears[0].props.onClick as () => void)();
        expect(onClear).toHaveBeenCalledTimes(1);
        const html = renderToStaticMarkup(tree as never);
        expect(html).toContain("runTermStrip");
    });

    it("Escape collapses the panel without stealing focus", () => {
        const onToggle = vi.fn();
        const stopped: string[] = [];
        const tree = RunTerminalView({
            status: "ready",
            engine: "ANALYTIC",
            gridLabel: "256 x 256",
            reynolds: 50000,
            stepText: "single pass",
            rows: ROWS,
            expanded: true,
            onToggle,
            onClear: noop,
        }) as unknown;
        const sections = findAll(tree, (el) => el.type === "section");
        expect(sections).toHaveLength(1);
        (sections[0].props.onKeyDown as (e: unknown) => void)({
            key: "Escape",
            stopPropagation: (): void => {
                stopped.push("stop");
            },
        });
        expect(onToggle).toHaveBeenCalledTimes(1);
        expect(stopped).toEqual(["stop"]);
    });

    it("Escape does nothing while the panel is already collapsed", () => {
        const onToggle = vi.fn();
        const tree = RunTerminalView({
            status: "ready",
            engine: "ANALYTIC",
            gridLabel: "256 x 256",
            reynolds: 50000,
            stepText: "single pass",
            rows: ROWS,
            expanded: false,
            onToggle,
            onClear: noop,
        }) as unknown;
        const sections = findAll(tree, (el) => el.type === "section");
        expect(sections).toHaveLength(1);
        (sections[0].props.onKeyDown as (e: unknown) => void)({ key: "Escape", stopPropagation: () => {} });
        expect(onToggle).not.toHaveBeenCalled();
    });
});
