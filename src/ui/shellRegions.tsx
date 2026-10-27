// Collapsible shell regions: ParaView style instrument blades for the rails
// plus the single handle that hides the solver and field bars. The latch is
// the one bold element, a machined blade with a notch, everything else stays
// quiet Zenith hairline. No solver or store logic lives here, only markup,
// keyboard intent, and the inert helper the rails need at runtime.

import { useEffect, useRef, type ReactNode } from "react";

declare module "react" {
    // React 18 types omit inert, but the runtime passes it through to the
    // DOM. Declared once here so the collapsed rail body carries inert in
    // both client renders and static markup tests.
    interface HTMLAttributes<T> {
        inert?: boolean | string | undefined;
    }
}

export type ShellAction = "focus" | "left" | "right" | "exitFocus";

interface EditableLike {
    tagName?: unknown;
    isContentEditable?: unknown;
    closest?: (selector: string) => unknown;
}

/** True when keystrokes belong to a form field or editable region. */
export function isEditableTarget(target: unknown): boolean {
    if (target === null || typeof target !== "object") return false;
    const el = target as EditableLike;
    const tag = typeof el.tagName === "string" ? el.tagName.toUpperCase() : "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (el.isContentEditable === true) return true;
    try {
        if (typeof el.closest === "function" && el.closest("[contenteditable]") !== null) return true;
    } catch {
        // Selector probe must never break the key handler.
    }
    return false;
}

export interface ShortcutContext {
    settingsOpen: boolean;
    target: unknown;
    ctrl?: boolean;
    meta?: boolean;
    alt?: boolean;
    repeat?: boolean;
}

/**
 * Map a key press to a shell action. Returns null when the press belongs to
 * a field, carries a modifier, or lands while Settings owns the dialog.
 * Backtick toggles focus mode, brackets toggle the rails, Escape only ever
 * exits focus mode and never enters it.
 */
export function resolveShellShortcut(key: string, ctx: ShortcutContext): ShellAction | null {
    if (ctx.settingsOpen) return null;
    // Held keys auto-repeat: ignoring repeats keeps one press to one toggle
    // and avoids a localStorage write per repeat tick.
    if (ctx.repeat === true) return null;
    if (ctx.ctrl === true || ctx.meta === true || ctx.alt === true) return null;
    if (isEditableTarget(ctx.target)) return null;
    if (key === "`") return "focus";
    if (key === "[") return "left";
    if (key === "]") return "right";
    if (key === "Escape") return "exitFocus";
    return null;
}

export interface TerminalEscapeContext {
    terminalOpen: boolean;
    settingsOpen: boolean;
    ctrl?: boolean;
    meta?: boolean;
    alt?: boolean;
    repeat?: boolean;
}

/**
 * Global terminal Escape: closes the raised run terminal on Escape even
 * when focus sits in a rail field. The field level handler reverts its own
 * text first, then this window capture closes the panel, so one press does
 * both without stealing focus. Settings open always wins. Never throws.
 */
export function shouldCloseTerminalOnEscape(key: string, ctx: TerminalEscapeContext): boolean {
    if (key !== "Escape") return false;
    if (!ctx.terminalOpen) return false;
    if (ctx.settingsOpen) return false;
    if (ctx.ctrl === true || ctx.meta === true || ctx.alt === true) return false;
    if (ctx.repeat === true) return false;
    return true;
}

interface InertLike {
    setAttribute: (name: string, value: string) => void;
    removeAttribute: (name: string) => void;
    inert?: boolean;
}

/**
 * Apply or release inert on a collapsed region body. The markup layer is the
 * declarative inert attribute on the body node; this helper covers the IDL
 * property for browsers that honour the property but not the attribute, plus
 * unit style callers. CSS display none on the collapsed wrapper is the third
 * layer, so tab order is empty even where inert is unimplemented.
 * Never throws.
 */
export function setInert(el: InertLike | null, collapsed: boolean): void {
    if (el === null || typeof el !== "object") return;
    try {
        if (collapsed) {
            el.setAttribute("inert", "");
        } else {
            el.removeAttribute("inert");
        }
        el.inert = collapsed;
    } catch {
        // Inert wiring must never break collapse.
    }
}

/**
 * True when focus sits inside a subtree. Pure so shell tests can drive the
 * focus rescue logic without a DOM. Never throws.
 */
export function isActiveInside(
    active: unknown,
    container: { contains: (node: Node | null) => boolean } | null,
): boolean {
    if (active === null || typeof active !== "object") return false;
    if (container === null || typeof container !== "object") return false;
    try {
        return container.contains(active as Node | null);
    } catch {
        return false;
    }
}

/**
 * True when a collapsing region should pull focus to its toggle handle:
 * focus was inside the region and is now lost (body or detached). Pure so
 * shell tests can assert the no-steal rule without a DOM. Never throws.
 */
export function needsFocusRescue(hadFocusInside: boolean, active: unknown, docBody: unknown): boolean {
    if (!hadFocusInside) return false;
    return active === null || active === docBody;
}

