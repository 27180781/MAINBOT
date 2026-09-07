import type { Logger } from "../logger.js";
import type { SettingsStore } from "../config.js";
import type { UsageStore } from "../usage/usage-store.js";
import type { VoiceAgent } from "../agent/agent.js";
import type { Routine, RoutineStore, RunResult } from "./store.js";
import { describeSchedule } from "./store.js";
import { cronMatches, inQuietHours, nextCronRun, parseCron } from "./cron.js";

export interface RoutineTrigger {
  kind: "schedule" | "manual" | "event";
  eventType?: string;
  payload?: unknown;
}

export interface RunnerDeps {
  store: RoutineStore;
  agent: VoiceAgent;
  usage: UsageStore;
  settings: SettingsStore;
  logger: Logger;
  timeZone: string;
  tickMs?: number;
}

const MINUTE = 60_000;

/**
 * Runs routines: scheduled (cron / interval), event-driven (POST /api/v1/events) or manual.
 * Every run is a fresh proactive conversation of the same agent: read-only tools,
 * the owner's rules and instructions, and a single `notify_owner` tool that delivers
 * the report on the routine's channel. Runs are serialised so a burst of routines
 * never floods the MCP servers or the model.
 */
export class RoutineRunner {
  private timer: NodeJS.Timeout | null = null;
  private queue: Promise<void> = Promise.resolve();
  private running = new Set<string>();
  private lastMinuteRun = new Map<string, number>();

  constructor(private readonly d: RunnerDeps) {}

