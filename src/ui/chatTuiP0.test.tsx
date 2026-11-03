// P0 chat TUI contract. Static markup plus pure helpers, zero live
// calls. Pins the six P0 requirements: no header or offline toggle or
// clear chrome, Tutor label with a green dot and no live text pill,
// no tool or model pills, example plus tutorial dropdowns side by side
// in one row, no session cost render with the spend gate still forcing
// the offline path, and one single combined response with Retry plus
// the collapsed reasoning trace intact.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import AgentConsole, { spendExceeded, SPEND_SOFT_STOP_USD } from "./AgentConsole";
import { EXAMPLE_PROMPTS } from "./AgentConsole";
import { CURRICULUM_CHIPS } from "@/agent/curriculum";
import type { ChatTurn } from "@/contracts/types";

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

function tutorTurn(): ChatTurn {
    return {
        id: "t-tutor-1",
        role: "assistant",
        text: "Nudge alpha by 1 deg and watch Cl climb.\n\nBefore vs after\nMetric | Before | After | Delta\nCl | 0.600 | 0.700 | +0.100",
        at: new Date().toISOString(),
        tool: "modal",
        status: "live",
        tutor: {
            concept: "general",
            primary: "speed",
            secondary: "cp",
            rows: [{ metric: "Cl", before: "0.600", after: "0.700", delta: "+0.100" }],
            caseKey: "naca4|a6|Re50000|analytic|fspeed",
        },
    };
}

