// Phase 25 chat terminal contract: square corners scoped to the terminal
// descendants with the live dot round, no hint bar, no rendered Applied
// lines, and a caret-following 2px line cursor. Static markup plus source
// and stylesheet pins, zero live calls.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import AgentConsole from "./AgentConsole";
import type { ChatTurn } from "@/contracts/types";

const here = dirname(fileURLToPath(import.meta.url));
const consolePath = resolve(here, "./AgentConsole.tsx");
const cssPath = resolve(here, "../styles.css");

function assistantTurn(over: Partial<ChatTurn> = {}): ChatTurn {
    return {
        id: "t-assistant-1",
        role: "assistant",
        text: "Run looks healthy at alpha 6.",
        at: new Date().toISOString(),
        tool: "modal",
        status: "live",
        ...over,
    };
}

describe("Phase 25 chat terminal chrome", () => {
    it("defers the caret line until measurement with mirror and native caret in static markup", () => {
        const html = renderToStaticMarkup(<AgentConsole offline={false} onOfflineChange={() => {}} />);
        // Static markup never runs effects or refs, so caretMeasured stays
        // false: the 2px line stays hidden with the native caret kept, while
        // the hidden mirror span still renders for later measurement.
        expect(html).not.toContain("tuiCaret");
        expect(html).toContain("tuiMirror");
        expect(html).toContain("caret-color:auto");
        expect(html).not.toContain("tuiCursor");
        expect(html).not.toContain("chatHints");
    });

    it("keeps the live dot round while terminal descendants go square", async () => {
        const css = await readFile(cssPath, "utf8");
        expect(css).toContain(".tuiConsole .liveDot { border-radius: 50%; }");
        expect(css).toContain(".tuiConsole .chatInput");
        expect(css).toContain("border-radius: 0;");
        expect(css).not.toContain(".chatHints");
        expect(css).not.toContain(".tuiCursor");
        expect(css).not.toContain("tuiBlink");
    });

    it("keeps the apply receipt in extras while Applied lines never render", async () => {
        const src = await readFile(consolePath, "utf8");
        expect(src).not.toContain("status-pass\">applied");
        // The receipt strings are still built for the tutor capture, but
        // the turn render never prints them.
        expect(src).toContain("Applied: ");
        const html = renderToStaticMarkup(
            <AgentConsole
                offline={false}
                onOfflineChange={() => {}}
                initialTurns={[assistantTurn({ text: "Tuning the run now." })]}
                initialExtras={{
                    "t-assistant-1": {
                        model: "gearflow-chat",
                        inputTokens: 12,
                        outputTokens: 24,
                        costUsd: 0.0001,
                        streaming: false,
                        stopped: false,
                        applied: ["Applied: angle of attack (alpha) 6 deg."],
                        rejections: [],
                        pendingRuns: [],
                    },
                }}
            />
        );
        expect(html).not.toContain("Applied: angle of attack (alpha) 6 deg.");
        expect(html).not.toContain("Applied:");
        expect(html).not.toContain(">applied</span>");
    });

    it("hides the native caret only after the first mirror measurement", async () => {
        const src = await readFile(consolePath, "utf8");
        expect(src).toContain("tuiMirror");
        expect(src).toContain("measureCaret");
        expect(src).toContain('caretColor: caretMeasured ? "transparent" : "auto"');
    });

    it("parks a 2px line on the caret with a 90ms transform transition plus blink", async () => {
        const src = await readFile(consolePath, "utf8");
        expect(src).toContain("tuiCaret");
        // Gated render: the line mounts only after the first measurement so
        // SSR and no-JS keep the native caret.
        expect(src).toContain("caretMeasured ? (");
        expect(src).toContain("translate(${caretX}px, -50%)");
        const css = await readFile(cssPath, "utf8");
        expect(css).toContain(".tuiCaret {");
        expect(css).toContain("width: 2px;");
        expect(css).toContain("transition: transform 90ms;");
        expect(css).toContain("tuiCaretBlink");
        expect(css).toContain("@media (prefers-reduced-motion: reduce) {");
    });

    it("sends on Enter, stops and blurs on Escape, and leaves Tab native", async () => {
        const src = await readFile(consolePath, "utf8");
        expect(src).toContain('if (e.key === "Enter")');
        expect(src).toContain('if (e.key === "Tab")');
        expect(src).toContain('if (e.key === "Escape")');
        expect(src).toContain("e.currentTarget.blur()");
        expect(src).toContain("onStop()");
    });
});
