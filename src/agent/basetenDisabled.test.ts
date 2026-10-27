// Baseten kill switch tests. Gate predicate plus proxy 503 plus the client
// offline mapping. Proxy assertions run the real basetenProxy middleware
// with a fake upstream, zero live calls.

import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { basetenProxy } from "../../vite.config";
import {
    BASETEN_DISABLED_MESSAGE,
    BASETEN_PATH,
    isBasetenDisabled,
} from "./basetenGate";
import { toHttpError } from "./basetenClient";
import type { Connect } from "vite";

const SAVED = process.env.BASETEN_DISABLED;

afterEach(() => {
    if (SAVED === undefined) {
        delete process.env.BASETEN_DISABLED;
    } else {
        process.env.BASETEN_DISABLED = SAVED;
    }
});

function getHandler(counter: { calls: number }): Connect.NextHandleFunction {
    const plugin = basetenProxy({
        fetchFn: (async () => {
            counter.calls += 1;
            return new Response("{}", { status: 200 });
        }) as unknown as typeof fetch,
        getKey: () => "test-key",
    });
    const seen: Connect.NextHandleFunction[] = [];
    plugin.configureServer({ middlewares: { use: (h: Connect.NextHandleFunction) => seen.push(h) } } as never);
    if (seen.length !== 1) throw new Error("expected one baseten middleware");
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
        req.url = BASETEN_PATH;
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

describe("isBasetenDisabled", () => {
    it("disables only on the exact string true", () => {
        expect(isBasetenDisabled("true")).toBe(true);
        expect(isBasetenDisabled("false")).toBe(false);
        expect(isBasetenDisabled("1")).toBe(false);
        expect(isBasetenDisabled("TRUE")).toBe(false);
        expect(isBasetenDisabled(undefined)).toBe(false);
        expect(isBasetenDisabled(null)).toBe(false);
        expect(isBasetenDisabled(true)).toBe(false);
        expect(isBasetenDisabled("")).toBe(false);
    });

    it("pins the disabled message", () => {
        expect(BASETEN_DISABLED_MESSAGE).toContain("disabled");
    });
});

describe("baseten kill switch wiring", () => {
    it("answers 503 disabled when BASETEN_DISABLED is true", async () => {
        process.env.BASETEN_DISABLED = "true";
        const counter = { calls: 0 };
        const out = await runProxy(getHandler(counter));
        expect(out.statusCode).toBe(503);
        expect(out.text).toContain("disabled");
        expect(counter.calls).toBe(0);
    });

    it("stays live when BASETEN_DISABLED is unset", async () => {
        delete process.env.BASETEN_DISABLED;
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