  start(): void {
    if (this.timer) return;
    const tick = () => void this.tick().catch((err) => this.d.logger.error({ err: err instanceof Error ? err.message : String(err) }, "routine tick failed"));
    this.timer = setInterval(tick, this.d.tickMs ?? 30_000);
    this.timer.unref();
    this.d.logger.info({ routines: this.d.store.list().filter((r) => r.enabled).length }, "routine scheduler started");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  /** Checks every enabled routine once; called by the interval timer (and by tests). */
  async tick(now = new Date()): Promise<string[]> {
    if (!this.d.settings.get().routinesEnabled) return [];
    const started: string[] = [];
    for (const r of this.d.store.list()) {
      if (!r.enabled || this.running.has(r.id)) continue;
      if (!this.isDue(r, now)) continue;
      if (this.inQuiet(r, now)) {
        this.d.logger.info({ routine: r.id }, "routine skipped: quiet hours");
        this.lastMinuteRun.set(r.id, Math.floor(now.getTime() / MINUTE));
        continue;
      }
      this.lastMinuteRun.set(r.id, Math.floor(now.getTime() / MINUTE));
      started.push(r.id);
      void this.run(r.id, { kind: "schedule" });
    }
    return started;
  }

  private inQuiet(r: Routine, now: Date): boolean {
    const q = r.quietHours ?? this.d.settings.get().quietHours;
    return inQuietHours(now, this.d.timeZone, q.from, q.to);
  }

  isDue(r: Routine, now: Date): boolean {
    if (!r.enabled) return false;
    const minute = Math.floor(now.getTime() / MINUTE);
    if (this.lastMinuteRun.get(r.id) === minute) return false;
    switch (r.schedule.kind) {
      case "cron": {
        try {
          if (!cronMatches(parseCron(r.schedule.expression), now, this.d.timeZone)) return false;
        } catch {
          return false;
        }
        // Do not re-run for the same minute after a restart.
        return !r.lastRunAt || Math.floor(Date.parse(r.lastRunAt) / MINUTE) !== minute;
      }
      case "interval": {
        if (!r.lastRunAt) return true;
        return now.getTime() - Date.parse(r.lastRunAt) >= r.schedule.everyMinutes * MINUTE;
      }
      default:
        return false;
    }
  }

  nextRunAt(r: Routine, from = new Date()): Date | null {
    if (!r.enabled) return null;
    switch (r.schedule.kind) {
      case "cron":
        try {
          return nextCronRun(parseCron(r.schedule.expression), from, this.d.timeZone);
        } catch {
          return null;
        }
      case "interval":
        return r.lastRunAt ? new Date(Date.parse(r.lastRunAt) + r.schedule.everyMinutes * MINUTE) : from;
      default:
        return null;
    }
  }

  /** Runs routines subscribed to an event type; returns the ids that were queued. */
  dispatchEvent(eventType: string, payload: unknown): string[] {
    const ids: string[] = [];
    for (const r of this.d.store.list()) {
      if (!r.enabled || r.schedule.kind !== "event") continue;
      if (!r.schedule.eventTypes.includes(eventType) && !r.schedule.eventTypes.includes("*")) continue;
      ids.push(r.id);
      void this.run(r.id, { kind: "event", eventType, payload });
    }
    return ids;
  }

  /** Runs one routine now (serialised with the others) and returns its result. */
  run(id: string, trigger: RoutineTrigger): Promise<RunResult> {
    const p = this.queue.then(() => this.execute(id, trigger));
    this.queue = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }

  private async execute(id: string, trigger: RoutineTrigger): Promise<RunResult> {
    const routine = this.d.store.get(id);
    const started = Date.now();
    const at = new Date().toISOString();
    if (!routine) return { at, trigger: trigger.kind, ok: false, notified: false, text: "", error: "routine not found", durationMs: 0, toolCalls: [] };
    this.running.add(id);
    const callId = `routine-${id}-${started}`;
    const source = `routine:${id}`;
    this.d.logger.info({ routine: id, name: routine.name, trigger: trigger.kind, eventType: trigger.eventType }, "routine run started");
    try {
      const conv = this.d.agent.newConversation(callId, source, { channel: "proactive", routine: { id, channel: routine.channel } });
      const reply = await this.d.agent.respond(conv, buildRunMessage(routine, trigger), { phone: source, channel: "הרצה יזומה - אין אדם בצד השני", userName: `משימה: ${routine.name}` });
      const notified = conv.notifications.some((n) => n.ok);
      const result: RunResult = {
        at,
        trigger: trigger.kind + (trigger.eventType ? `:${trigger.eventType}` : ""),
        ok: !reply.error,
        notified,
        text: reply.text.slice(0, 2000),
        ...(reply.error ? { error: reply.error.slice(0, 500) } : {}),
        durationMs: Date.now() - started,
        toolCalls: reply.toolCalls.slice(0, 50),
      };
      this.d.store.recordRun(id, result);
      this.d.usage.recordRoutineRun({ callId, phone: source, routineId: id, name: routine.name, trigger: result.trigger, ok: result.ok, notified, durationMs: result.durationMs, text: result.text.slice(0, 500), ...(result.error ? { error: result.error } : {}) });
      this.d.logger.info({ routine: id, ms: result.durationMs, notified, tools: reply.toolCalls.length, error: reply.error }, "routine run finished");
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const result: RunResult = { at, trigger: trigger.kind, ok: false, notified: false, text: "", error: message.slice(0, 500), durationMs: Date.now() - started, toolCalls: [] };
      this.d.store.recordRun(id, result);
      this.d.usage.recordRoutineRun({ callId, phone: source, routineId: id, name: routine.name, trigger: trigger.kind, ok: false, notified: false, durationMs: result.durationMs, text: "", error: message.slice(0, 500) });
      this.d.logger.error({ routine: id, err: message }, "routine run crashed");
      return result;
    } finally {
      this.running.delete(id);
    }
  }
}

export function buildRunMessage(routine: Routine, trigger: RoutineTrigger): string {
  const lines = [
    `[משימה יזומה] "${routine.name}" (${describeSchedule(routine.schedule)}), ערוץ ההודעה: ${routine.channel}.`,
    trigger.kind === "event" ? `הופעלה על ידי אירוע "${trigger.eventType ?? ""}".` : trigger.kind === "manual" ? "הופעלה ידנית על ידי בעל העסק." : "הופעלה לפי לוח הזמנים.",
    "",
    "ההנחיה:",
    routine.prompt.trim(),
  ];
  if (trigger.payload !== undefined) {
    let payload = "";
    try {
      payload = typeof trigger.payload === "string" ? trigger.payload : JSON.stringify(trigger.payload, null, 0);
    } catch {
      payload = String(trigger.payload);
    }
    lines.push("", "נתוני האירוע:", payload.slice(0, 6000));
  }
  lines.push("", "בצע את הבדיקה עכשיו. אם יש משהו ששווה את תשומת הלב של בעל העסק - שלח הודעה אחת עם notify_owner. אם אין - אל תשלח כלום. בסיום כתוב דוח קצר (לא מוקרא לאף אחד, נשמר ביומן).");
  return lines.join("\n");
}
