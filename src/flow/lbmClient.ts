// Small state machine around the LBM worker. No React dependency so it is
// unit testable with a fake worker port. Generation counter drops late
// messages from a cancelled or reset run. A progress watchdog moves a
// stalled run to error instead of hanging the UI. A ready watchdog moves
// an init that never posts ready to error as well.

import { isLbmWorkerMessage, MAX_BATCH_STEPS, MAX_TARGET_STEPS, type LbmMainMessage, type LbmSnapshotMessage } from "./lbmProtocol";
import type { Domain, LbmStats } from "@/contracts/types";

export type LbmClientState = "idle" | "running" | "done" | "cancelled" | "error" | "disposed";

export interface LbmInitConfig {
    nx: number;
    ny: number;
    domain: Domain;
    geomJson: string;
    re: number;
    uLattice: number;
    lesEnabled: boolean;
    targetSteps: number;
    batchSteps: number;
    statsStartStep?: number;
}

export interface LbmProgress {
    step: number;
    targetSteps: number;
    cd: number;
    cl: number;
}

export interface LbmSnapshot {
    step: number;
    cd: number;
    cl: number;
    nx: number;
    ny: number;
    domain: Domain;
    u: Float32Array;
    v: Float32Array;
    p: Float32Array;
    omega: Float32Array;
    obstacle: Float32Array;
    uMean?: Float32Array;
    vMean?: Float32Array;
    k?: Float32Array;
    recirc?: Float32Array;
    stats?: LbmStats;
}

export interface LbmWorkerPort {
    postMessage(msg: LbmMainMessage, transfer?: Transferable[]): void;
    onmessage: ((ev: { data: unknown }) => void) | null;
    onerror?: ((ev: unknown) => void) | null;
    terminate?: () => void;
}

export interface LbmClientCallbacks {
    onStatus?: (state: LbmClientState) => void;
    onProgress?: (progress: LbmProgress) => void;
    onSnapshot?: (snapshot: LbmSnapshot) => void;
    onError?: (message: string) => void;
}

function toSnapshot(msg: LbmSnapshotMessage): LbmSnapshot {
    const out: LbmSnapshot = {
        step: msg.step,
        cd: msg.cd,
        cl: msg.cl,
        nx: msg.nx,
        ny: msg.ny,
        domain: { ...msg.domain },
        u: msg.u,
        v: msg.v,
        p: msg.p,
        omega: msg.omega,
        obstacle: msg.obstacle,
    };
    if (msg.uMean !== undefined) out.uMean = msg.uMean;
    if (msg.vMean !== undefined) out.vMean = msg.vMean;
    if (msg.k !== undefined) out.k = msg.k;
    if (msg.recirc !== undefined) out.recirc = msg.recirc;
    if (msg.stats !== undefined) out.stats = msg.stats;
    return out;
}

function timeoutLabel(timeoutMs: number): string {
    const secs = timeoutMs / 1000;
    if (Number.isInteger(secs)) return `${secs} seconds`;
    return `${secs.toFixed(1)} seconds`;
}

export class LbmClient {
    private worker: LbmWorkerPort;
    private timeoutMs: number;
    private state: LbmClientState = "idle";
    private gen = 0;
    private snapshotPending = false;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
    private lastInit: LbmInitConfig | null = null;

    onStatus: ((state: LbmClientState) => void) | null = null;
    onProgress: ((progress: LbmProgress) => void) | null = null;
    onSnapshot: ((snapshot: LbmSnapshot) => void) | null = null;
    onError: ((message: string) => void) | null = null;

    constructor(worker: LbmWorkerPort, opts?: { timeoutMs?: number; clock?: () => number; callbacks?: LbmClientCallbacks }) {
        this.worker = worker;
        this.timeoutMs = opts?.timeoutMs ?? 10000;
        if (opts?.callbacks?.onStatus) this.onStatus = opts.callbacks.onStatus;
        if (opts?.callbacks?.onProgress) this.onProgress = opts.callbacks.onProgress;
        if (opts?.callbacks?.onSnapshot) this.onSnapshot = opts.callbacks.onSnapshot;
        if (opts?.callbacks?.onError) this.onError = opts.callbacks.onError;
        this.worker.onmessage = (ev) => this.handleMessage(ev.data);
        try {
            this.worker.onerror = () => this.handlePortError();
        } catch {
            // Ports without an error slot simply skip wiring.
        }
    }

    status(): LbmClientState {
        return this.state;
    }

    generation(): number {
        return this.gen;
    }

