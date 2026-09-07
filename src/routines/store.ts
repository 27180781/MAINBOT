import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { parseCron } from "./cron.js";

export const NOTIFY_CHANNELS = ["log", "whatsapp", "sms", "email"] as const;
export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number];

const HHMM = z.string().regex(/^\d{1,2}:\d{2}$/, "HH:MM");

export const ScheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cron"), expression: z.string().min(9).refine((e) => {
    try {
      parseCron(e);
      return true;
    } catch {
      return false;
    }
  }, "invalid cron expression") }),
  z.object({ kind: z.literal("interval"), everyMinutes: z.number().int().min(5).max(7 * 24 * 60) }),
  z.object({ kind: z.literal("event"), eventTypes: z.array(z.string().min(1).max(64)).min(1).max(20) }),
  z.object({ kind: z.literal("manual") }),
]);

export const RunResultSchema = z.object({
  at: z.string(),
  trigger: z.string(),
  ok: z.boolean(),
  notified: z.boolean(),
  text: z.string(),
  error: z.string().optional(),
  durationMs: z.number(),
  toolCalls: z.array(z.string()).default([]),
});

export const RoutineSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(80),
  enabled: z.boolean().default(true),
  schedule: ScheduleSchema,
  /** The Hebrew instruction the agent runs (what to check, when to notify, what to suggest). */
  prompt: z.string().min(3).max(4000),
  channel: z.enum(NOTIFY_CHANNELS).default("log"),
  /** null = use the global quiet hours from settings. */
  quietHours: z.object({ from: HHMM, to: HHMM }).nullable().default(null),
  source: z.string().default("admin"),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastRunAt: z.string().nullable().default(null),
  lastResult: RunResultSchema.nullable().default(null),
});

export type Routine = z.infer<typeof RoutineSchema>;
export type RoutineSchedule = z.infer<typeof ScheduleSchema>;
export type RunResult = z.infer<typeof RunResultSchema>;

export const RoutineInputSchema = RoutineSchema.pick({ name: true, enabled: true, schedule: true, prompt: true, channel: true, quietHours: true }).partial({ enabled: true, channel: true, quietHours: true });
export type RoutineInput = z.infer<typeof RoutineInputSchema>;

export const MAX_ROUTINES = 100;

/** Proactive tasks ("routines") persisted in data/routines.json. */
export class RoutineStore {
  private routines: Routine[] = [];
  private readonly file: string;
  private listeners: Array<() => void> = [];

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "routines.json");
    this.read();
  }

  private read(): void {
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as unknown;
      const list = Array.isArray(raw) ? raw : Array.isArray((raw as { routines?: unknown[] })?.routines) ? (raw as { routines: unknown[] }).routines : [];
      this.routines = list.map((r) => RoutineSchema.safeParse(r)).filter((p) => p.success).map((p) => (p as { data: Routine }).data);
    } catch {
      this.routines = [];
    }
  }

  private write(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ routines: this.routines }, null, 2), "utf8");
    fs.renameSync(tmp, this.file);
    for (const fn of this.listeners) fn();
  }

  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  list(): Routine[] {
    return this.routines.map((r) => ({ ...r }));
  }

  get(id: string): Routine | undefined {
    const r = this.routines.find((x) => x.id === id);
    return r ? { ...r } : undefined;
  }

  add(input: RoutineInput, source: string): Routine {
    if (this.routines.length >= MAX_ROUTINES) throw new Error(`Routine limit reached (${MAX_ROUTINES})`);
    const parsed = RoutineInputSchema.parse(input);
    const now = new Date().toISOString();
    const routine = RoutineSchema.parse({
      ...parsed,
      id: `rt_${crypto.randomBytes(3).toString("hex")}`,
      source,
      createdAt: now,
      updatedAt: now,
      lastRunAt: null,
      lastResult: null,
    });
    this.routines.push(routine);
    this.write();
    return { ...routine };
  }

  update(id: string, patch: Partial<RoutineInput>, source?: string): Routine {
    const idx = this.routines.findIndex((x) => x.id === id);
    if (idx < 0) throw new Error(`Routine ${id} does not exist`);
    const current = this.routines[idx]!;
    const merged = RoutineSchema.parse({ ...current, ...RoutineInputSchema.partial().parse(patch), updatedAt: new Date().toISOString(), ...(source ? { source } : {}) });
    this.routines[idx] = merged;
    this.write();
    return { ...merged };
  }

  remove(id: string): Routine {
    const idx = this.routines.findIndex((x) => x.id === id);
    if (idx < 0) throw new Error(`Routine ${id} does not exist`);
    const [removed] = this.routines.splice(idx, 1);
    this.write();
    return removed!;
  }

  recordRun(id: string, result: RunResult): void {
    const r = this.routines.find((x) => x.id === id);
    if (!r) return;
    r.lastRunAt = result.at;
    r.lastResult = RunResultSchema.parse(result);
    this.write();
  }

  /** Short numbered list for the model / the caller. */
  renderForTool(): string {
    if (this.routines.length === 0) return "אין עדיין משימות יזומות.";
    return this.routines
      .map((r) => `${r.id} - ${r.name}${r.enabled ? "" : " (כבויה)"}: ${describeSchedule(r.schedule)}, ערוץ ${r.channel}. הנחיה: ${r.prompt.slice(0, 160)}`)
      .join("\n");
  }
}

export function describeSchedule(s: RoutineSchedule): string {
  switch (s.kind) {
    case "cron":
      return `לפי לוח זמנים (${s.expression})`;
    case "interval":
      return `כל ${s.everyMinutes} דקות`;
    case "event":
      return `באירוע: ${s.eventTypes.join(", ")}`;
    default:
      return "ידני בלבד";
  }
}
