// LBM Web Worker. Owns one WasmLbmSolver, runs bounded batches, posts
// progress after each batch, and yields between batches so cancel is
// observed promptly. Snapshot channels are copied, then the copies are
// transferred. On any thrown error posts error and stops the loop. Never fabricates numbers.

import { isLbmMainMessage, MAX_BATCH_STEPS, MAX_GEOM_JSON_BYTES, MAX_TARGET_STEPS, type LbmMainMessage, type LbmSnapshotMessage } from "./lbmProtocol";

interface LbmSolverLike {
    configure(geomJson: string, re: number, uLattice: number, lesEnabled: boolean, statsStartStep?: number): void;
    run_steps(n: bigint): { stepsDone?: number; steps_done?: number; step: number; cd: number; cl: number; cancelled?: boolean };
    cancel(): void;
    resume?(): void;
    reset(): void;
    cd(): number;
    cl(): number;
    field(): {
        nx: number; ny: number; domain: { xMin: number; xMax: number; yMin: number; yMax: number };
        u: Float32Array; v: Float32Array; p: Float32Array; omega: Float32Array; obstacle: Float32Array;
        uMean?: Float32Array | null; vMean?: Float32Array | null; k?: Float32Array | null; recirc?: Float32Array | null;
        stats?: { samples: number; startStep: number; step: number; recircFraction: number; cdMean: number; clMean: number; clRms: number; strouhal: number | null } | null;
    };
    free?(): void;
}

type WasmPkg = typeof import("@/wasm/pkg/gearflow_wasm") & {
    default: (opts?: unknown) => Promise<unknown>;
};

let solver: LbmSolverLike | null = null;
let targetSteps = 0;
let batchSteps = 512;
let statsStartStep = 0;
let currentGen = 0;
let running = false;
let cancelledFlag = false;
let startStep = 0;
/** Serial chain for configuration commands so init and reset never interleave. */
let opChain: Promise<void> = Promise.resolve();

type SolverFactory = (
    nx: number,
    ny: number,
    xMin: number,
    xMax: number,
    yMin: number,
    yMax: number
) => Promise<LbmSolverLike>;

/** Clamp a requested batch to the shared protocol ceiling. */
export function clampBatchSteps(n: number): number {
    if (!Number.isFinite(n)) return 1;
    return Math.max(1, Math.min(Math.floor(n), MAX_BATCH_STEPS));
}

/** Null when the run limits are inside the shared caps, else a reason. */
export function checkRunLimits(target: number, batch: number): string | null {
    if (!Number.isInteger(target) || target <= 0 || target > MAX_TARGET_STEPS) {
        return `targetSteps must be an integer in 1..${MAX_TARGET_STEPS}`;
    }
    if (!Number.isInteger(batch) || batch <= 0 || batch > MAX_BATCH_STEPS) {
        return `batchSteps must be an integer in 1..${MAX_BATCH_STEPS}`;
    }
    return null;
}

/** Null when the geometry payload fits the shared cap, else a reason. */
export function checkGeomJsonLen(geomJson: string): string | null {
    if (geomJson.length > MAX_GEOM_JSON_BYTES) {
        return `geomJson exceeds MAX_GEOM_JSON_BYTES of ${MAX_GEOM_JSON_BYTES} bytes`;
    }
    return null;
}

/**
 * Retired duct intake error, or null when the payload needs no migration.
 * A legacy worker JSON still carrying kind duct is rejected with a
 * migration error before any solver is constructed. Mirrors
 * migrateDuctToOrifice in geometry/parametric.ts and the Rust
 * migrate_legacy_duct intake. Never throws: unparsable payloads fall
 * through to the solver configure error path.
 */
export function ductIntakeError(geomJson: string): string | null {
    let kind: unknown = null;
    try {
        const parsed: unknown = JSON.parse(geomJson);
        if (typeof parsed === "object" && parsed !== null) {
            kind = (parsed as Record<string, unknown>).kind;
        }
    } catch {
        return null;
    }
    if (kind === "duct") {
        return "LBM worker init rejected: duct is retired, migrate to the orifice plate (width resets to 0.08, height clamps to the 0.05 to 1.8 gap).";
    }
    return null;
}

function post(msg: unknown, transfer?: Transferable[]): void {
    try {
        (self as unknown as { postMessage(m: unknown, t?: Transferable[]): void }).postMessage(msg, transfer as Transferable[]);
    } catch {
        try {
            (self as unknown as { postMessage(m: unknown): void }).postMessage(msg);
        } catch {
            // Posting must never throw out of the worker.
        }
    }
}

function fail(gen: number, message: string): void {
    running = false;
    post({ type: "error", gen, message });
}