export interface RailShellProps {
    side: "left" | "right";
    label: string;
    region: string;
    bladeLabel: string;
    bodyId: string;
    collapsed: boolean;
    onToggle: () => void;
    width?: number;
    children: ReactNode;
}

/**
 * One instrument rail: content column plus a slim latch blade on the inner
 * edge. Collapsed, the content hides behind display none while staying
 * mounted, and the blade keeps the rotated label so the region reads as
 * present. Focus inside a collapsing rail is pulled to the latch.
 */
export function RailShell({
    side,
    label,
    region,
    bladeLabel,
    bodyId,
    collapsed,
    onToggle,
    width,
    children,
}: RailShellProps) {
    const bodyRef = useRef<HTMLDivElement>(null);
    const latchRef = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        setInert(bodyRef.current, collapsed);
        if (collapsed && latchRef.current !== null) {
            try {
                if (isActiveInside(document.activeElement, bodyRef.current)) {
                    latchRef.current.focus();
                }
            } catch {
                // Focus rescue must never break collapse.
            }
        }
    }, [collapsed]);
    const railClass = side === "left" ? "railLeft" : "railRight";
    return (
        <aside
            id={side === "left" ? "railLeft" : "railRight"}
            className={collapsed ? `${railClass} isCollapsed` : railClass}
            style={collapsed || width === undefined ? undefined : { width }}
            aria-label={label}
        >
            {side === "right" && (
                <button
                    ref={latchRef}
                    type="button"
                    className="railLatch"
                    aria-expanded={!collapsed}
                    aria-controls={bodyId}
                    aria-label={collapsed ? `Expand ${region}` : `Collapse ${region}`}
                    onClick={onToggle}
                >
                    <span className="latchTick" aria-hidden="true" />
                    <span className="latchWord">{bladeLabel}</span>
                </button>
            )}
            <div className="railMain">
                <div
                    ref={bodyRef}
                    id={bodyId}
                    className="railBody"
                    hidden={collapsed}
                    aria-hidden={collapsed || undefined}
                    inert={collapsed ? "" : undefined}
                >
                    {children}
                </div>
            </div>
            {side === "left" && (
                <button
                    ref={latchRef}
                    type="button"
                    className="railLatch"
                    aria-expanded={!collapsed}
                    aria-controls={bodyId}
                    aria-label={collapsed ? `Expand ${region}` : `Collapse ${region}`}
                    onClick={onToggle}
                >
                    <span className="latchTick" aria-hidden="true" />
                    <span className="latchWord">{bladeLabel}</span>
                </button>
            )}
        </aside>
    );
}

export interface SceneBarsProps {
    bodyId: string;
    collapsed: boolean;
    summary: string;
    onToggle: () => void;
    children: ReactNode;
}

/**
 * The single handle over the solver and field bars. Expanded it reads as a
 * slim labeled strip with a collapse action, collapsed it carries the one
 * line summary so the active field and engine stay legible. The handle
 * expands on click, so the summary is never the only route to the field.
 * Unlike the rails the bars unmount on collapse, so the rescue cannot probe
 * the old subtree: a focusin listener on the bars body records entry while
 * expanded, and collapse pulls focus to the handle only when that flag is
 * set and focus is now lost. The flag resets on every collapse.
 */
export function SceneBars({ bodyId, collapsed, summary, onToggle, children }: SceneBarsProps) {
    const bodyRef = useRef<HTMLDivElement>(null);
    const handleRef = useRef<HTMLButtonElement>(null);
    const hadFocusInsideRef = useRef(false);
    useEffect(() => {
        if (collapsed) return;
        const body = bodyRef.current;
        if (body === null) return;
        const markEntered = (): void => {
            hadFocusInsideRef.current = true;
        };
        body.addEventListener("focusin", markEntered);
        return () => {
            body.removeEventListener("focusin", markEntered);
        };
    }, [collapsed]);
    useEffect(() => {
        if (!collapsed) return;
        const rescue = hadFocusInsideRef.current;
        hadFocusInsideRef.current = false;
        if (!rescue || handleRef.current === null) return;
        try {
            if (needsFocusRescue(true, document.activeElement, document.body)) {
                handleRef.current.focus();
            }
        } catch {
            // Focus rescue must never break collapse.
        }
    }, [collapsed]);
    return (
        <div className="barsWrap">
            <button
                ref={handleRef}
                type="button"
                className="barsHandle"
                aria-expanded={!collapsed}
                aria-controls={bodyId}
                aria-label={collapsed ? "Expand solver and field bars" : "Collapse solver and field bars"}
                onClick={onToggle}
            >
                <span className="latchTick" aria-hidden="true" />
                <span className="barsTitle">SCENE</span>
                {collapsed && (
                    <span className="barsSummary mono">{summary}</span>
                )}
                <span className="barsHint">{collapsed ? "EXPAND" : "COLLAPSE"}</span>
            </button>
            {!collapsed && <div ref={bodyRef} id={bodyId}>{children}</div>}
        </div>
    );
}
