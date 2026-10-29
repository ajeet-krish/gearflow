// Phase averaged street animation loop. One requestAnimationFrame loop per
// served v3 street: advances a PhaseClock from elapsed milliseconds and
// reports the phase through onFrame so the caller can rewrite the displayed
// u and v via reconstructAtPhase. Pause, hide, and resume never jump the
// phase: hidden frames consume their elapsed time, and resume rebaselines
// the clock. Stop cancels the scheduled frame for unmount. Feeds are
// injected so tests run on a fake clock with zero wall time.

import type { SolverPath } from "./solverRouter";
import { PhaseClock } from "./phaseReconstruction";

/** Scheduler feeds for the loop. The default feeds bind lazily at start. */
/** Inputs for the street loop gate. Pure, no DOM access. */
export interface StreetLoopGate {
    /** Served solver path. Only neural-v3 can animate. */
    path: SolverPath;
    /** True only when every harmonic gate passes. */
    harmonicValid: boolean;
    /** LBM frames render the instantaneous snapshot, never the street. */
    lbmEffective: boolean;
    /** Fixture previews render baked fields, never the street. */
    isFixture: boolean;
    /** Held analytic frames render the last good field, never the street. */
    solveError: string | null;
    /** Case scalar Strouhal from the v3 aux head. */
    strouhal: number | null;
    /** Manifest harmonic capability. False forces steady even when the field gates pass. */
    harmonicCapable?: boolean;
}

/**
 * Decide whether one served frame starts the street loop. True only for a
 * neural-v3 frame with valid harmonics, a positive finite Strouhal, and no
 * LBM, fixture, or held analytic frame in the way. Steady v3 frames keep
 * the mean field and never start the loop. An explicit harmonicCapable
 * false (steady-only bundle) never starts the loop.
 */
export function shouldAnimateStreet(gate: StreetLoopGate): boolean {
    if (gate.path !== "neural-v3") return false;
    if (gate.lbmEffective || gate.isFixture || gate.solveError !== null) return false;
    if (gate.harmonicCapable === false) return false;
    if (gate.harmonicValid !== true) return false;
    if (gate.strouhal === null || !Number.isFinite(gate.strouhal) || !(gate.strouhal > 0)) {
        return false;
    }
    return true;
}

export interface StreetLoopFeeds {
    requestFrame: (cb: (nowMs: number) => void) => number;
    cancelFrame: (id: number) => void;
    nowMs: () => number;
    isHidden: () => boolean;
}

/** Default feeds: browser RAF plus the document visibility gate. */
export function defaultStreetFeeds(): StreetLoopFeeds {
    return {
        requestFrame: (cb) => requestAnimationFrame(cb),
        cancelFrame: (id) => cancelAnimationFrame(id),
        nowMs: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
        isHidden: () => {
            try {
                return document.hidden;
            } catch {
                return false;
            }
        },
    };
}

export interface StreetLoopOptions {
    /** Case scalar Strouhal from the v3 aux head, must be positive finite. */
    strouhal: number;
    /** Reference length for the shedding frequency, the case chord. */
    referenceLength: number;
    /** Freestream speed for the shedding frequency, defaults to 1. */
    speed?: number;
    feeds?: StreetLoopFeeds;
    /** Called once per visible frame with the new phase in radians. */
    onFrame?: (phaseRadians: number) => void;
}

function fail(cause: string): never {
    throw new Error(`street-loop: ${cause}`);
}

export class StreetLoop {
    private clock = new PhaseClock();
    private strouhal: number;
    private referenceLength: number;
    private speed: number;
    private feeds: StreetLoopFeeds;
    private onFrame: ((phaseRadians: number) => void) | null;
    private rafId: number | null = null;
    private lastMs = 0;
    private running = false;

    constructor(opts: StreetLoopOptions) {
        if (!opts || typeof opts !== "object") fail("options are required");
        if (!Number.isFinite(opts.strouhal) || !(opts.strouhal > 0)) {
            fail(`strouhal must be a positive finite number, got ${String(opts.strouhal)}`);
        }
        if (!Number.isFinite(opts.referenceLength) || !(opts.referenceLength > 0)) {
            fail(`referenceLength must be a positive finite number, got ${String(opts.referenceLength)}`);
        }
        const speed = opts.speed ?? 1;
        if (!Number.isFinite(speed) || !(speed > 0)) {
            fail(`speed must be a positive finite number, got ${String(speed)}`);
        }
        this.strouhal = opts.strouhal;
        this.referenceLength = opts.referenceLength;
        this.speed = speed;
        this.feeds = opts.feeds ?? defaultStreetFeeds();
        this.onFrame = opts.onFrame ?? null;
    }

    getPhase(): number {
        return this.clock.getPhase();
    }

    isRunning(): boolean {
        return this.running;
    }

    /** Start the loop from one phase. A running loop ignores start. */
    start(initialPhase = 0): void {
        if (this.running) return;
        this.clock.reset(initialPhase);
        this.running = true;
        try {
            this.lastMs = this.feeds.nowMs();
        } catch {
            this.lastMs = 0;
        }
        const step = (now: number): void => {
            if (!this.running) return;
            const elapsed = now - this.lastMs;
            this.lastMs = now;
            let hidden = false;
            try {
                hidden = this.feeds.isHidden();
            } catch {
                hidden = false;
            }
            if (!hidden && Number.isFinite(elapsed) && elapsed > 0) {
                this.clock.advance(elapsed, this.strouhal, this.referenceLength, this.speed);
                try {
                    this.onFrame?.(this.clock.getPhase());
                } catch {
                    // Frame callbacks must never break the loop.
                }
            }
            if (this.running) {
                try {
                    this.rafId = this.feeds.requestFrame(step);
                } catch {
                    this.running = false;
                    this.rafId = null;
                }
            }
        };
        try {
            this.rafId = this.feeds.requestFrame(step);
        } catch {
            this.running = false;
            this.rafId = null;
        }
    }

    /** Pause freezes the phase, resume continues from the same phase. */
    pause(): void {
        this.clock.pause();
    }

    resume(): void {
        this.clock.resume();
        try {
            this.lastMs = this.feeds.nowMs();
        } catch {
            // Rebaseline must never break resume.
        }
    }

    /** Stop cancels the scheduled frame. Safe to call twice. */
    stop(): void {
        this.running = false;
        if (this.rafId !== null) {
            try {
                this.feeds.cancelFrame(this.rafId);
            } catch {
                // Cancel must never break teardown.
            }
            this.rafId = null;
        }
    }
}