describe("P0 chat TUI chrome", () => {
    it("renders no header, offline toggle, or clear control", () => {
        const html = renderToStaticMarkup(<AgentConsole offline={false} onOfflineChange={() => {}} />);
        expect(html).not.toContain("chatBar");
        expect(html).not.toContain("agentOffline");
        expect(html).not.toContain("chatClear");
        expect(html).not.toContain("Clear chat");
        expect(html).not.toContain("Clear run log");
        expect(html).toContain("tuiConsole");
        expect(html).toContain("chatLog");
    });

    it("labels live assistant turns Tutor with a green dot and no live text pill", () => {
        const html = renderToStaticMarkup(
            <AgentConsole
                offline={false}
                onOfflineChange={() => {}}
                initialTurns={[assistantTurn({ status: "live" })]}
            />
        );
        expect(html).toContain(">Tutor</span>");
        expect(html).toContain("liveDot");
        expect(html).toContain("visuallyHidden\">live</span>");
        expect(html).not.toContain(">Agent</span>");
        expect(html).not.toContain("status-live");
        expect(html).not.toContain("tuiPill");
    });

    it("renders no tool or model pills on any turn", () => {
        const html = renderToStaticMarkup(
            <AgentConsole
                offline={false}
                onOfflineChange={() => {}}
                initialTurns={[
                    assistantTurn({ id: "t-live", status: "live", text: "Live note." }),
                    assistantTurn({ id: "t-cached", status: "cached", text: "Cached note." }),
                    { id: "t-user", role: "user", text: "Explain this run", at: new Date().toISOString() },
                    { id: "t-bare", role: "assistant", text: "Bare note", at: new Date().toISOString() },
                ]}
            />
        );
        expect(html).not.toContain("gearflow-chat");
        expect(html).not.toContain(">modal</span>");
        expect(html).not.toContain(">legacy</span>");
        expect(html).not.toContain(">baseten<");
        expect(html).not.toContain(">tool<");
    });

    it("places the example and tutorial dropdowns side by side in one row", async () => {
        const html = renderToStaticMarkup(<AgentConsole offline={false} onOfflineChange={() => {}} />);
        const rowOpen = html.indexOf("promptRow");
        expect(rowOpen).toBeGreaterThan(-1);
        const exampleIdx = html.indexOf('id="examplePrompts"');
        const tutorialIdx = html.indexOf('id="tutorialPrompts"');
        expect(exampleIdx).toBeGreaterThan(-1);
        expect(tutorialIdx).toBeGreaterThan(-1);
        // Both selects render after the single promptRow opener, so they
        // share one row instead of stacking in separate blocks.
        expect(exampleIdx).toBeGreaterThan(rowOpen);
        expect(tutorialIdx).toBeGreaterThan(rowOpen);
        for (const item of EXAMPLE_PROMPTS) {
            expect(html).toContain(item.label);
        }
        for (const chip of CURRICULUM_CHIPS) {
            expect(html).toContain(chip.label);
        }
        // Stylesheet pins the row to two equal columns on desktop with a
        // single column fallback under 560px.
        const here = dirname(fileURLToPath(import.meta.url));
        const css = await readFile(resolve(here, "../styles.css"), "utf8");
        expect(css).toContain(".promptRow { display: grid; grid-template-columns: 1fr 1fr;");
        expect(css).toContain(".promptRow { grid-template-columns: 1fr; }");
    });

    it("renders no session cost with the spend gate still forcing offline", () => {
        const html = renderToStaticMarkup(
            <AgentConsole offline={false} onOfflineChange={() => {}} spendCapUsd={0} />
        );
        expect(html).not.toContain("chatFoot");
        expect(html).not.toContain("Session spend meter");
        expect(html).not.toContain("Session ");
        expect(html).not.toContain("est $");
        expect(html).not.toContain("Spend cap");
        expect(html).not.toContain("demo mode until reset");
        expect(html).not.toContain("local mode until reset");
        // The gate itself stays in logic: five dollars trips the default
        // cap, and any positive spend trips a zero cap.
        expect(SPEND_SOFT_STOP_USD).toBe(5);
        expect(spendExceeded(5)).toBe(true);
        expect(spendExceeded(0.01)).toBe(false);
        expect(spendExceeded(0.01, 0)).toBe(true);
    });

    it("keeps one single combined response with Retry and reasoning intact", () => {
        const html = renderToStaticMarkup(
            <AgentConsole
                offline={false}
                onOfflineChange={() => {}}
                initialTurns={[tutorTurn()]}
                initialExtras={{
                    "t-tutor-1": {
                        model: "modal-chat",
                        inputTokens: 10,
                        outputTokens: 20,
                        costUsd: 0.0001,
                        streaming: false,
                        stopped: false,
                        applied: ["Applied: angle of attack (alpha) 6 deg."],
                        rejections: [],
                        pendingRuns: [],
                        reasoning: "Checked the before versus after Cl delta.",
                        tutorError: "boom",
                    },
                }}
            />
        );
        // Single combined turn: the applied line, the numbers table, and
        // the Retry chip all live on the same Tutor turn, never a second
        // tutor turn.
        expect(html).toContain(">Tutor</span>");
        expect(html).toContain("Applied: angle of attack (alpha) 6 deg.");
        expect(html).toContain("<table");
        expect(html).toContain("Retry");
        expect(html).toContain('aria-label="Retry tutor request"');
        // Reasoning survives as a collapsed trace, never parsed or applied.
        expect(html).toContain("reasoningTrace");
        expect(html).toContain("Reasoning");
        expect(html).toContain("Checked the before versus after Cl delta.");
        // No second tutor turn and no tool or model pills leaked back in.
        expect(html.match(/tutorTurn/g)?.length ?? 0).toBe(1);
        expect(html).not.toContain("gearflow-chat");
        expect(html).not.toContain(">modal</span>");
    });

    it("keeps the chat Retry chip on honest failure turns", () => {
        const html = renderToStaticMarkup(
            <AgentConsole
                offline={false}
                onOfflineChange={() => {}}
                initialTurns={[assistantTurn({ status: "fallback", text: "Live request failed (boom). Canvas unchanged." })]}
                initialExtras={{
                    "t-assistant-1": {
                        model: "modal-chat",
                        inputTokens: 0,
                        outputTokens: 0,
                        costUsd: 0,
                        streaming: false,
                        stopped: false,
                        applied: [],
                        rejections: [],
                        pendingRuns: [],
                        chatError: "boom",
                    },
                }}
            />
        );
        expect(html).toContain("Canvas unchanged");
        expect(html).toContain("Retry");
        expect(html).toContain('aria-label="Retry chat request"');
        expect(html).not.toContain("gearflow-chat");
    });
});
