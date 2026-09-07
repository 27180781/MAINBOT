/**
 * Decides which tools may run from a phone call without an explicit spoken confirmation.
 * Read-only tools run freely; anything that writes, sends or deletes must be requested
 * twice by the model across two caller turns (ask -> caller confirms -> execute).
 */

export interface ToolLike {
  name: string;
  description?: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean } | undefined;
  inputSchema?: { properties?: Record<string, unknown> } | undefined;
}

const READ_PATTERNS: RegExp[] = [
  /^(get|list|search|find|read|fetch|check|view|show|describe|diagnose|explain|diff|export|download|count|whoami|lookup|query|verify_caller_id|validate|listening|queue|pipeline|revenue|inbox|daily|gamification|system_status|schema_version|render|preview|plan)_?/i,
  /(_summary|_report|_stats|_status|_history|_counts)$/i,
  /^(search|fetch)$/i,
];

const WRITE_PATTERNS: RegExp[] = [
  /^(create|add|update|delete|remove|send|set|manage|mark|merge|convert|record|run|execute|upload|transfer|hangup|toggle|bulk|cancel|schedule|replace|reset|rename|reorder|invite|disconnect|begin|start|edit|enable|disable|deploy|move|remix|initiate|import|learn|link|log|generate|request|write|clear|restore|rollback|fork|push|resolve|unresolve|archive|enqueue|charge|pay|refund)_?/i,
];

const WRITE_VERBS = new Set(["create", "add", "update", "delete", "remove", "send", "set", "manage", "mark", "merge", "convert", "record", "run", "execute", "upload", "transfer", "hangup", "toggle", "bulk", "cancel", "schedule", "replace", "reset", "rename", "reorder", "invite", "disconnect", "begin", "start", "edit", "enable", "disable", "deploy", "move", "remix", "initiate", "import", "learn", "link", "log", "generate", "request", "write", "clear", "restore", "rollback", "fork", "push", "resolve", "unresolve", "archive", "charge", "pay", "refund", "capture", "tokenize", "subscribe", "unsubscribe", "use", "login"]);
const READ_VERBS = new Set(["get", "list", "search", "find", "read", "fetch", "check", "view", "show", "describe", "diagnose", "explain", "diff", "export", "download", "count", "whoami", "lookup", "query", "verify", "validate", "test", "catalog", "report", "summary", "stats", "status", "history", "counts", "preview", "render", "plan"]);

export function classifyTool(tool: ToolLike): "read" | "write" {
  const ann = tool.annotations;
  if (ann?.readOnlyHint === true) return "read";
  if (ann?.destructiveHint === true) return "write";
  const base = tool.name.includes("__") ? tool.name.slice(tool.name.indexOf("__") + 2) : tool.name;
  if (WRITE_PATTERNS.some((re) => re.test(base))) return "write";
  if (READ_PATTERNS.some((re) => re.test(base))) return "read";
  // Vendor-prefixed names such as sumit_documents_list / sumit_payments_charge: judge by the verbs inside.
  const tokens = base.toLowerCase().split(/[_\-.]+/).filter(Boolean);
  if (tokens.some((t) => WRITE_VERBS.has(t))) return "write";
  if (tokens.some((t) => READ_VERBS.has(t))) return "read";
  // Unknown verbs: be conservative.
  return "write";
}

const TOKEN_KEYS = ["confirmation_token", "confirmationToken", "confirm_token"];

/** Tools whose server already enforces a preview -> confirm handshake (confirm=true / confirmation_token). */
export function hasServerSideConfirmation(tool: ToolLike): boolean {
  const props = tool.inputSchema?.properties ?? {};
  return ["confirm", ...TOKEN_KEYS].some((k) => k in props);
}

/**
 * True for the *preview* step of a server-side handshake: the call carries neither
 * `confirm: true` nor a confirmation token, so the server only describes what it would do.
 * The executing call goes through the normal two-turn gate - otherwise the model could pass
 * `confirm: true` (or the token it just received) on the first call and skip the caller.
 */
