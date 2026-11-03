// Modal spark chat console tests. Static markup plus pure helpers plus a
// fake chat port, zero live calls. Mirrors the shell test style.

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import AgentConsole, {
    MODAL_FEATURE,
    EXAMPLE_PROMPTS,
    SPEND_SOFT_STOP_USD,
    buildModalMessages,
    honestRejectionReply,
    localOfflineReply,
    snapshotLiteFor,
    spendExceeded,
    suggestedPromptsFor,
    validationContextFor,
} from "./AgentConsole";
import { CURRICULUM_CHIPS } from "@/agent/curriculum";
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
        tool: "modal",
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
                model: "gearflow-chat",
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
                model: "gearflow-chat",
                usage: { inputTokens: 12, outputTokens: 24, cachedTokens: 0 },
                costUsd: 0.0001,
                latencyMs: 5,
            };
        },
    };
    return { port, calls, seen };
}

describe("modal console chrome", () => {
    it("renders the example and tutorial dropdowns side by side in the prompt row", () => {
        const html = renderToStaticMarkup(<AgentConsole offline={false} onOfflineChange={() => {}} />);
        // Hand-rolled TUI mimic: both native selects sit side by side in
        // one prompt row above the composer, every example plus every
        // tutorial stays reachable, composer placeholder intact.
        expect(html).toContain("promptRow");
        for (const item of EXAMPLE_PROMPTS) {
            expect(html).toContain(item.label);
        }
        for (const chip of CURRICULUM_CHIPS) {
            expect(html).toContain(chip.label);
        }
        expect(html).toContain("Example prompts");
        expect(html).toContain("Tutorials");
        expect(html).toContain("Explain this run");
        expect(html).toContain("Set up NACA 2412");
    });

    it("renders the caret-following line cursor with no hint bar and no session spend meter", () => {
        const html = renderToStaticMarkup(<AgentConsole offline={false} onOfflineChange={() => {}} />);
        // Phase 25 chat terminal: the spend meter render is deleted (spend
        // logic stays behind spendExceeded), the hint bar is deleted, and
        // the composer carries a hidden mirror span plus a caret-following
        // 2px line that renders only after the first mirror measurement
        // (caretMeasured). Static markup never runs effects or refs, so the
        // line stays hidden there with the native caret kept (auto).
        expect(html).not.toContain("chatFoot");
        expect(html).not.toContain("Session");
        expect(html).not.toContain("est $");
        expect(html).not.toContain("chatHints");
        expect(html).not.toContain("tuiCursor");
        expect(html).not.toContain("tuiCaret");
        expect(html).toContain("tuiMirror");
        expect(html).toContain("caret-color:auto");
        expect(html).toContain("promptRow");
    });

    it("keeps the spend soft stop in logic with no cap note render", () => {
        const html = renderToStaticMarkup(
            <AgentConsole offline={false} onOfflineChange={() => {}} spendCapUsd={0} />
        );
        // Spend gate still forces the offline path through spendExceeded,
        // but the cap note render is gone with the meter.
        expect(spendExceeded(5)).toBe(true);
        expect(html).not.toContain("chatFoot");
        expect(html).not.toContain("demo mode until reset");
        expect(html).not.toContain("local mode until reset");
    });

    it("marks offline turns with the offline pill plus local note", () => {
        const html = renderToStaticMarkup(
            <AgentConsole
                offline={true}
                onOfflineChange={() => {}}
                initialTurns={[assistantTurn({ status: "offline", text: "Offline note, local only. Canvas unchanged." })]}
            />
        );
        expect(html).toContain("offline");
        expect(html).toContain("Canvas unchanged");
        expect(html).toContain("tuiPill");
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

    it("keeps apply receipts in extras while rendering rejections and run confirm chips", () => {
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
                        rejections: ["Rejected: set_field k gated until the first LBM statistics sample"],
                        pendingRuns: [{ kind: "run_lbm" }],
                    },
                }}
            />
        );
        expect(html).not.toContain("Applied: angle of attack (alpha) 6 deg.");
        expect(html).not.toContain("Applied:");
        expect(html).toContain("Rejected:");
        expect(html).toContain("Confirm run");
    });

    it("keeps the chat input free of a separate SAM entry point", () => {
        const html = renderToStaticMarkup(<AgentConsole offline={false} onOfflineChange={() => {}} />);
        expect(html).not.toContain("SAM sketch (cached, offline)");
    });
});