/** Copy one snapshot channel so the transferred buffer never aliases solver memory. */
export function copyChannel(src: Float32Array, n: number, name: string): Float32Array {
    const arr = src instanceof Float32Array ? src : new Float32Array(src as unknown as ArrayLike<number>);
    if (arr.length !== n) throw new Error(`LBM snapshot channel ${name} has bad length.`);
    return arr.slice();
}

function isFiniteNumberLocal(x: unknown): x is number {
    return typeof x === "number" && Number.isFinite(x);
}

function isValidDomainLocal(d: unknown): boolean {
    if (typeof d !== "object" || d === null) return false;
    const r = d as Record<string, unknown>;
    for (const k of ["xMin", "xMax", "yMin", "yMax"] as const) {
        if (!isFiniteNumberLocal(r[k])) return false;
    }
    return (r.xMax as number) > (r.xMin as number) && (r.yMax as number) > (r.yMin as number);
}

/**
 * True when a reset message carries a complete config. A partial reset is
 * rejected with an error rather than posting ready, so the client must
 * always send the full init config on reset.
 */
export function isCompleteReset(msg: unknown): boolean {
    if (typeof msg !== "object" || msg === null) return false;
    const r = msg as Record<string, unknown>;
    if (r.type !== "reset") return false;
    if (!Number.isInteger(r.nx) || (r.nx as number) < 4 || (r.nx as number) > 512) return false;
    if (!Number.isInteger(r.ny) || (r.ny as number) < 4 || (r.ny as number) > 512) return false;
    if (!isValidDomainLocal(r.domain)) return false;
    if (typeof r.geomJson !== "string" || (r.geomJson as string).length === 0) return false;
    if ((r.geomJson as string).length > MAX_GEOM_JSON_BYTES) return false;
    if (!isFiniteNumberLocal(r.re) || (r.re as number) <= 0) return false;
    if (!isFiniteNumberLocal(r.uLattice) || (r.uLattice as number) <= 0) return false;
    if (typeof r.lesEnabled !== "boolean") return false;
    if (checkRunLimits(r.targetSteps as number, r.batchSteps as number) !== null) return false;
    if (r.statsStartStep !== undefined && (!Number.isInteger(r.statsStartStep) || (r.statsStartStep as number) < 0 || (r.statsStartStep as number) > MAX_TARGET_STEPS)) return false;
    return true;
}

async function ensureSolver(
    nx: number,
    ny: number,
    xMin: number,
    xMax: number,
    yMin: number,
    yMax: number
): Promise<LbmSolverLike> {
    const pkg = (await import("@/wasm/pkg/gearflow_wasm")) as unknown as WasmPkg;
    const init = (pkg as unknown as { default?: unknown }).default;
    if (typeof init === "function") {
        await (init as (o?: unknown) => Promise<unknown>)();
    }
    const Ctor = (pkg as unknown as { WasmLbmSolver?: new (nx: number, ny: number, xMin: number, xMax: number, yMin: number, yMax: number) => LbmSolverLike }).WasmLbmSolver;
    if (typeof Ctor !== "function") {
        throw new Error("WasmLbmSolver is missing from the wasm package.");
    }
    if (solver !== null) {
        try {
            solver.free?.();
        } catch {
            // Disposal must never break re-init.
        }
        solver = null;
    }
    const next = new Ctor(nx, ny, xMin, xMax, yMin, yMax);
    solver = next;
    return next;
}

let solverFactory: SolverFactory = ensureSolver;

/** Test hook: swap the solver constructor for a fake. Pass null to restore. */
export function __setSolverFactoryForTest(f: SolverFactory | null): void {
    solverFactory = f ?? ensureSolver;
}

/** Test hook: reset module state between tests. */
export function __resetWorkerForTest(): void {
    solver = null;
    targetSteps = 0;
    batchSteps = 512;
    statsStartStep = 0;
    currentGen = 0;
    running = false;
    cancelledFlag = false;
    startStep = 0;
    opChain = Promise.resolve();
    solverFactory = ensureSolver;
}

/** Test hook: wait until all queued init and reset commands settle. */
export function __drainQueueForTest(): Promise<void> {
    return opChain.then(() => undefined);
}

/** Queue a configuration command so init and reset never interleave. */
function serializeConfig(task: () => Promise<void>): void {
    opChain = opChain.then(task, task);
    // Keep the chain alive even if a task throws outside its own catch.
    opChain = opChain.then(undefined, () => undefined);
}