export function isHandshakePreview(tool: ToolLike, args: unknown): boolean {
  if (!hasServerSideConfirmation(tool)) return false;
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const confirm = a.confirm;
  if (confirm === true || (typeof confirm === "string" && /^(true|yes|1)$/i.test(confirm.trim())) || (typeof confirm === "number" && confirm !== 0)) return false;
  for (const k of TOKEN_KEYS) {
    const v = a[k];
    if ((typeof v === "string" && v.trim()) || typeof v === "number") return false;
  }
  return true;
}

export function isBlocked(fullName: string, patterns: string[]): boolean {
  for (const p of patterns) {
    if (!p) continue;
    try {
      if (new RegExp(p, "i").test(fullName)) return true;
    } catch {
      if (fullName.toLowerCase().includes(p.toLowerCase())) return true;
    }
  }
  return false;
}

export interface GateDecision {
  allowed: boolean;
  reason?: "blocked" | "read_only_server" | "confirmation_required";
  message?: string;
}

/** JSON with sorted object keys, so the same arguments always compare equal regardless of key order. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

interface Pending {
  turn: number;
  /** Canonical JSON of the arguments the caller was asked to approve. */
  args: string;
}

export interface GateOptions {
  confirmWrites: boolean;
  blockedTools: string[];
  /** How many caller turns a pending approval stays valid. */
  approvalWindowTurns?: number;
}

/**
 * Per-call gate. `turn` is the caller-turn counter (increments once per spoken utterance),
 * so a write requested in turn N is only executed when the model requests it again, with
 * the same arguments, in turn N+1 (or N+2) - i.e. after the caller heard the question and answered.
 */
export class ConfirmationGate {
  private pending = new Map<string, Pending>();

  /** Options may be a function so long-lived conversations (chat sessions) follow the live admin settings. */
  constructor(private readonly source: GateOptions | (() => GateOptions)) {}

  private get opts(): GateOptions {
    return typeof this.source === "function" ? this.source() : this.source;
  }

  check(tool: ToolLike, fullName: string, args: unknown, turn: number, serverReadOnly = false): GateDecision {
    if (isBlocked(fullName, this.opts.blockedTools)) {
      return { allowed: false, reason: "blocked", message: "This tool is blocked for the phone assistant by the administrator. Tell the caller it must be done from the computer." };
    }
    const kind = classifyTool({ ...tool, name: fullName });
    if (kind === "read") return { allowed: true };
    if (serverReadOnly) {
      return { allowed: false, reason: "read_only_server", message: "This service is connected in read-only mode. Tell the caller the change must be made from the computer." };
    }
    if (!this.opts.confirmWrites || isHandshakePreview(tool, args)) return { allowed: true };
    const window = this.opts.approvalWindowTurns ?? 2;
    const key = stableStringify(args ?? {});
    const prev = this.pending.get(fullName);
    const inWindow = prev !== undefined && prev.turn < turn && turn - prev.turn <= window;
    if (prev && inWindow && prev.args === key) {
      this.pending.delete(fullName);
      return { allowed: true };
    }
    // Same tool, different arguments (another recipient, another amount): the caller never approved this one.
    const argsChanged = prev !== undefined && prev.args !== key && turn - prev.turn <= window;
    if (!prev || prev.turn !== turn || argsChanged) this.pending.set(fullName, { turn, args: key });
    return {
      allowed: false,
      reason: "confirmation_required",
      message:
        "CONFIRMATION REQUIRED: this action changes data or contacts someone, so it was NOT executed. " +
        (argsChanged ? "The arguments differ from the request the caller was asked to confirm, so a new confirmation is needed. " : "") +
        "Describe to the caller exactly what you are about to do (who, what, which values) and ask for a clear yes. " +
        "Only after the caller confirms in their next reply, call this tool again with exactly the same arguments and it will run.",
    };
  }

  /** Approvals older than the window are dropped when the caller moves on. */
  expire(turn: number): void {
    const window = this.opts.approvalWindowTurns ?? 2;
    for (const [k, v] of this.pending) if (turn - v.turn > window) this.pending.delete(k);
  }

  pendingCount(): number {
    return this.pending.size;
  }
}