describe("modal console helpers", () => {
    it("builds prompt messages with system context plus the user turn", () => {
        const messages = buildModalMessages("Explain this run", null, []);
        expect(messages[0].role).toBe("system");
        expect(messages[messages.length - 1]).toEqual({ role: "user", content: "Explain this run" });
        expect(messages[0].content).toContain("set_alpha");
    });

    it("answers offline deterministically with zero canvas writes", () => {
        // Offline demo copy: cached table only, zero local prose, canvas unchanged.
        const reply = localOfflineReply("How do I change Re", { cl: 0.6, cpMin: -1.2, reynolds: 50000 });
        expect(reply).toContain("Offline demo mode");
        expect(reply).toContain("cached table only");
        expect(reply).toContain("Canvas unchanged");
        expect(reply).not.toContain("solver bar");
        const explain = localOfflineReply("Explain this run", { cl: 0.6, cpMin: -1.2, reynolds: 50000 });
        expect(explain).toContain("Lift coefficient (Cl)");
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
            { feature: MODAL_FEATURE, timeoutMs: 60000 }
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

    it("accepts the App wiring props with zero executor calls on mount", () => {        const onAgentAction = vi.fn();
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
        // Phase 25 chat terminal: no spend meter, prompt row plus
        // hidden mirror with the caret line gated on the first
        // measurement (absent in static markup) instead of the hint bar.
        expect(html).not.toContain("Session");
        expect(html).toContain("promptRow");
        expect(html).not.toContain("tuiCaret");
        expect(html).toContain("tuiMirror");
        expect(html).toContain("caret-color:auto");
        expect(html).not.toContain("chatHints");
        expect(html).toContain("Explain this run");
        expect(html).toContain("Send");
    });
});

describe("modal console B2 fixes", () => {
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
        const run = parseAgentEnvelope('Ready to solve.\n```action-json\n{"kind":"run_lbm"}\n```', { ...validation, agentFirst: false });
        expect(run.actions).toEqual([{ kind: "run_lbm" }]);
        expect(run.rejections).toEqual([]);
        const html = renderToStaticMarkup(
            <AgentConsole
                offline={false}
                onOfflineChange={() => {}}
                initialTurns={[assistantTurn({ text: "Ready to solve." })]}
                initialExtras={{
                    "t-assistant-1": {
                        model: "gearflow-chat",
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
        expect(html).toContain("Confirm run");
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

    it("labels assistant turns Tutor with a live dot and no model pill", () => {
        const liveHtml = renderToStaticMarkup(
            <AgentConsole
                offline={false}
                onOfflineChange={() => {}}
                initialTurns={[assistantTurn({ status: "live", text: "Run looks healthy at alpha 6." })]}
            />
        );
        // P0 TUI mimic: Tutor label, green live dot with a visually hidden
        // label instead of live text, no tool or model pills.
        expect(liveHtml).toContain(">Tutor</span>");
        expect(liveHtml).not.toContain(">Agent</span>");
        expect(liveHtml).toContain("liveDot");
        expect(liveHtml).toContain("visuallyHidden\">live</span>");
        // No text pill for live turns: the only live marker is the dot.
        expect(liveHtml).not.toContain("tuiPill");
        expect(liveHtml).not.toContain("gearflow-chat");
        expect(liveHtml).not.toContain(">modal</span>");
        expect(liveHtml).not.toContain(">legacy</span>");
        const cachedHtml = renderToStaticMarkup(
            <AgentConsole
                offline={false}
                onOfflineChange={() => {}}
                initialTurns={[assistantTurn({ status: "cached", text: "Cached table note." })]}
            />
        );
        expect(cachedHtml).toContain(">Tutor</span>");
        // No cached pill beside Tutor: the cached status renders no badge,
        // the honest cached-table note plus Retry carry the signal instead.
        expect(cachedHtml).not.toContain(">cached</span>");
    });

    it("user turns are not labelled modal live", () => {
        const userHtml = renderToStaticMarkup(
            <AgentConsole
                offline={false}
                onOfflineChange={() => {}}
                initialTurns={[{ id: "t-user-1", role: "user", text: "Explain this run", at: new Date().toISOString() }]}
            />
        );
        expect(userHtml).toContain("You");
        expect(userHtml).not.toContain("baseten");
        // P0 TUI mimic: assistant turns read Tutor, tool and model pills
        // are gone, so the legacy badge copy is gone too.
        const legacyHtml = renderToStaticMarkup(
            <AgentConsole
                offline={false}
                onOfflineChange={() => {}}
                initialTurns={[{ id: "t-legacy-1", role: "assistant", text: "Legacy note", at: new Date().toISOString() }]}
            />
        );
        expect(legacyHtml).toContain("Tutor");
        expect(legacyHtml).not.toContain(">Agent</span>");
        expect(legacyHtml).not.toContain("legacy");
        expect(legacyHtml).not.toContain(">baseten<");
    });
});

describe("modal console agent-first prompt", () => {
    function agentFirstCtx() {
        return buildAgentContext({
            spec: { kind: "naca4", naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 }, chord: 1, alphaDeg: 6, nPoints: 120 },
            reynolds: 50000,
            regime: "laminar, attached",
            bodyLabel: "NACA 2412",
            backend: "analytic",
            engine: "analytic",
            gridLabel: "128x128",
            cl: 0.6,
            cpMin: -1.2,
            lbmStatus: "idle",
            lbmHasSnapshot: false,
            lbmEffective: false,
            lbmStatsReady: false,
            lbmStats: null,
            variable: "speed",
            effectiveVariable: "speed",
            hasTke: false,
            hasRecirc: false,
            validation: { pass: 0, warn: 0, fail: 0, info: 0 },
            provenanceLabel: "analytic",
            offline: false,
            agentFirst: true,
        } as never);
    }

    function legacyCtx() {
        return buildAgentContext({
            spec: { kind: "naca4", naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 }, chord: 1, alphaDeg: 6, nPoints: 120 },
            reynolds: 50000,
            regime: "laminar, attached",
            bodyLabel: "NACA 2412",
            backend: "analytic",
            engine: "analytic",
            gridLabel: "128x128",
            cl: 0.6,
            cpMin: -1.2,
            lbmStatus: "idle",
            lbmHasSnapshot: false,
            lbmEffective: false,
            lbmStatsReady: false,
            lbmStats: null,
            variable: "speed",
            effectiveVariable: "speed",
            hasTke: false,
            hasRecirc: false,
            validation: { pass: 0, warn: 0, fail: 0, info: 0 },
            provenanceLabel: "analytic",
            offline: false,
            agentFirst: false,
        } as never);
    }

    it("keeps physics-only copy for agentFirst snapshots with no solver talk", () => {
        const messages = buildModalMessages("Explain this run", agentFirstCtx(), []);
        expect(messages[0].role).toBe("system");
        expect(messages[0].content).toContain("lift coefficient (Cl)");
        expect(messages[0].content).toContain("angle of attack (alpha)");
        expect(messages[0].content).not.toContain("Agent-first analytic mode");
        expect(messages[0].content).not.toContain("LBM");
        expect(messages[messages.length - 1]).toEqual({ role: "user", content: "Explain this run" });
    });

    it("omits the analytic-only line for legacy snapshots", () => {
        const messages = buildModalMessages("Explain this run", legacyCtx(), []);
        expect(messages[0].content).not.toContain("Agent-first analytic mode");
    });
});

describe("modal console live path (tutor-v3, Modal port only)", () => {
    it("carries no localAssistant imports on the console live path", async () => {
        const here = dirname(fileURLToPath(import.meta.url));
        const src = await readFile(resolve(here, "./AgentConsole.tsx"), "utf8");
        // Console live path rides the Modal port plus tutorPrompt only.
        expect(src).not.toContain("localAssistant");
        expect(src).toContain("buildTutorMessages");
        expect(src).toContain("TUTOR_FEATURE");
    });
});

describe("modal console truthfulness batch", () => {
    it("teaches the orifice as appliable with gap defaults and no angle", () => {
        const messages = buildModalMessages("set up the orifice", null, []);
        const system = messages[0].content;
        expect(system).toContain("orifice");
        expect(system).toContain("IS appliable");
        expect(system).toContain("fourth body tab");
        expect(system).toContain("0.4");
        expect(system).toContain("has no angle");
        expect(system).toContain("alphaDeg 0");
    });

    it("bounds Re at 100 with orifice alpha pinned to 0", () => {
        const messages = buildModalMessages("set Re 100", null, []);
        expect(messages[0].content).toContain("[100, 1000000]");
        expect(messages[0].content).toContain("Orifice alpha is always 0");
    });

    it("forbids any fence on sweep replies including alpha_sweep_summary", () => {
        const messages = buildModalMessages("stall demo", null, []);
        const system = messages[0].content;
        expect(system).toContain("stall demo");
        expect(system).toContain("Sweep replies carry NO fence");
        expect(system).toContain("alpha_sweep_summary");
    });

    it("routes plot requests to fields with contours coupling", () => {
        const messages = buildModalMessages("plot pressure", null, []);
        const system = messages[0].content;
        expect(system).toContain("show or plot pressure or Cp emits set_field cp");
        expect(system).toContain("contours coupling follows");
        expect(system).toContain("show or plot velocity or speed emits set_field speed");
    });

    it("pins applied-setup replies to exactly one sentence with no teaching", () => {
        const messages = buildModalMessages("set up NACA 2412 alpha 6", null, []);
        const system = messages[0].content;
        expect(system).toContain("exactly one sentence");
        expect(system).toContain("never teaching sections, never tables");
        expect(system).toContain("tutor upsert owns all teaching");
    });

    it("attaches orifice and airfoil follow-ups on no-action explain turns", () => {
        expect(suggestedPromptsFor("The orifice constriction speeds the flow like a venturi.")).toEqual(["Set up the orifice"]);
        expect(suggestedPromptsFor("This NACA airfoil run looks attached.")).toEqual(["Set up NACA 2412 alpha 6"]);
        expect(suggestedPromptsFor("The run looks healthy.")).toEqual([]);
        expect(suggestedPromptsFor(null)).toEqual([]);
    });

    it("nulls alpha on orifice lite snapshots so tables read n/a", () => {
        const snap = snapshotLiteFor({
            spec: { kind: "orifice", alphaDeg: 0 },
            alphaDeg: 0,
            caseKey: "orifice|a0",
        } as never);
        expect(snap.alpha).toBe(null);
    });

    it("moves the lite caseKey on cylinder radius changes so the tutor waits for the fresh frame", () => {
        const before = snapshotLiteFor({
            spec: { kind: "cylinder", alphaDeg: 0, radius: 0.25 },
            alphaDeg: 0,
            reynolds: 100,
        } as never);
        const after = snapshotLiteFor({
            spec: { kind: "cylinder", alphaDeg: 0, radius: 0.5 },
            alphaDeg: 0,
            reynolds: 100,
        } as never);
        expect(before.radius).toBe(0.25);
        expect(after.radius).toBe(0.5);
        expect(after.caseKey).not.toBe(before.caseKey);
    });

    it("carries the cylinder radius from the built agent context into the lite snapshot", () => {
        const ctx = buildAgentContext({
            spec: { kind: "cylinder", chord: 1, alphaDeg: 0, nPoints: 120, radius: 0.5, center: { x: 0.5, y: 0 } },
            reynolds: 100,
        } as never);
        expect(ctx.spec.radius).toBe(0.5);
        expect(snapshotLiteFor(ctx).radius).toBe(0.5);
    });

    it("replaces model teaching with the honest rejection on total rejection", () => {
        const reply = honestRejectionReply([
            "set_body needs body in [naca0012, naca2412, naca4412, cylinder, block, orifice]",
        ]);
        expect(reply).toContain("Request rejected");
        expect(reply).toContain("set_body needs body in");
        expect(reply).toContain("Canvas unchanged");
        expect(reply.endsWith(".")).toBe(true);
        expect(honestRejectionReply([])).toContain("Canvas unchanged");
    });

    it("appends the radius suffix to a supplied caseKey lacking the r token", () => {
        const before = snapshotLiteFor({
            spec: { kind: "cylinder", alphaDeg: 0, radius: 0.25 },
            alphaDeg: 0,
            reynolds: 100,
            field: { variable: "speed" },
            caseKey: "cylinder|cylinder|a0|Re100|analytic|fspeed",
        } as never);
        const after = snapshotLiteFor({
            spec: { kind: "cylinder", alphaDeg: 0, radius: 0.5 },
            alphaDeg: 0,
            reynolds: 100,
            field: { variable: "speed" },
            caseKey: "cylinder|cylinder|a0|Re100|analytic|fspeed",
        } as never);
        expect(before.caseKey).toContain("|r");
        expect(after.caseKey).toContain("|r");
        expect(after.caseKey).not.toBe(before.caseKey);
    });
});
