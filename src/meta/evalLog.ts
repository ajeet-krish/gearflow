// Eval log: ring buffer of the last 50 Meta API calls for the demo panel.
// Subscribe for live UI updates, export JSON for the submission record.

import type { EvalLogEntry } from "@/contracts/types";
import type { EvalHookPayload } from "./client";

export const EVAL_LOG_CAPACITY = 50;

let counter = 0;

function nextId(): string {
    counter += 1;
    return `eval-${Date.now().toString(36)}-${counter.toString(36)}`;
}

export class EvalLog {
    private entries: EvalLogEntry[] = [];
    private listeners = new Set<(entries: EvalLogEntry[]) => void>();

    async add(payload: EvalHookPayload): Promise<EvalLogEntry> {
        const entry: EvalLogEntry = {
            id: nextId(),
            at: new Date().toISOString(),
            feature: payload.feature,
            model: payload.model,
            latencyMs: payload.latencyMs,
            costUsd: payload.costUsd,
            costEstimated: payload.costEstimated,
            cached: payload.cached,
            ok: payload.ok,
            fallback: payload.fallback,
            hash: payload.hash,
        };
        this.entries.push(entry);
        if (this.entries.length > EVAL_LOG_CAPACITY) {
            this.entries.splice(0, this.entries.length - EVAL_LOG_CAPACITY);
        }
        this.emit();
        return entry;
    }

    list(): EvalLogEntry[] {
        return [...this.entries];
    }

    clear(): void {
        this.entries = [];
        this.emit();
    }

    totalCostUsd(): number {
        return this.entries.reduce((sum, e) => sum + e.costUsd, 0);
    }

    toJSON(): string {
        return JSON.stringify({ exportedAt: new Date().toISOString(), entries: this.entries }, null, 2);
    }

    subscribe(fn: (entries: EvalLogEntry[]) => void): () => void {
        this.listeners.add(fn);
        return () => {
            this.listeners.delete(fn);
        };
    }

    private emit(): void {
        const snapshot = this.list();
        for (const fn of this.listeners) {
            try {
                fn(snapshot);
            } catch {
                // Listener failures never corrupt the log.
            }
        }
    }
}

/** Shared process wide log wired to MetaClient onEval in the app shell. */
export const g_evalLog = new EvalLog();
