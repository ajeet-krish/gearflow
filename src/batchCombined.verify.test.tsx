// Combined batch verification: sweep alpha gating, real-world appearance
// lines, body tab arrow keys, Rectangle naming, single 512 grid, and turn
// chrome removal. Static checks plus pure function calls only, no live
// solves, no worker threads, no DOM events.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isAlphaSweepIntent } from "@/agent/alphaSweep";
import { realWorldEquivalentLine } from "@/agent/nacaParse";
import { GRID_512 } from "@/contracts/types";
import { initialResolution, resolveGridSize } from "@/flow/gridController";
import EditorTabs from "@/ui/EditorTabs";
import { defaultCaseTabs } from "@/ui/caseTabs";

const here = dirname(fileURLToPath(import.meta.url));
const editorSrc = readFileSync(resolve(here, "./ui/EditorTabs.tsx"), "utf8");
const consoleSrc = readFileSync(resolve(here, "./ui/AgentConsole.tsx"), "utf8");
const blockSrc = readFileSync(resolve(here, "./agent/blockIntent.ts"), "utf8");

describe("batch sweep triggers require alpha or AoA", () => {
    it("fires on alpha scoped impact and affect phrasings", () => {
        expect(isAlphaSweepIntent("alpha impact on suction")).toBe(true);
        expect(isAlphaSweepIntent("impact on flow from alpha")).toBe(true);
        expect(isAlphaSweepIntent("how does alpha impact flow")).toBe(true);
        expect(isAlphaSweepIntent("impact of alpha on lift")).toBe(true);
        expect(isAlphaSweepIntent("how do changes in alpha affect lift")).toBe(true);
    });

    it("does not fire on Reynolds, temperature, or drag impact phrasings", () => {
        expect(isAlphaSweepIntent("impact of Reynolds number on flow")).toBe(false);
        expect(isAlphaSweepIntent("how do changes in temperature affect flow")).toBe(false);
        expect(isAlphaSweepIntent("how does drag impact flow")).toBe(false);
        expect(isAlphaSweepIntent("impact of drag on flow")).toBe(false);
        expect(isAlphaSweepIntent("how does Reynolds affect lift")).toBe(false);
        expect(isAlphaSweepIntent("how do changes affect lift")).toBe(false);
    });
});

describe("batch real-world lines use appearance plus drag note", () => {
    it("every branch names appearance and drag not modeled, no banned copy", () => {
        const samples: Array<[string, number, number, number]> = [
            ["9960", 0.09, 0.4, 0.6],
            ["2940", 0.09, 0.4, 0.4],
            ["2402", 0.02, 0.4, 0.02],
            ["1912", 0.19, 0.4, 0.12],
            ["2192", 0.02, 0.9, 0.12],
            ["2385", 0.02, 0.3, 0.85],
        ];
        for (const [code, m, p, t] of samples) {
            const line = realWorldEquivalentLine(code, m, p, t);
            expect(line).toContain("appearance");
            expect(line).toContain("drag is not modeled here");
            expect(line).not.toContain("behaves like");
            expect(line.toLowerCase()).not.toContain("efficient");
            expect(line).not.toContain("expect high drag");
            expect(line).not.toContain("useful for drag comparison");
        }
    });
});

describe("batch body tabs carry the arrow-key pattern", () => {
    it("tablist handles arrows with wrap plus Home and End with activation", () => {
        expect(editorSrc).toContain("ArrowLeft");
        expect(editorSrc).toContain("ArrowRight");
        expect(editorSrc).toContain('"Home"');
        expect(editorSrc).toContain('"End"');
        expect(editorSrc).toContain("onActivate(id)");
        expect(editorSrc).toContain("focus()");
        expect(editorSrc).toContain('role="tablist"');
        expect(editorSrc).toContain('role="tab"');
    });

    it("selected tab renders roving tabindex with the shared chip class", () => {
        const tabs = defaultCaseTabs();
        const html = renderToStaticMarkup(
            <EditorTabs tabs={tabs} activeId={tabs[0].id} onActivate={() => {}} />,
        );
        expect(html).toContain('role="tablist"');
        expect(html).toContain('role="tab"');
        expect(html).toContain("chip active");
        expect(html).not.toContain("ideTab selected");
        expect(html).toContain('tabindex="0"');
        expect(html).toContain('tabindex="-1"');
    });
});

describe("batch rectangular naming", () => {
    it("block copy names Rectangle or rectangular section, never bare block", () => {
        expect(blockSrc).toContain("Rectangle");
        expect(blockSrc).toContain("rectangular section");
        expect(blockSrc).not.toContain("Agent setup block");
        expect(blockSrc).not.toContain("block envelope");
    });
});

describe("batch single 512 grid", () => {
    it("controller is fixed at 512 with no selectable alternative", () => {
        expect(GRID_512).toBe(512);
        expect(resolveGridSize(initialResolution())).toBe(512);
    });
});

describe("batch turn chrome removed from render", () => {
    it("assistant turns render no reasoning trace, no applied receipts, no concept badge", () => {
        expect(consoleSrc).not.toContain("reasoningTrace");
        expect(consoleSrc).not.toContain("extra?.reasoning");
        expect(consoleSrc).not.toContain("extra?.applied");
        expect(consoleSrc).not.toContain("tutorLine");
        expect(consoleSrc).not.toContain("Physics Agent: {");
        const html = renderToStaticMarkup(
            <EditorTabs tabs={defaultCaseTabs()} activeId={defaultCaseTabs()[0].id} onActivate={() => {}} />,
        );
        expect(html).not.toContain("reasoningTrace");
    });
});
