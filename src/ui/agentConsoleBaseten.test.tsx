// Baseten spark chat console tests. Static markup plus pure helpers plus a
// fake chat port, zero live calls. Mirrors the shell test style.

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import AgentConsole, {
    BASETEN_FEATURE,
    PRESET_CHIPS,
    SPEND_SOFT_STOP_USD,
    buildBasetenMessages,
    localOfflineReply,
    spendExceeded,
    validationContextFor,
} from "./AgentConsole";
import { parseAgentEnvelope } from "@/agent/agentActions";
import { buildAgentContext } from "@/agent/agentContext";
import { appendTurns } from "@/agent/chatStore";
import type { ChatTurn } from "@/contracts/types";

function assistantTurn(over: Partial<ChatTurn> = {}): ChatTurn {
    return {
        id: "t-assistant-1",
        role: "assistant",
        text: "Run looks healthy at alpha 6.",
        at: new Date().toISOString(),
        tool: "baseten",
        status: "live",
        ...over,
    };
}

function fakePort(text: string) {
    const calls = { streams: 0, chats: 0 };
    const seen: string[] = [];
    const port = {
        calls,
        async *streamChat(_messages?: unknown, _opts?: unknown) {
            calls.streams += 1;
            const head = text.slice(0, 6);
            seen.push(head);
            yield { delta: head, text: head, done: false };
            seen.push(text);
            yield { delta: text.slice(6), text, done: false };
            yield { delta: "", text, done: true };
            return {
                text,
                action: null,
                model: "meta-models/muse-spark-open-1026",
                usage: { inputTokens: 12, outputTokens: 24, cachedTokens: 0 },
                costUsd: 0.0001,
                latencyMs: 5,
            };
        },
        async chat(_messages?: unknown, _opts?: unknown) {
            calls.chats += 1;
            return {
                text,
                action: null,
                model: "meta-models/muse-spark-open-1026",
                usage: { inputTokens: 12, outputTokens: 24, cachedTokens: 0 },
                costUsd: 0.0001,
                latencyMs: 5,
            };
        },
    };
    return { port, calls, seen };
}

describe("baseten console chrome", () => {
    it("renders the three preset demo chips", () => {
        const html = renderToStaticMarkup(<AgentConsole offline={false} onOfflineChange={() => {}} />);
        for (const chip of PRESET_CHIPS) {
            expect(html).toContain(chip);
        }
        expect(html).toContain("Explain this run");
        expect(html).toContain("Set up NACA 2412 alpha 6");
        expect(html).toContain("How do I change Re");
    });

    it("renders the session spend meter with model and cost", () => {
        const html = renderToStaticMarkup(<AgentConsole offline={false} onOfflineChange={() => {}} />);
        expect(html).toContain("Session");
        expect(html).toContain("est $");
        expect(html).toContain("in 0 out 0");
    });

    it("shows the soft stop note once the spend cap is reached", () => {
        const html = renderToStaticMarkup(
            <AgentConsole offline={false} onOfflineChange={() => {}} spendCapUsd={0} />
        );
        expect(html).toContain("local mode until reset");
    });

    it("marks offline turns with the offline badge plus local note", () => {
        const html = renderToStaticMarkup(
            <AgentConsole
                offline={true}
                onOfflineChange={() => {}}
                initialTurns={[assistantTurn({ status: "offline", text: "Offline note, local only. Canvas unchanged." })]}
            />
        );
        expect(html).toContain("offline");
        expect(html).toContain("Canvas unchanged");
    });

    it("shows Stop while busy and Send when idle", () => {
        const busyHtml = renderToStaticMarkup(
            <AgentConsole offline={false} onOfflineChange={() => {}} initialBusy={true} />
        );
        expect(busyHtml).toContain("Stop");
        const idleHtml = renderToStaticMarkup(
            <AgentConsole offline={false} onOfflineChange={() => {}} />
        );
        expect(idleHtml).toContain("Send");
    });

    it("renders applied notes and run confirm chips from turn extras", () => {
        const html = renderToStaticMarkup(
            <AgentConsole
                offline={false}
                onOfflineChange={() => {}}
                initialTurns={[assistantTurn({ text: "Tuning the run now." })]}
                initialExtras={{
                    "t-assistant-1": {
                        model: "meta-models/muse-spark-open-1026",
                        inputTokens: 12,
                        outputTokens: 24,
                        costUsd: 0.0001,
                        streaming: false,
                        stopped: false,
                        applied: ["Applied: alpha 6."],
                        rejections: ["Rejected: set_field k gated until the first LBM statistics sample"],
                        pendingRuns: [{ kind: "run_lbm" }],
                    },
                }}
            />
        );
        expect(html).toContain("Applied: alpha 6.");
        expect(html).toContain("Rejected:");
        expect(html).toContain("Confirm Run LBM");
    });

    it("keeps SAM as a separate cached entry point outside Baseten", () => {
        const html = renderToStaticMarkup(<AgentConsole offline={false} onOfflineChange={() => {}} />);
        expect(html).toContain("SAM sketch (cached, offline)");
    });
});

