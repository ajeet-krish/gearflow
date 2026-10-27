// Chat transcript persistence for the agent console. Cap 50 turns, version
// guarded, try/catch throughout so private mode never throws.

import type { ChatAction, ChatTurn } from "@/contracts/types";
import { validateParametricSpec } from "@/contracts/schema";

export const CHAT_STORAGE_KEY = "gearflow:chat:v1";
export const CHAT_ACTIONS_KEY = "gearflow:chat-actions:v1";
export const CHAT_VERSION = 1;
export const CHAT_CAP = 50;
export const CHAT_ID_MAX = 2000;
export const CHAT_TEXT_MAX = 2000;

const TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
    "spark-spec",
    "spark-engineer",
    "sam",
    "poster",
    "chat",
]);
const STATUS_ALLOWLIST: ReadonlySet<string> = new Set(["live", "cached", "fallback", "offline"]);

interface ChatStoreShape {
    version: number;
    turns: ChatTurn[];
}

interface ChatActionsShape {
    version: number;
    actions: Record<string, ChatAction>;
}

/** Type guard for persisted turns. Enforces id/text length caps and allowlists tool/status enums. */
export function isChatTurn(t: unknown): t is ChatTurn {
    if (typeof t !== "object" || t === null) return false;
    const r = t as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.text !== "string" || typeof r.at !== "string") return false;
    if (r.id.length === 0 || r.id.length > CHAT_ID_MAX) return false;
    if (r.text.length > CHAT_TEXT_MAX) return false;
    if (typeof r.at !== "string" || r.at.length > CHAT_TEXT_MAX) return false;
    if (r.role !== "user" && r.role !== "assistant") return false;
    if (r.tool !== undefined && (typeof r.tool !== "string" || !TOOL_ALLOWLIST.has(r.tool))) return false;
    if (r.status !== undefined && (typeof r.status !== "string" || !STATUS_ALLOWLIST.has(r.status))) return false;
    if (r.applied !== undefined && typeof r.applied !== "boolean") return false;
    if (r.specSnapshot !== undefined) {
        try {
            validateParametricSpec(r.specSnapshot);
        } catch {
            return false;
        }
    }
    return true;
}

/** Strip an invalid specSnapshot from an otherwise valid turn. Returns null when the turn itself is invalid. */
function sanitizeTurn(t: ChatTurn): ChatTurn | null {
    if (!isChatTurn(t)) {
        // Keep turns whose only fault is a poisoned snapshot: drop the field instead of the turn.
        if (typeof t !== "object" || t === null) return null;
        const r = t as unknown as Record<string, unknown>;
        if (typeof r.id !== "string" || typeof r.text !== "string" || typeof r.at !== "string") return null;
        if ((r.id as string).length === 0 || (r.id as string).length > CHAT_ID_MAX) return null;
        if ((r.text as string).length > CHAT_TEXT_MAX) return null;
        if (r.role !== "user" && r.role !== "assistant") return null;
        if (r.tool !== undefined && (typeof r.tool !== "string" || !TOOL_ALLOWLIST.has(r.tool))) return null;
        if (r.status !== undefined && (typeof r.status !== "string" || !STATUS_ALLOWLIST.has(r.status))) return null;
        const clean: ChatTurn = {
            id: r.id as string,
            role: r.role as ChatTurn["role"],
            text: r.text as string,
            at: r.at as string,
        };
        if (typeof r.tool === "string" && TOOL_ALLOWLIST.has(r.tool)) {
            clean.tool = r.tool as ChatTurn["tool"];
        }
        if (typeof r.status === "string" && STATUS_ALLOWLIST.has(r.status)) {
            clean.status = r.status as ChatTurn["status"];
        }
        if (typeof r.applied === "boolean") clean.applied = r.applied;
        return clean;
    }
    return t;
}

/** Load persisted turns. Returns [] on missing, corrupt, or foreign versions. */
export function loadTurns(): ChatTurn[] {
    try {
        if (typeof localStorage === "undefined") return [];
        const raw = localStorage.getItem(CHAT_STORAGE_KEY);
        if (raw === null) return [];
        const parsed = JSON.parse(raw) as Partial<ChatStoreShape>;
        if (parsed.version !== CHAT_VERSION || !Array.isArray(parsed.turns)) return [];
        const cleaned: ChatTurn[] = [];
        for (const t of parsed.turns) {
            const sane = sanitizeTurn(t as ChatTurn);
            if (sane !== null) cleaned.push(sane);
        }
        return cleaned.slice(-CHAT_CAP);
    } catch {
        return [];
    }
}

