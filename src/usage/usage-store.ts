import fs from "node:fs";
import path from "node:path";
import { estimateCostUsd, type TokenCounts } from "./pricing.js";

export interface LlmUsageEvent extends TokenCounts {
  kind: "llm";
  ts: string;
  callId: string;
  phone: string;
  requestedModel: string;
  servedModel: string;
  effort: string;
  durationMs: number;
  costUsd: number;
  stopReason: string | null;
}

export interface ToolUsageEvent {
  kind: "tool";
  ts: string;
  callId: string;
  phone: string;
  tool: string;
  server: string;
  durationMs: number;
  ok: boolean;
  blocked?: boolean;
}

export interface TurnEvent {
  kind: "turn";
  ts: string;
  callId: string;
  phone: string;
  turn: number;
  userText: string;
  assistantText: string;
  durationMs: number;
}

export interface CallEvent {
  kind: "call";
  ts: string;
  callId: string;
  phone: string;
  startedAt: string;
  endedAt: string;
  turns: number;
  endedBy: string;
}

export interface NotificationEvent {
  kind: "notification";
  ts: string;
  callId: string;
  phone: string;
  channel: string;
  ok: boolean;
  detail: string;
  text: string;
}

export interface RoutineRunEvent {
  kind: "routine";
  ts: string;
  callId: string;
  phone: string;
  routineId: string;
  name: string;
  trigger: string;
  ok: boolean;
  notified: boolean;
  durationMs: number;
  text: string;
  error?: string;
}

export type UsageEvent = LlmUsageEvent | ToolUsageEvent | TurnEvent | CallEvent | NotificationEvent | RoutineRunEvent;

export interface CallSummary {
  callId: string;
  phone: string;
  startedAt: string;
  endedAt: string | null;
  turns: number;
  llmRequests: number;
  toolCalls: number;
  tokens: TokenCounts;
  costUsd: number;
  models: string[];
  endedBy: string | null;
}

export interface UsageAggregate {
  calls: number;
  turns: number;
  llmRequests: number;
  toolCalls: number;
  tokens: TokenCounts;
  costUsd: number;
  byModel: Array<{ model: string; requests: number; tokens: TokenCounts; costUsd: number }>;
  byDay: Array<{ day: string; calls: number; requests: number; tokens: TokenCounts; costUsd: number }>;
  byTool: Array<{ tool: string; calls: number; failures: number }>;
}

const zeroTokens = (): TokenCounts => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

function addTokens(a: TokenCounts, b: TokenCounts): void {
  a.inputTokens += b.inputTokens;
  a.outputTokens += b.outputTokens;
  a.cacheReadTokens += b.cacheReadTokens;
  a.cacheWriteTokens += b.cacheWriteTokens;
}

/**
 * Append-only JSONL usage log kept fully in memory (a phone assistant produces a few
 * hundred events per day at most). One file per month keeps it easy to archive.
 */