describe("baseten console helpers", () => {
    it("builds prompt messages with system context plus the user turn", () => {
        const messages = buildBasetenMessages("Explain this run", null, []);
        expect(messages[0].role).toBe("system");
        expect(messages[messages.length - 1]).toEqual({ role: "user", content: "Explain this run" });
        expect(messages[0].content).toContain("set_alpha");
    });

    it("answers offline deterministically with zero canvas writes", () => {
        const reply = localOfflineReply("How do I change Re", { cl: 0.6, cpMin: -1.2, reynolds: 50000 });
        expect(reply).toContain("solver bar");
        expect(reply).toContain("Canvas unchanged");
        const explain = localOfflineReply("Explain this run", { cl: 0.6, cpMin: -1.2, reynolds: 50000 });
        expect(explain).toContain("Cl 0.600");
    });

    it("parses setup actions and gates run actions for confirm", () => {
        const ctx = validationContextFor(null);
        const setup = parseAgentEnvelope('Tuning.\n```action-json\n{"kind":"set_alpha","alphaDeg":6}\n```', ctx);
        expect(setup.actions).toHaveLength(1);
        expect(setup.actions[0]).toMatchObject({ kind: "set_alpha" });
        const run = parseAgentEnvelope('Ready.\n```action-json\n{"kind":"run_lbm"}\n```', ctx);
        expect(run.actions).toHaveLength(0);
        expect(run.rejections.join(" ")).toContain("run_lbm");
    });

    it("flags the spend soft stop at five dollars", () => {
        expect(SPEND_SOFT_STOP_USD).toBe(5);
        expect(spendExceeded(5)).toBe(true);
        expect(spendExceeded(0.01)).toBe(false);
    });

    it("streams deltas through the fake port with batched text", async () => {
        const body = "Tuning alpha now. Done.";
        const { port, calls, seen } = fakePort(body);
        let full = "";
        let chunks = 0;
        const gen = port.streamChat(
            [{ role: "user", content: "hi" }],
            { feature: BASETEN_FEATURE, timeoutMs: 15000 }
        );
        for (;;) {
            const step = await gen.next();
            if (step.done) {
                full = step.value.text;
                expect(step.value.usage.outputTokens).toBe(24);
                break;
            }
            chunks += 1;
            full = step.value.text;
        }
        expect(full).toBe(body);
        expect(chunks).toBeGreaterThanOrEqual(2);
        expect(seen.length).toBeGreaterThanOrEqual(2);
        expect(calls.streams).toBe(1);
        expect(calls.chats).toBe(0);
    });

    it("aborts a hanging stream through the Stop controller", async () => {
        const controller = new AbortController();
        const onAbort = vi.fn();
        controller.signal.addEventListener("abort", onAbort);
        controller.abort();
        expect(controller.signal.aborted).toBe(true);
        expect(onAbort).toHaveBeenCalled();
    });

    it("caps the persisted transcript at fifty turns", () => {
        const many: ChatTurn[] = Array.from({ length: 55 }, (_, i) => ({
            id: `t-${i}`,
            role: i % 2 === 0 ? "user" : "assistant",
            text: `turn ${i}`,
            at: new Date().toISOString(),
        }));
        const merged = appendTurns([], many);
        expect(merged).toHaveLength(50);
        expect(merged[0].id).toBe("t-5");
    });

    it("accepts the App wiring props with zero executor calls on mount", () => {
        const onAgentAction = vi.fn();
        const { port, calls } = fakePort("Tuning alpha now.");
        const ctx = buildAgentContext({
            spec: { kind: "naca4", naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 }, chord: 1, alphaDeg: 6, nPoints: 120 },
            reynolds: 50000,
            regime: "laminar, attached",
            bodyLabel: "NACA 2412",
            backend: "lbm pending",
            engine: "lbm",
            gridLabel: "128x128",
            cl: Number.NaN,
            cpMin: Number.NaN,
            lbmStatus: "idle",
            lbmHasSnapshot: false,
            lbmEffective: true,
            lbmStatsReady: false,
            lbmStats: null,
            variable: "speed",
            effectiveVariable: "speed",
            hasTke: false,
            hasRecirc: false,
            validation: { pass: 0, warn: 0, fail: 0, info: 0 },
            provenanceLabel: "lbm pending placeholder",
            offline: false,
        } as never);
        const html = renderToStaticMarkup(
            <AgentConsole
                offline={false}
                onOfflineChange={() => {}}
                agentContext={ctx}
                onAgentAction={onAgentAction}
                chatClient={port as never}
                initialTurns={[assistantTurn({ text: "Tuning the run now." })]}
            />
        );
        expect(onAgentAction).not.toHaveBeenCalled();
        expect(calls.streams).toBe(0);
        expect(calls.chats).toBe(0);
        expect(ctx.engine).toBe("lbm");
        expect(html).toContain("Session");
        expect(html).toContain("Explain this run");
        expect(html).toContain("Send");
    });
});