/** Persist turns, keeping the newest 50. Never throws. */
export function saveTurns(turns: ChatTurn[]): void {
    try {
        if (typeof localStorage === "undefined") return;
        const shape: ChatStoreShape = { version: CHAT_VERSION, turns: turns.slice(-CHAT_CAP) };
        localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(shape));
    } catch {
        // Quota or private mode: transcript still lives in memory this session.
    }
}

/** Clear the persisted transcript and actions. Never throws. */
export function clearTurns(): void {
    try {
        if (typeof localStorage === "undefined") return;
        localStorage.removeItem(CHAT_STORAGE_KEY);
        localStorage.removeItem(CHAT_ACTIONS_KEY);
    } catch {
        // Private mode: nothing persisted, nothing to remove.
    }
}

/** Append turns and persist, returning the capped list. */
export function appendTurns(existing: ChatTurn[], next: ChatTurn | ChatTurn[]): ChatTurn[] {
    const list = Array.isArray(next) ? next : [next];
    const merged = [...existing, ...list].slice(-CHAT_CAP);
    saveTurns(merged);
    return merged;
}

/** Rebuild spec actions from turns that carry a valid specSnapshot. Covers reload after an upgrade that predates action persistence. */
export function rebuildActionsFromTurns(turns: ChatTurn[]): Record<string, ChatAction> {
    const rebuilt: Record<string, ChatAction> = {};
    for (const t of turns) {
        if (t.specSnapshot === undefined) continue;
        try {
            validateParametricSpec(t.specSnapshot);
            rebuilt[t.id] = { kind: "spec", spec: t.specSnapshot };
        } catch {
            // Poisoned snapshot: skip the action, the turn text still renders.
        }
    }
    return rebuilt;
}

function isChatAction(a: unknown): a is ChatAction {
    if (typeof a !== "object" || a === null) return false;
    const r = a as Record<string, unknown>;
    if (r.kind !== "spec" && r.kind !== "explain" && r.kind !== "sam" && r.kind !== "poster") return false;
    if (r.spec !== undefined) {
        try {
            validateParametricSpec(r.spec);
        } catch {
            return false;
        }
    }
    if (r.posterUrl !== undefined && typeof r.posterUrl !== "string") return false;
    if (typeof r.posterUrl === "string" && r.posterUrl.length > CHAT_TEXT_MAX) return false;
    return true;
}

/** Load persisted apply actions, merged over rebuilt spec actions from snapshots. Never throws. */
export function loadChatActions(turns?: ChatTurn[]): Record<string, ChatAction> {
    const base = turns ? rebuildActionsFromTurns(turns) : {};
    try {
        if (typeof localStorage === "undefined") return base;
        const raw = localStorage.getItem(CHAT_ACTIONS_KEY);
        if (raw === null) return base;
        const parsed = JSON.parse(raw) as Partial<ChatActionsShape>;
        if (parsed.version !== CHAT_VERSION || typeof parsed.actions !== "object" || parsed.actions === null) {
            return base;
        }
        const clean: Record<string, ChatAction> = { ...base };
        for (const [id, action] of Object.entries(parsed.actions)) {
            if (id.length === 0 || id.length > CHAT_ID_MAX) continue;
            if (isChatAction(action)) clean[id] = action;
        }
        return clean;
    } catch {
        return base;
    }
}

/** Persist apply actions keyed by turn id. Never throws. */
export function saveChatActions(actions: Record<string, ChatAction>): void {
    try {
        if (typeof localStorage === "undefined") return;
        const clean: Record<string, ChatAction> = {};
        for (const [id, action] of Object.entries(actions)) {
            if (id.length === 0 || id.length > CHAT_ID_MAX) continue;
            if (isChatAction(action)) clean[id] = action;
        }
        const shape: ChatActionsShape = { version: CHAT_VERSION, actions: clean };
        localStorage.setItem(CHAT_ACTIONS_KEY, JSON.stringify(shape));
    } catch {
        // Quota or private mode: actions still live in memory this session.
    }
}

/** Load turns plus actions together so Apply survives a page reload. */
export function loadChatState(): { turns: ChatTurn[]; actions: Record<string, ChatAction> } {
    const turns = loadTurns();
    return { turns, actions: loadChatActions(turns) };
}