    hasSnapshotInFlight(): boolean {
        return this.snapshotPending;
    }

    private setState(next: LbmClientState): void {
        this.state = next;
        try {
            this.onStatus?.(next);
        } catch {
            // Callback faults must never break the state machine.
        }
    }

    private fail(message: string): void {
        this.clearTimer();
        this.clearSnapshotPending();
        this.setState("error");
        try {
            this.onError?.(message);
        } catch {
            // Callback faults must never break the state machine.
        }
    }

    private handlePortError(): void {
        if (this.state === "disposed") return;
        this.fail("LBM worker error event, analytic fallback serving frames.");
    }

    private clearTimer(): void {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    private clearSnapshotTimer(): void {
        if (this.snapshotTimer !== null) {
            clearTimeout(this.snapshotTimer);
            this.snapshotTimer = null;
        }
    }

    /** Clear the pending flag plus its timer when any snapshot lands. */
    private clearSnapshotPending(): void {
        this.snapshotPending = false;
        this.clearSnapshotTimer();
    }

    /**
     * One choke point for every worker post. A synchronous port throw
     * moves to the existing error path (or is swallowed when already
     * disposed) instead of escaping to the caller.
     */
    private safePost(msg: LbmMainMessage, transfer?: Transferable[]): boolean {
        try {
            this.worker.postMessage(msg, transfer);
            return true;
        } catch {
            if (this.state === "disposed") return false;
            this.fail("LBM worker post failed, analytic fallback serving frames.");
            return false;
        }
    }

    private armWatchdog(): void {
        this.clearTimer();
        const label = timeoutLabel(this.timeoutMs);
        this.timer = setTimeout(() => {
            if (this.state !== "running") return;
            this.fail(`LBM worker stalled, no progress for ${label}, analytic fallback serving frames.`);
        }, this.timeoutMs);
    }

    private pokeWatchdog(): void {
        this.armWatchdog();
    }

    private armReadyWatchdog(): void {
        this.clearTimer();
        const label = timeoutLabel(this.timeoutMs);
        this.timer = setTimeout(() => {
            if (this.state !== "idle") return;
            this.fail(`LBM worker stalled, no ready within ${label}, analytic fallback serving frames.`);
        }, this.timeoutMs);
    }

    init(config: LbmInitConfig): void {
        if (this.state === "disposed") return;
        this.gen += 1;
        this.clearSnapshotPending();
        this.lastInit = {
            nx: config.nx,
            ny: config.ny,
            domain: { ...config.domain },
            geomJson: config.geomJson,
            re: config.re,
            uLattice: config.uLattice,
            lesEnabled: config.lesEnabled,
            targetSteps: config.targetSteps,
            batchSteps: config.batchSteps,
            ...(config.statsStartStep !== undefined ? { statsStartStep: config.statsStartStep } : null),
        };
        this.setState("idle");
        this.armReadyWatchdog();
        this.safePost({ type: "init", gen: this.gen, ...this.lastInit });
    }

    run(): void {
        if (this.state === "disposed" || this.state === "error") return;
        if (this.state === "running") return;
        // Enforce the shared run caps on the client path so an over limit
        // config fails fast here instead of hanging on a dropped message.
        // Running from cancelled is allowed: the worker resumes the solver.
        const init = this.lastInit;
        if (init !== null) {
            if (!Number.isInteger(init.targetSteps) || init.targetSteps <= 0 || init.targetSteps > MAX_TARGET_STEPS) {
                this.fail(`LBM targetSteps ${String(init.targetSteps)} exceeds MAX_TARGET_STEPS of ${MAX_TARGET_STEPS}.`);
                return;
            }
            if (!Number.isInteger(init.batchSteps) || init.batchSteps <= 0 || init.batchSteps > MAX_BATCH_STEPS) {
                this.fail(`LBM batchSteps ${String(init.batchSteps)} exceeds MAX_BATCH_STEPS of ${MAX_BATCH_STEPS}.`);
                return;
            }
        }
        // Advance the generation before posting so a stale cancelled echo
        // from the previous run can never match this run.
        this.gen += 1;
        this.setState("running");
        this.armWatchdog();
        this.safePost({ type: "run", gen: this.gen });
    }

    cancel(): void {
        if (this.state !== "running") return;
        this.gen += 1;
        this.clearTimer();
        this.clearSnapshotPending();
        // A synchronous port throw moves to error through safePost. State
        // moves to cancelled below, latching now so late progress from the
        // old generation is ignored meanwhile.
        if (!this.safePost({ type: "cancel", gen: this.gen })) return;
        this.setState("cancelled");
    }

    requestSnapshot(): void {
        if (this.state !== "running" && this.state !== "done") return;
        if (this.snapshotPending) return;
        this.snapshotPending = true;
        if (!this.safePost({ type: "snapshot", gen: this.gen })) return;
        // A lost or rejected snapshot response would wedge the pending flag
        // forever and block later requests. Rearm on a short timer in both
        // running and done states (done has no progress watchdog).
        this.clearSnapshotTimer();
        this.snapshotTimer = setTimeout(() => {
            this.snapshotPending = false;
            this.snapshotTimer = null;
        }, 3000);
    }

    reset(config?: Partial<LbmInitConfig>): void {
        if (this.state === "disposed") return;
        this.gen += 1;
        this.clearSnapshotPending();
        this.clearTimer();
        this.setState("idle");
        // Always send a complete config so the worker never has to guess
        // missing physics inputs. Merge the caller's overrides over the
        // last full init config.
        const base = this.lastInit;
        const full: LbmInitConfig | Partial<LbmInitConfig> =
            base !== null ? { ...base, ...(config ?? {}) } : (config ?? {});
        if (base !== null) {
            this.lastInit = {
                nx: (full as LbmInitConfig).nx,
                ny: (full as LbmInitConfig).ny,
                domain: { ...(full as LbmInitConfig).domain },
                geomJson: (full as LbmInitConfig).geomJson,
                re: (full as LbmInitConfig).re,
                uLattice: (full as LbmInitConfig).uLattice,
                lesEnabled: (full as LbmInitConfig).lesEnabled,
                targetSteps: (full as LbmInitConfig).targetSteps,
                batchSteps: (full as LbmInitConfig).batchSteps,
                ...((full as LbmInitConfig).statsStartStep !== undefined
                    ? { statsStartStep: (full as LbmInitConfig).statsStartStep }
                    : null),
            };
        }
        const msg: LbmMainMessage = { type: "reset", gen: this.gen, ...full };
        this.armReadyWatchdog();
        this.safePost(msg);
    }

    dispose(): void {
        if (this.state === "disposed") return;
        this.gen += 1;
        this.clearTimer();
        this.clearSnapshotPending();
        // Route through the shared helper so a throwing port still walks
        // the disposed path instead of escaping to the caller. A failed
        // post here must not move to error: disposal always latches.
        try {
            this.worker.postMessage({ type: "dispose", gen: this.gen });
        } catch {
            // Disposal must never throw.
        }
        try {
            this.worker.onmessage = null;
            this.worker.onerror = null;
            this.worker.terminate?.();
        } catch {
            // Disposal must never throw.
        }
        this.setState("disposed");
    }

    private handleMessage(data: unknown): void {
        // Clear the pending flag on every snapshot message, even one that
        // fails validation, so a non-finite wedged snapshot never blocks
        // the next request. Valid snapshots clear it again below.
        if (typeof data === "object" && data !== null) {
            const r = data as { type?: unknown; gen?: unknown };
            if (r.type === "snapshot" && r.gen === this.gen) {
                this.clearSnapshotPending();
            }
        }
        if (!isLbmWorkerMessage(data)) return;
        if (data.gen !== this.gen) return;
        if (this.state === "disposed") return;
        switch (data.type) {
            case "ready":
                if (this.state === "idle") {
                    this.clearTimer();
                    this.clearSnapshotPending();
                }
                break;
            case "progress":
                if (this.state !== "running") return;
                this.pokeWatchdog();
                try {
                    this.onProgress?.({ step: data.step, targetSteps: data.targetSteps, cd: data.cd, cl: data.cl });
                } catch {
                    // Callback faults must never break the state machine.
                }
                break;
            case "snapshot":
                this.clearSnapshotPending();
                if (this.state !== "running" && this.state !== "done") return;
                try {
                    this.onSnapshot?.(toSnapshot(data));
                } catch {
                    // Callback faults must never break the state machine.
                }
                break;
            case "done":
                if (this.state !== "running") return;
                this.clearTimer();
                this.clearSnapshotPending();
                this.setState("done");
                try {
                    this.onProgress?.({ step: data.step, targetSteps: data.step, cd: data.cd, cl: data.cl });
                } catch {
                    // Callback faults must never break the state machine.
                }
                break;
            case "cancelled":
                this.clearTimer();
                this.clearSnapshotPending();
                if (this.state !== "cancelled") this.setState("cancelled");
                break;
            case "error":
                this.fail(data.message);
                break;
        }
    }
}