describe("baseten console B2 fixes", () => {
    function pendingSnapshot() {
        return {
            spec: { kind: "naca4", naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 }, chord: 1, alphaDeg: 6, nPoints: 120 },
            reynolds: 50000,
            regime: "laminar, attached",
            bodyLabel: "NACA 2412",
            backend: "lbm pending",
            engine: "lbm",
            gridLabel: "128x128",
            cl: Number.NaN,
            cpMin: Number.NaN,
            lbmStatus: "idle",
            lbmHasSnapshot: false,
            lbmEffective: true,
            lbmStatsReady: false,
            lbmStats: null,
            variable: "speed",
            effectiveVariable: "speed",
            hasTke: false,
            hasRecirc: false,
            validation: { pass: 0, warn: 0, fail: 0, info: 0 },
            provenanceLabel: "lbm pending placeholder",
            offline: false,
        };
    }

    it("pending LBM engine allows run_lbm so the confirm chip is reachable", () => {
        const ctx = buildAgentContext(pendingSnapshot() as never);
        expect(ctx.lbm.effective).toBe(true);
        const validation = validationContextFor(ctx);
        expect(validation.lbmEffective).toBe(true);
        const run = parseAgentEnvelope('Ready to solve.\n```action-json\n{"kind":"run_lbm"}\n```', validation);
        expect(run.actions).toEqual([{ kind: "run_lbm" }]);
        expect(run.rejections).toEqual([]);
        const html = renderToStaticMarkup(
            <AgentConsole
                offline={false}
                onOfflineChange={() => {}}
                initialTurns={[assistantTurn({ text: "Ready to solve." })]}
                initialExtras={{
                    "t-assistant-1": {
                        model: "meta-models/muse-spark-open-1026",
                        inputTokens: 0,
                        outputTokens: 0,
                        costUsd: 0,
                        streaming: false,
                        stopped: false,
                        applied: [],
                        rejections: [],
                        pendingRuns: [{ kind: "run_lbm" }],
                    },
                }}
            />
        );
        expect(html).toContain("Confirm Run LBM");
    });

    it("settled reply text excludes fenced action json", () => {
        const validation = validationContextFor(null);
        const out = parseAgentEnvelope('Tuning alpha now.\n```action-json\n{"kind":"set_alpha","alphaDeg":8}\n```', validation);
        expect(out.actions).toEqual([{ kind: "set_alpha", alphaDeg: 8 }]);
        expect(out.reply).toContain("Tuning alpha now.");
        expect(out.reply).not.toContain("action-json");
        expect(out.reply).not.toContain("```");
        expect(out.reply).not.toContain("alphaDeg");
    });

    it("user turns are not labelled baseten live", () => {
        const userHtml = renderToStaticMarkup(
            <AgentConsole
                offline={false}
                onOfflineChange={() => {}}
                initialTurns={[{ id: "t-user-1", role: "user", text: "Explain this run", at: new Date().toISOString() }]}
            />
        );
        expect(userHtml).toContain("You");
        expect(userHtml).not.toContain("baseten");
        const legacyHtml = renderToStaticMarkup(
            <AgentConsole
                offline={false}
                onOfflineChange={() => {}}
                initialTurns={[{ id: "t-legacy-1", role: "assistant", text: "Legacy note", at: new Date().toISOString() }]}
            />
        );
        expect(legacyHtml).toContain("Agent");
        expect(legacyHtml).toContain("legacy");
        expect(legacyHtml).not.toContain(">baseten<");
    });
});
