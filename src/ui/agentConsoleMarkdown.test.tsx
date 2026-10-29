// Phase T2 frontend: Claude layout plus react-markdown rendering. Static
// markup over initialTurns, zero live calls. Covers the user right and
// agent left alignment classes, GFM pipe tables rendering as real tables
// (never raw pipes), script text staying inert, and the distinct tutor
// badge plus numbers table plus field chip.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import AgentConsole, { ChatMarkdown, stripTutorPipeTable, tutorProseToGfm } from "./AgentConsole";
import type { ChatTurn } from "@/contracts/types";

function userTurn(over: Partial<ChatTurn> = {}): ChatTurn {
    return {
        id: "t-user-1",
        role: "user",
        text: "Explain this run",
        at: new Date().toISOString(),
        ...over,
    };
}

function agentTurn(over: Partial<ChatTurn> = {}): ChatTurn {
    return {
        id: "t-agent-1",
        role: "assistant",
        text: "Run looks healthy at alpha 6.",
        at: new Date().toISOString(),
        tool: "baseten",
        status: "live",
        ...over,
    };
}

function tutorTurn(over: Partial<ChatTurn> = {}): ChatTurn {
    return agentTurn({
        id: "t-tutor-1",
        text: "Local tutor note, local only. Attached flow at alpha 6.\n\nCaveat: pending, press Run for a clean solve.",
        status: "offline",
        tutor: {
            concept: "attached-lift",
            primary: "speed",
            secondary: "cp",
            rows: [
                { metric: "Cl", before: "0.600", after: "0.700", delta: "+0.100" },
                { metric: "CpMin", before: "-1.100", after: "-1.300", delta: "-0.200" },
            ],
            caseKey: "case-after",
        },
        ...over,
    });
}

describe("agent console T2 markdown layout", () => {
    it("aligns user turns right and agent turns left", () => {
        const html = renderToStaticMarkup(
            <AgentConsole
                offline
                onOfflineChange={() => {}}
                initialTurns={[userTurn(), agentTurn()]}
            />
        );
        expect(html).toContain("chatTurn user chatRight");
        expect(html).toContain("chatTurn assistant chatLeft");
    });

    it("renders user turns as plain text, never markdown", () => {
        const html = renderToStaticMarkup(
            <AgentConsole
                offline
                onOfflineChange={() => {}}
                initialTurns={[userTurn({ id: "t-user-md", text: "**bold** | pipes | here" })]}
            />
        );
        expect(html).not.toContain("<strong>");
        expect(html).not.toContain("<table");
        expect(html).toContain("**bold** | pipes | here");
    });

    it("renders agent GFM pipe tables as real tables, not raw pipes", () => {
        const text = "Before vs after\nMetric | Before | After | Delta\nCl | 0.600 | 0.700 | +0.100";
        const html = renderToStaticMarkup(<ChatMarkdown>{text}</ChatMarkdown>);
        expect(html).toContain("<table");
        expect(html).toContain("<th");
        expect(html).toContain("0.700");
        expect(html).not.toContain("Metric | Before | After | Delta");
    });

    it("renders agent bold, inline code, and lists as real elements", () => {
        const html = renderToStaticMarkup(
            <ChatMarkdown>{"**Stall** onset near `alpha 12`:\n\n- separation bubble\n- reattachment"}</ChatMarkdown>
        );
        expect(html).toContain("<strong>Stall</strong>");
        expect(html).toContain("<code>alpha 12</code>");
        expect(html).toContain("<ul>");
        expect(html).toContain("<li>separation bubble</li>");
    });

    it("keeps script and raw HTML text inert with no script element", () => {
        const html = renderToStaticMarkup(
            <ChatMarkdown>{'Harmless note <script>alert("xss")</script> plus <b>angle</b> brackets.'}</ChatMarkdown>
        );
        expect(html).not.toContain("<script");
        expect(html).toContain("alert");
    });

    it("collapses model images to alt text with zero network tags", () => {
        const html = renderToStaticMarkup(<ChatMarkdown>{"See ![wake sketch](https://example.com/wake.png) here."}</ChatMarkdown>);
        expect(html).not.toContain("<img");
        expect(html).toContain("wake sketch");
    });

    it("renders tutor turns distinct: badge, numbers table, field chip", () => {
        const html = renderToStaticMarkup(
            <AgentConsole
                offline
                onOfflineChange={() => {}}
                initialTurns={[tutorTurn()]}
            />
        );
        expect(html).toContain("chatTurn assistant chatLeft tutorTurn");
        expect(html).toContain("tutorBadge");
        expect(html).toContain(">Tutor</span>");
        expect(html).toContain("<table");
        expect(html).toContain("Quantity");
        expect(html).toContain("Change");
        expect(html).toContain("0.700");
        expect(html).toContain("Show cp");
        expect(html).toContain("tutorChip");
    });

    it("repairs the tutor prose table into GFM exactly once", () => {
        const raw = "Before vs after\nMetric | Before | After | Delta\nCl | 0.600 | 0.700 | +0.100";
        const fixed = tutorProseToGfm(raw);
        expect(fixed).toContain("| --- | --- | --- | ---");
        expect(tutorProseToGfm(fixed)).toBe(fixed);
        expect(tutorProseToGfm("plain words, no table")).toBe("plain words, no table");
    });

    it("strips the tutor pipe block from prose, keeping the surrounding copy", () => {
        const raw =
            "Local tutor note, local only. Attached flow at alpha 6.\n\nBefore vs after\nMetric | Before | After | Delta\nCl | 0.600 | 0.700 | +0.100\n\nTry next: raise alpha.";
        const stripped = stripTutorPipeTable(raw);
        expect(stripped).not.toContain("Metric | Before | After | Delta");
        expect(stripped).not.toContain("Cl | 0.600");
        expect(stripped).toContain("Local tutor note");
        expect(stripped).toContain("Try next: raise alpha.");
        expect(stripTutorPipeTable("plain words, no table")).toBe("plain words, no table");
    });

    it("renders a single table when the tutor payload and prose pipe block coexist", () => {
        const html = renderToStaticMarkup(
            <AgentConsole
                offline
                onOfflineChange={() => {}}
                initialTurns={[
                    tutorTurn({
                        text: "Local tutor note, local only. Attached flow at alpha 6.\n\nBefore vs after\nMetric | Before | After | Delta\nCl | 0.600 | 0.700 | +0.100\n\nCaveat: pending, press Run for a clean solve.",
                    }),
                ]}
            />
        );
        const tableCount = (html.match(/<table/g) ?? []).length;
        expect(tableCount).toBe(1);
        expect(html).not.toContain("Metric | Before | After | Delta");
        expect(html).toContain("Quantity");
        expect(html).toContain("Change");
        expect(html).toContain("0.700");
        expect(html).toContain("Local tutor note");
    });

    it("falls back to the prose GFM table when the tutor payload has no rows", () => {
        const html = renderToStaticMarkup(
            <AgentConsole
                offline
                onOfflineChange={() => {}}
                initialTurns={[
                    tutorTurn({
                        text: "Before vs after\nMetric | Before | After | Delta\nCl | 0.600 | 0.700 | +0.100",
                        tutor: {
                            concept: "attached-lift",
                            primary: "speed",
                            secondary: "speed",
                            rows: [],
                            caseKey: "case-after",
                        },
                    }),
                ]}
            />
        );
        const tableCount = (html.match(/<table/g) ?? []).length;
        expect(tableCount).toBe(1);
        expect(html).not.toContain("Quantity");
        expect(html).not.toContain("Metric | Before | After | Delta");
        expect(html).toContain("0.700");
    });
});
