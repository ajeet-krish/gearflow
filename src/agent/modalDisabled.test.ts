// Modal kill switch tests. Gate predicate plus proxy 503 plus the client
// offline mapping. Proxy assertions run the real modalProxy middleware
// with a fake upstream, zero live calls.

import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { modalProxy } from "../../vite.config";
import {
    MODAL_DISABLED_MESSAGE,
    MODAL_PATH,
    isModalDisabled,
} from "./modalGate";
import { toHttpError } from "./modalClient";
import type { Connect } from "vite";

const SAVED = process.env.MODAL_DISABLED;

afterEach(() => {
    if (SAVED === undefined) {
        delete process.env.MODAL_DISABLED;
    } else {
        process.env.MODAL_DISABLED = SAVED;
    }
});

function getHandler(counter: { calls: number }): Connect.NextHandleFunction {
    const plugin = modalProxy({
        fetchFn: (async () => {
            counter.calls += 1;
            return new Response("{}", { status: 200 });
        }) as unknown as typeof fetch,
        getAuthHeaders: () => ({ authorization: "Bearer test-token" }),
        upstreamUrl: "https://example-workspace.modal.run/v1/chat/completions",
    });
    const seen: Connect.NextHandleFunction[] = [];
    plugin.configureServer({ middlewares: { use: (h: Connect.NextHandleFunction) => seen.push(h) } } as never);
    if (seen.length !== 1) throw new Error("expected one modal middleware");
    return seen[0];
}

function runProxy(handler: Connect.NextHandleFunction): Promise<{ statusCode: number; text: string }> {
    return new Promise((resolve) => {
        const req = new EventEmitter() as EventEmitter & {
            url: string;
            method: string;
            headers: Record<string, string>;
            socket: { remoteAddress: string };
            destroy: () => void;
        };
        req.url = MODAL_PATH;
        req.method = "POST";
        req.headers = { host: "localhost:5173" };
        req.socket = { remoteAddress: "127.0.0.1" };
        req.destroy = (): void => undefined;
        const res = {
            statusCode: 200,
            setHeader: (_name: string, _value: string): void => undefined,
            end: (data?: unknown): void => {
                resolve({
                    statusCode: res.statusCode,
                    text: typeof data === "string" ? data : Buffer.from(data as Uint8Array).toString("utf8"),
                });
            },
        };
        handler(req as never, res as never, () => resolve({ statusCode: 404, text: "" }));
        setTimeout(() => req.emit("data", Buffer.from("{}", "utf8")), 0);
        setTimeout(() => req.emit("end"), 5);
    });
}

describe("isModalDisabled", () => {
    it("disables only on the exact string true", () => {
        expect(isModalDisabled("true")).toBe(true);
        expect(isModalDisabled("false")).toBe(false);
        expect(isModalDisabled("1")).toBe(false);
        expect(isModalDisabled("TRUE")).toBe(false);
        expect(isModalDisabled(undefined)).toBe(false);
        expect(isModalDisabled(null)).toBe(false);
        expect(isModalDisabled(true)).toBe(false);
        expect(isModalDisabled("")).toBe(false);
    });

    it("pins the disabled message", () => {
        expect(MODAL_DISABLED_MESSAGE).toContain("disabled");
    });
});

describe("modal kill switch wiring", () => {
    it("answers 503 disabled when MODAL_DISABLED is true", async () => {
        process.env.MODAL_DISABLED = "true";
        const counter = { calls: 0 };
        const out = await runProxy(getHandler(counter));
        expect(out.statusCode).toBe(503);
        expect(out.text).toContain("disabled");
        expect(counter.calls).toBe(0);
    });

    it("stays live when MODAL_DISABLED is unset", async () => {
        delete process.env.MODAL_DISABLED;
        const counter = { calls: 0 };
        const out = await runProxy(getHandler(counter));
        expect(out.statusCode).not.toBe(503);
        expect(counter.calls).toBe(1);
    });

    it("maps the kill switch 503 to offline on the client", () => {
        const err = toHttpError(503);
        expect(err.code).toBe("offline");
        expect(err.retryable).toBe(true);
    });
});