async function runLoop(gen: number): Promise<void> {
    if (solver === null) {
        fail(gen, "LBM worker has no solver, init first.");
        return;
    }
    // Cancel is terminal through the shipped protocol: only cancel() and
    // reset() exist on the wire, and nothing called resume(), so a second
    // run after cancel stepped zero steps forever. Resume here when this
    // worker previously cancelled, and surface a poisoned state as an
    // error instead of a silent no-op.
    if (cancelledFlag) {
        try {
            solver.resume?.();
        } catch (e: unknown) {
            fail(gen, e instanceof Error ? e.message : String(e));
            return;
        }
    }
    running = true;
    cancelledFlag = false;
    try {
        for (;;) {
            if (gen !== currentGen || cancelledFlag) return;
            const s = solver as LbmSolverLike;
            let report: { step: number; cd: number; cl: number; cancelled?: boolean };
            try {
                const raw = s.run_steps(BigInt(Math.max(1, batchSteps))) as unknown as {
                    stepsDone?: number; steps_done?: number; step: number | bigint; cd: number; cl: number; cancelled?: boolean;
                };
                const stepNum = typeof raw.step === "bigint" ? Number(raw.step) : raw.step;
                report = { step: stepNum, cd: raw.cd, cl: raw.cl, cancelled: raw.cancelled === true };
            } catch (e: unknown) {
                fail(gen, e instanceof Error ? e.message : String(e));
                return;
            }
            if (gen !== currentGen || cancelledFlag) return;
            if (report.cancelled === true) {
                running = false;
                post({ type: "cancelled", gen, step: report.step });
                return;
            }
            startStep = report.step;
            post({ type: "progress", gen, step: report.step, targetSteps, cd: report.cd, cl: report.cl });
            if (report.step >= targetSteps) {
                running = false;
                post({ type: "done", gen, step: report.step, cd: report.cd, cl: report.cl });
                return;
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
    } finally {
        if (gen === currentGen && !cancelledFlag) {
            // running flag already settled on terminal posts above.
        }
    }
}

function takeSnapshot(gen: number): void {
    if (solver === null) {
        fail(gen, "LBM worker has no solver, init first.");
        return;
    }
    try {
        const f = solver.field();
        const n = f.nx * f.ny;
        const u = copyChannel(f.u, n, "u");
        const v = copyChannel(f.v, n, "v");
        const p = copyChannel(f.p, n, "p");
        const omega = copyChannel(f.omega, n, "omega");
        const obstacle = copyChannel(f.obstacle, n, "obstacle");
        const msg: LbmSnapshotMessage = {
            type: "snapshot",
            gen,
            step: startStep,
            cd: solver.cd(),
            cl: solver.cl(),
            nx: f.nx,
            ny: f.ny,
            domain: { ...f.domain },
            u, v, p, omega, obstacle,
        };
        const transfer: ArrayBuffer[] = [u.buffer as ArrayBuffer, v.buffer as ArrayBuffer, p.buffer as ArrayBuffer, omega.buffer as ArrayBuffer, obstacle.buffer as ArrayBuffer];
        const extra = f as { uMean?: unknown; vMean?: unknown; k?: unknown; recirc?: unknown };
        if (extra.uMean !== undefined && extra.uMean !== null) {
            const ch = copyChannel(extra.uMean as Float32Array, n, "uMean");
            msg.uMean = ch;
            transfer.push(ch.buffer as ArrayBuffer);
        }
        if (extra.vMean !== undefined && extra.vMean !== null) {
            const ch = copyChannel(extra.vMean as Float32Array, n, "vMean");
            msg.vMean = ch;
            transfer.push(ch.buffer as ArrayBuffer);
        }
        if (extra.k !== undefined && extra.k !== null) {
            const ch = copyChannel(extra.k as Float32Array, n, "k");
            msg.k = ch;
            transfer.push(ch.buffer as ArrayBuffer);
        }
        if (extra.recirc !== undefined && extra.recirc !== null) {
            const ch = copyChannel(extra.recirc as Float32Array, n, "recirc");
            msg.recirc = ch;
            transfer.push(ch.buffer as ArrayBuffer);
        }
        const withStats = f as { stats?: unknown };
        if (withStats.stats !== undefined && withStats.stats !== null) {
            msg.stats = withStats.stats as LbmSnapshotMessage["stats"];
        }
        post(msg, transfer as unknown as Transferable[]);
    } catch (e: unknown) {
        fail(gen, e instanceof Error ? e.message : String(e));
    }
}

/** Validated entry point for one main to worker message. Exported for tests. */
export function handleMainMessage(msg: LbmMainMessage): void {
    void (async () => {
        try {
            switch (msg.type) {
                case "init": {
                    currentGen = msg.gen;
                    running = false;
                    cancelledFlag = false;
                    const myGen = msg.gen;
                    const limitError = checkRunLimits(msg.targetSteps, msg.batchSteps);
                    if (limitError !== null) {
                        fail(myGen, `LBM worker init rejected: ${limitError}.`);
                        break;
                    }
                    const geomError = checkGeomJsonLen(msg.geomJson);
                    if (geomError !== null) {
                        fail(myGen, `LBM worker init rejected: ${geomError}.`);
                        break;
                    }
                    const retiredError = ductIntakeError(msg.geomJson);
                    if (retiredError !== null) {
                        fail(myGen, retiredError);
                        break;
                    }
                    const wanted = msg.targetSteps;
                    const batch = clampBatchSteps(msg.batchSteps);
                    const { nx, ny, domain, geomJson, re, uLattice, lesEnabled } = msg;
                    const wantedStatsStart = typeof msg.statsStartStep === "number" ? msg.statsStartStep : 0;
                    serializeConfig(async () => {
                        if (myGen !== currentGen) return;
                        try {
                            const s = await solverFactory(nx, ny, domain.xMin, domain.xMax, domain.yMin, domain.yMax);
                            // Recheck after the await: a newer init or reset
                            // may have arrived while loading. Abandon this
                            // stale configuration before calling configure.
                            if (myGen !== currentGen) return;
                            solver = s;
                            s.configure(geomJson, re, uLattice, lesEnabled, wantedStatsStart);
                            if (myGen !== currentGen) return;
                            targetSteps = wanted;
                            batchSteps = batch;
                            statsStartStep = wantedStatsStart;
                            startStep = 0;
                            post({ type: "ready", gen: myGen });
                        } catch (e: unknown) {
                            if (myGen === currentGen) {
                                fail(myGen, e instanceof Error ? e.message : String(e));
                            }
                        }
                    });
                    break;
                }
                case "run": {
                    if (msg.gen < currentGen) return;
                    if (running && msg.gen === currentGen) return;
                    currentGen = msg.gen;
                    if (solver === null) {
                        fail(msg.gen, "LBM worker has no solver, init first.");
                        return;
                    }
                    await runLoop(msg.gen);
                    break;
                }
                case "cancel": {
                    currentGen = msg.gen;
                    cancelledFlag = true;
                    try {
                        solver?.cancel();
                    } catch {
                        // Cancel must never throw.
                    }
                    running = false;
                    post({ type: "cancelled", gen: msg.gen, step: startStep });
                    break;
                }
                case "reset": {
                    currentGen = msg.gen;
                    cancelledFlag = false;
                    running = false;
                    const myGen = msg.gen;
                    if (!isCompleteReset(msg)) {
                        fail(myGen, "LBM worker reset needs a complete config, init fields are required.");
                        break;
                    }
                    const r = msg as unknown as {
                        nx: number; ny: number;
                        domain: { xMin: number; xMax: number; yMin: number; yMax: number };
                        geomJson: string; re: number; uLattice: number; lesEnabled: boolean;
                        targetSteps: number; batchSteps: number; statsStartStep?: number;
                    };
                    const retiredResetError = ductIntakeError(r.geomJson);
                    if (retiredResetError !== null) {
                        fail(myGen, retiredResetError);
                        break;
                    }
                    const wantedStatsStart = typeof r.statsStartStep === "number" ? r.statsStartStep : 0;
                    serializeConfig(async () => {
                        if (myGen !== currentGen) return;
                        try {
                            const s = await solverFactory(r.nx, r.ny, r.domain.xMin, r.domain.xMax, r.domain.yMin, r.domain.yMax);
                            if (myGen !== currentGen) return;
                            solver = s;
                            s.configure(r.geomJson, r.re, r.uLattice, r.lesEnabled, wantedStatsStart);
                            if (myGen !== currentGen) return;
                            targetSteps = r.targetSteps;
                            batchSteps = clampBatchSteps(r.batchSteps);
                            statsStartStep = wantedStatsStart;
                            startStep = 0;
                            post({ type: "ready", gen: myGen });
                        } catch (e: unknown) {
                            if (myGen === currentGen) {
                                fail(myGen, e instanceof Error ? e.message : String(e));
                            }
                        }
                    });
                    break;
                }
                case "snapshot": {
                    if (msg.gen !== currentGen) return;
                    takeSnapshot(msg.gen);
                    break;
                }
                case "dispose": {
                    currentGen = msg.gen;
                    cancelledFlag = true;
                    running = false;
                    try {
                        solver?.free?.();
                    } catch {
                        // Disposal must never throw.
                    }
                    solver = null;
                    break;
                }
            }
        } catch (e: unknown) {
            fail(msg.gen, e instanceof Error ? e.message : String(e));
        }
    })();
}

function boundOnMessage(ev: MessageEvent): void {
    const msg = (ev as { data?: unknown }).data;
    if (!isLbmMainMessage(msg)) return;
    handleMainMessage(msg);
};

if (typeof self !== "undefined") {
    try {
        (self as unknown as { onmessage: unknown }).onmessage = boundOnMessage;
    } catch {
        // Non worker import (unit tests) must never throw.
    }
}