export class UsageStore {
  private events: UsageEvent[] = [];
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "usage");
    fs.mkdirSync(this.dir, { recursive: true });
    for (const f of fs.readdirSync(this.dir).filter((f) => f.endsWith(".jsonl")).sort()) {
      const lines = fs.readFileSync(path.join(this.dir, f), "utf8").split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          this.events.push(JSON.parse(line) as UsageEvent);
        } catch {
          /* skip corrupt line */
        }
      }
    }
  }

  private fileFor(ts: string): string {
    return path.join(this.dir, `${ts.slice(0, 7)}.jsonl`);
  }

  record(event: UsageEvent): void {
    this.events.push(event);
    fs.appendFileSync(this.fileFor(event.ts), JSON.stringify(event) + "\n", "utf8");
  }

  recordLlm(e: Omit<LlmUsageEvent, "kind" | "ts" | "costUsd">): LlmUsageEvent {
    const ev: LlmUsageEvent = { ...e, kind: "llm", ts: new Date().toISOString(), costUsd: estimateCostUsd(e.servedModel || e.requestedModel, e) };
    this.record(ev);
    return ev;
  }

  recordTool(e: Omit<ToolUsageEvent, "kind" | "ts">): void {
    this.record({ ...e, kind: "tool", ts: new Date().toISOString() });
  }

  recordTurn(e: Omit<TurnEvent, "kind" | "ts">): void {
    this.record({ ...e, kind: "turn", ts: new Date().toISOString() });
  }

  recordCall(e: Omit<CallEvent, "kind" | "ts">): void {
    this.record({ ...e, kind: "call", ts: new Date().toISOString() });
  }

  recordNotification(e: Omit<NotificationEvent, "kind" | "ts">): void {
    this.record({ ...e, kind: "notification", ts: new Date().toISOString() });
  }

  recordRoutineRun(e: Omit<RoutineRunEvent, "kind" | "ts">): void {
    this.record({ ...e, kind: "routine", ts: new Date().toISOString() });
  }

  /** Newest first. */
  routineRuns(routineId?: string, limit = 50): RoutineRunEvent[] {
    const out: RoutineRunEvent[] = [];
    for (let i = this.events.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.events[i]!;
      if (e.kind === "routine" && (!routineId || e.routineId === routineId)) out.push(e);
    }
    return out;
  }

  notifications(limit = 50): NotificationEvent[] {
    const out: NotificationEvent[] = [];
    for (let i = this.events.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.events[i]!;
      if (e.kind === "notification") out.push(e);
    }
    return out;
  }

  all(): readonly UsageEvent[] {
    return this.events;
  }

  private inRange(since: Date | null): UsageEvent[] {
    if (!since) return this.events;
    const s = since.toISOString();
    return this.events.filter((e) => e.ts >= s);
  }

  aggregate(since: Date | null, timeZone = "Asia/Jerusalem"): UsageAggregate {
    const events = this.inRange(since);
    const agg: UsageAggregate = { calls: 0, turns: 0, llmRequests: 0, toolCalls: 0, tokens: zeroTokens(), costUsd: 0, byModel: [], byDay: [], byTool: [] };
    const byModel = new Map<string, UsageAggregate["byModel"][number]>();
    const byDay = new Map<string, UsageAggregate["byDay"][number]>();
    const byTool = new Map<string, UsageAggregate["byTool"][number]>();
    const dayFmt = new Intl.DateTimeFormat("sv-SE", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    const dayOf = (ts: string) => dayFmt.format(new Date(ts));
    const day = (ts: string) => {
      const d = dayOf(ts);
      let row = byDay.get(d);
      if (!row) {
        row = { day: d, calls: 0, requests: 0, tokens: zeroTokens(), costUsd: 0 };
        byDay.set(d, row);
      }
      return row;
    };
    for (const e of events) {
      if (e.kind === "llm") {
        agg.llmRequests++;
        addTokens(agg.tokens, e);
        agg.costUsd += e.costUsd;
        const m = e.servedModel || e.requestedModel;
        let row = byModel.get(m);
        if (!row) {
          row = { model: m, requests: 0, tokens: zeroTokens(), costUsd: 0 };
          byModel.set(m, row);
        }
        row.requests++;
        addTokens(row.tokens, e);
        row.costUsd += e.costUsd;
        const d = day(e.ts);
        d.requests++;
        addTokens(d.tokens, e);
        d.costUsd += e.costUsd;
      } else if (e.kind === "tool") {
        agg.toolCalls++;
        let row = byTool.get(e.tool);
        if (!row) {
          row = { tool: e.tool, calls: 0, failures: 0 };
          byTool.set(e.tool, row);
        }
        row.calls++;
        if (!e.ok) row.failures++;
      } else if (e.kind === "turn") {
        agg.turns++;
      } else if (e.kind === "call") {
        agg.calls++;
        day(e.ts).calls++;
      }
    }
    agg.byModel = [...byModel.values()].sort((a, b) => b.costUsd - a.costUsd);
    agg.byDay = [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
    agg.byTool = [...byTool.values()].sort((a, b) => b.calls - a.calls);
    return agg;
  }

  /** Per-call rollup, newest first. */
  calls(limit = 50, since: Date | null = null): CallSummary[] {
    const map = new Map<string, CallSummary>();
    for (const e of this.inRange(since)) {
      let c = map.get(e.callId);
      if (!c) {
        c = { callId: e.callId, phone: e.phone, startedAt: e.ts, endedAt: null, turns: 0, llmRequests: 0, toolCalls: 0, tokens: zeroTokens(), costUsd: 0, models: [], endedBy: null };
        map.set(e.callId, c);
      }
      if (e.kind === "llm") {
        c.llmRequests++;
        addTokens(c.tokens, e);
        c.costUsd += e.costUsd;
        const m = e.servedModel || e.requestedModel;
        if (!c.models.includes(m)) c.models.push(m);
      } else if (e.kind === "tool") c.toolCalls++;
      else if (e.kind === "turn") c.turns++;
      else if (e.kind === "call") {
        c.startedAt = e.startedAt;
        c.endedAt = e.endedAt;
        c.endedBy = e.endedBy;
        c.turns = Math.max(c.turns, e.turns);
      }
    }
    return [...map.values()].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)).slice(0, limit);
  }

  /** Full event log for one call (transcript, tools, LLM requests). */
  callEvents(callId: string): UsageEvent[] {
    return this.events.filter((e) => e.callId === callId);
  }
}
