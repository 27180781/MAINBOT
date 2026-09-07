import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseCron, cronMatches, nextCronRun, inQuietHours, parseHHMM, zonedParts } from "../src/routines/cron.js";
import { RoutineStore, describeSchedule, MAX_ROUTINES } from "../src/routines/store.js";
import { Notifier, renderTemplate } from "../src/routines/notify.js";
import { RoutineRunner, buildRunMessage } from "../src/routines/runner.js";
import { SettingsStore } from "../src/config.js";
import { UsageStore } from "../src/usage/usage-store.js";
import type { McpHub } from "../src/mcp/hub.js";
import type { VoiceAgent, ConversationState, AgentReply } from "../src/agent/agent.js";
import type { Logger } from "../src/logger.js";

const TZ = "Asia/Jerusalem";

function fakeLogger() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn(), child: vi.fn() };
  log.child.mockReturnValue(log);
  return { logger: log as unknown as Logger, log };
}

/** Local Israel time -> Date (IDT in summer, IST in winter). */
function local(iso: string): Date {
  const d = new Date(`${iso}:00Z`);
  const p = zonedParts(d, TZ);
  // shift by the zone offset so the wall clock matches the requested local time
  const wanted = new Date(`${iso}:00Z`);
  const offsetMin = (p.hour * 60 + p.minute) - (wanted.getUTCHours() * 60 + wanted.getUTCMinutes());
  return new Date(d.getTime() - offsetMin * 60_000);
}

describe("cron", () => {
  it("parses lists, ranges and steps", () => {
    const spec = parseCron("*/15 9-18 1,15 * 0-4");
    expect([...spec.minute]).toEqual([0, 15, 30, 45]);
    expect([...spec.hour]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
    expect([...spec.dom]).toEqual([1, 15]);
    expect(spec.month.size).toBe(12);
    expect([...spec.dow]).toEqual([0, 1, 2, 3, 4]);
    expect(spec.domAndDow).toBe(true);
    expect([...parseCron("0 8 * * 7").dow]).toEqual([0]); // 7 = Sunday
  });

  it("rejects malformed expressions", () => {
    expect(() => parseCron("0 8 * *")).toThrow(/5 fields/);
    expect(() => parseCron("60 8 * * *")).toThrow(/out of range/);
    expect(() => parseCron("0 8 * * abc")).toThrow(/Invalid cron/);
    expect(() => parseCron("*/0 * * * *")).toThrow(/step/);
  });

  it("matches wall-clock time in the configured zone", () => {
    const spec = parseCron("0 8 * * 0-4");
    // Sunday 2026-09-06 08:00 Israel (IDT, UTC+3) = 05:00Z
    expect(cronMatches(spec, new Date("2026-09-06T05:00:00Z"), TZ)).toBe(true);
    expect(cronMatches(spec, new Date("2026-09-06T08:00:00Z"), TZ)).toBe(false); // 11:00 local
    expect(cronMatches(spec, new Date("2026-09-06T05:00:00Z"), "UTC")).toBe(false);
    // Friday is excluded by 0-4
    expect(cronMatches(spec, new Date("2026-09-11T05:00:00Z"), TZ)).toBe(false);
    // In winter (IST, UTC+2) 08:00 local is 06:00Z
    expect(cronMatches(spec, new Date("2026-12-06T06:00:00Z"), TZ)).toBe(true);
  });

  it("computes the next run after a given time", () => {
    const spec = parseCron("0 8 * * 0-4");
    const next = nextCronRun(spec, new Date("2026-09-06T05:00:00Z"), TZ); // Sunday 08:00 -> Monday 08:00
    expect(next?.toISOString()).toBe("2026-09-07T05:00:00.000Z");
    const fromThursdayNoon = nextCronRun(spec, new Date("2026-09-10T09:00:00Z"), TZ); // Thu 12:00 -> Sun 08:00
    expect(fromThursdayNoon?.toISOString()).toBe("2026-09-13T05:00:00.000Z");
    const hourly = nextCronRun(parseCron("30 * * * *"), new Date("2026-09-06T05:31:00Z"), TZ);
    expect(hourly?.toISOString()).toBe("2026-09-06T06:30:00.000Z");
    expect(nextCronRun(parseCron("0 0 31 2 *"), new Date("2026-09-06T05:00:00Z"), TZ)).toBeNull();
  });

  it("understands quiet hours that cross midnight", () => {
    expect(parseHHMM("22:00")).toBe(22 * 60);
    expect(parseHHMM("7:05")).toBe(7 * 60 + 5);
    expect(parseHHMM("25:00")).toBeNull();
    expect(parseHHMM("x")).toBeNull();
    // 23:30 local (IDT) = 20:30Z
    expect(inQuietHours(new Date("2026-09-06T20:30:00Z"), TZ, "22:00", "07:00")).toBe(true);
    // 06:59 local = 03:59Z
    expect(inQuietHours(new Date("2026-09-06T03:59:00Z"), TZ, "22:00", "07:00")).toBe(true);
    // 07:00 local = 04:00Z -> quiet ends
    expect(inQuietHours(new Date("2026-09-06T04:00:00Z"), TZ, "22:00", "07:00")).toBe(false);
    // 12:00 local
    expect(inQuietHours(new Date("2026-09-06T09:00:00Z"), TZ, "22:00", "07:00")).toBe(false);
    // same-day window 13:00-14:00
    expect(inQuietHours(new Date("2026-09-06T10:30:00Z"), TZ, "13:00", "14:00")).toBe(true);
    expect(inQuietHours(new Date("2026-09-06T11:30:00Z"), TZ, "13:00", "14:00")).toBe(false);
    // from == to -> never quiet
    expect(inQuietHours(new Date("2026-09-06T10:30:00Z"), TZ, "13:00", "13:00")).toBe(false);
    expect(local("2026-09-06T08:00").toISOString()).toBe("2026-09-06T05:00:00.000Z");
  });
});

describe("RoutineStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mainbot-routines-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("adds, updates, removes and persists routines", () => {
    const store = new RoutineStore(dir);
    const onChange = vi.fn();
    store.onChange(onChange);
    const r = store.add({ name: "תדריך בוקר", schedule: { kind: "cron", expression: "0 8 * * 0-4" }, prompt: "סכם את היום", channel: "whatsapp" }, "phone:0501234567");
    expect(r.id).toMatch(/^rt_[0-9a-f]{6}$/);
    expect(r).toMatchObject({ name: "תדריך בוקר", enabled: true, channel: "whatsapp", source: "phone:0501234567", lastRunAt: null, lastResult: null, quietHours: null });
    expect(onChange).toHaveBeenCalledTimes(1);

    const updated = store.update(r.id, { enabled: false, schedule: { kind: "interval", everyMinutes: 30 } }, "admin");
    expect(updated).toMatchObject({ enabled: false, schedule: { kind: "interval", everyMinutes: 30 }, source: "admin", name: "תדריך בוקר" });
    expect(Date.parse(updated.updatedAt)).toBeGreaterThanOrEqual(Date.parse(r.createdAt));

    store.recordRun(r.id, { at: "2026-09-06T05:00:00.000Z", trigger: "manual", ok: true, notified: true, text: "דוח", durationMs: 1200, toolCalls: ["crm__search_contacts"] });
    expect(store.get(r.id)).toMatchObject({ lastRunAt: "2026-09-06T05:00:00.000Z", lastResult: { ok: true, notified: true, text: "דוח" } });

    const reloaded = new RoutineStore(dir);
    expect(reloaded.list()).toEqual(store.list());
    expect(JSON.parse(fs.readFileSync(path.join(dir, "routines.json"), "utf8")).routines).toHaveLength(1);

    expect(store.remove(r.id).id).toBe(r.id);
    expect(store.list()).toEqual([]);
    expect(() => store.remove(r.id)).toThrow(/does not exist/);
    expect(() => store.update("rt_nope", { enabled: true })).toThrow(/does not exist/);
  });

  it("validates input", () => {
    const store = new RoutineStore(dir);
    expect(() => store.add({ name: "", schedule: { kind: "manual" }, prompt: "בדוק" }, "admin")).toThrow();
    expect(() => store.add({ name: "x", schedule: { kind: "cron", expression: "0 8 * *" }, prompt: "בדוק" }, "admin")).toThrow(/cron/);
    expect(() => store.add({ name: "x", schedule: { kind: "interval", everyMinutes: 1 }, prompt: "בדוק" }, "admin")).toThrow();
    expect(() => store.add({ name: "x", schedule: { kind: "event", eventTypes: [] }, prompt: "בדוק" }, "admin")).toThrow();
    expect(() => store.add({ name: "x", schedule: { kind: "manual" }, prompt: "בדוק", channel: "pigeon" as never }, "admin")).toThrow();
    expect(() => store.add({ name: "x", schedule: { kind: "manual" }, prompt: "בדוק", quietHours: { from: "22", to: "07:00" } }, "admin")).toThrow();
    for (let i = 0; i < MAX_ROUTINES; i++) store.add({ name: `r${i}`, schedule: { kind: "manual" }, prompt: "בדוק" }, "admin");
    expect(() => store.add({ name: "one too many", schedule: { kind: "manual" }, prompt: "בדוק" }, "admin")).toThrow(/limit/);
  });

  it("ignores corrupt entries on disk and renders a list for the model", () => {
    fs.writeFileSync(path.join(dir, "routines.json"), JSON.stringify({ routines: [{ id: "rt_bad" }, { id: "rt_ok0001", name: "לידים", enabled: true, schedule: { kind: "event", eventTypes: ["new_lead"] }, prompt: "בדוק ליד", channel: "sms", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }] }), "utf8");
    const store = new RoutineStore(dir);
    expect(store.list().map((r) => r.id)).toEqual(["rt_ok0001"]);
    expect(store.renderForTool()).toContain("rt_ok0001 - לידים: באירוע: new_lead, ערוץ sms");
    expect(new RoutineStore(fs.mkdtempSync(path.join(dir, "empty-"))).renderForTool()).toBe("אין עדיין משימות יזומות.");
    expect(describeSchedule({ kind: "cron", expression: "0 8 * * *" })).toContain("0 8 * * *");
    expect(describeSchedule({ kind: "interval", everyMinutes: 15 })).toBe("כל 15 דקות");
    expect(describeSchedule({ kind: "manual" })).toBe("ידני בלבד");
  });
});

describe("Notifier", () => {
  let dir: string;
  let settings: SettingsStore;
  let usage: UsageStore;
  let callTool: ReturnType<typeof vi.fn>;
  let tools: Set<string>;
  let hub: McpHub;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mainbot-notify-"));
    settings = new SettingsStore(dir);
    usage = new UsageStore(dir);
    callTool = vi.fn(async () => ({ text: "sent", isError: false, durationMs: 3 }));
    tools = new Set(["crm__send_whatsapp", "crm__send_email", "yemot__send_sms"]);
    hub = { tool: (n: string) => (tools.has(n) ? { fullName: n } : undefined), callTool } as unknown as McpHub;
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("renders templates with owner variables", () => {
    const out = renderTemplate({ to: "{{ownerPhoneIntl}}", message: "שלום {{text}}", confirm: true, list: ["{{ownerEmail}}"] }, { text: "עולם", ownerPhoneIntl: "972501234567", ownerEmail: "a@b.c" });
    expect(out).toEqual({ to: "972501234567", message: "שלום עולם", confirm: true, list: ["a@b.c"] });
  });

  it("sends through the channel template and records usage", async () => {
    settings.update({ ownerPhone: "050-123-4567", ownerEmail: "owner@example.com" });
    const n = new Notifier(hub, settings, usage, fakeLogger().logger);
    const wa = await n.send("whatsapp", "יש 3 לידים חדשים", { source: "routine:rt_1", callId: "run-1" });
    expect(wa).toEqual({ ok: true, channel: "whatsapp", detail: "sent" });
    expect(callTool).toHaveBeenLastCalledWith("crm__send_whatsapp", { to: "972501234567", message: "יש 3 לידים חדשים" });

    const sms = await n.send("sms", "טקסט", { source: "routine:rt_1", callId: "run-1" });
    expect(sms.ok).toBe(true);
    expect(callTool).toHaveBeenLastCalledWith("yemot__send_sms", { phones: "0501234567", message: "טקסט", confirm: true });

    const mail = await n.send("email", "גוף", { subject: "נושא", source: "routine:rt_1", callId: "run-1" });
    expect(mail.ok).toBe(true);
    expect(callTool).toHaveBeenLastCalledWith("crm__send_email", { to: "owner@example.com", subject: "נושא", content: "גוף" });

    const log = await n.send("log", "רק ביומן", { source: "admin", callId: "run-2" });
    expect(log.ok).toBe(true);
    expect(callTool).toHaveBeenCalledTimes(3);

    const events = usage.notifications(10);
    expect(events.map((e) => [e.channel, e.ok])).toEqual([["log", true], ["email", true], ["sms", true], ["whatsapp", true]]);
    expect(usage.callEvents("run-1").filter((e) => e.kind === "tool")).toHaveLength(3);
  });

  it("fails cleanly when the owner contact or the tool is missing, or the tool errors", async () => {
    const n = new Notifier(hub, settings, usage, fakeLogger().logger);
    expect(await n.send("whatsapp", "x", { source: "s", callId: "c" })).toMatchObject({ ok: false, detail: expect.stringContaining("ownerPhone") });
    expect(await n.send("email", "x", { source: "s", callId: "c" })).toMatchObject({ ok: false, detail: expect.stringContaining("ownerEmail") });
    settings.update({ ownerPhone: "0501234567" });
    tools.delete("crm__send_whatsapp");
    expect(await n.send("whatsapp", "x", { source: "s", callId: "c" })).toMatchObject({ ok: false, detail: expect.stringContaining("crm__send_whatsapp") });
    callTool.mockResolvedValueOnce({ text: "boom", isError: true, durationMs: 1 });
    expect(await n.send("sms", "x", { source: "s", callId: "c" })).toEqual({ ok: false, channel: "sms", detail: "boom" });
    expect(usage.notifications(10).every((e) => !e.ok)).toBe(true);
  });

  it("honours custom templates from settings", async () => {
    settings.update({ ownerPhone: "0501234567", notifyTemplates: { ...settings.get().notifyTemplates, whatsapp: { server: "yemot", tool: "send_sms", args: { phones: "{{ownerPhone}}", message: "WA: {{text}}" } } } });
    const n = new Notifier(hub, settings, usage, fakeLogger().logger);
    expect((await n.send("whatsapp", "היי", { source: "s", callId: "c" })).ok).toBe(true);
    expect(callTool).toHaveBeenLastCalledWith("yemot__send_sms", { phones: "0501234567", message: "WA: היי" });
  });
});

describe("RoutineRunner", () => {
  let dir: string;
  let settings: SettingsStore;
  let usage: UsageStore;
  let store: RoutineStore;
  let respond: ReturnType<typeof vi.fn>;
  let newConversation: ReturnType<typeof vi.fn>;
  let agent: VoiceAgent;
  let logs: ReturnType<typeof fakeLogger>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mainbot-runner-"));
    settings = new SettingsStore(dir);
    usage = new UsageStore(dir);
    store = new RoutineStore(dir);
    newConversation = vi.fn((callId: string, phone: string, opts: { channel?: string; routine?: { id: string; channel: string } }) => ({ callId, phone, channel: opts.channel, routineId: opts.routine?.id, routineChannel: opts.routine?.channel, notifications: [] as Array<{ channel: string; ok: boolean; detail: string }>, messages: [], turn: 0 }) as unknown as ConversationState);
    respond = vi.fn(async (conv: ConversationState, _text: string): Promise<AgentReply> => {
      conv.notifications.push({ channel: "log", ok: true, detail: "logged" });
      return { text: "בדקתי, יש 2 לידים", endCall: false, iterations: 2, toolCalls: ["crm__list_contacts"], durationMs: 5 };
    });
    agent = { newConversation, respond } as unknown as VoiceAgent;
    logs = fakeLogger();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const runner = () => new RoutineRunner({ store, agent, usage, settings, logger: logs.logger, timeZone: TZ, tickMs: 60_000 });

  it("runs a routine as a proactive conversation and records the result", async () => {
    const r = store.add({ name: "לידים", schedule: { kind: "manual" }, prompt: "בדוק לידים חדשים", channel: "whatsapp" }, "admin");
    const result = await runner().run(r.id, { kind: "manual" });
    expect(result).toMatchObject({ trigger: "manual", ok: true, notified: true, text: "בדקתי, יש 2 לידים", toolCalls: ["crm__list_contacts"] });
    expect(newConversation).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^routine-${r.id}-\\d+$`)), `routine:${r.id}`, { channel: "proactive", routine: { id: r.id, channel: "whatsapp" } });
    const [, message, ctx] = respond.mock.calls[0]! as [ConversationState, string, { phone: string; channel: string; userName: string }];
    expect(message).toContain('[משימה יזומה] "לידים"');
    expect(message).toContain("ידני בלבד");
    expect(message).toContain("ערוץ ההודעה: whatsapp");
    expect(message).toContain("בדוק לידים חדשים");
    expect(message).toContain("notify_owner");
    expect(ctx).toMatchObject({ phone: `routine:${r.id}`, userName: "משימה: לידים" });
    expect(store.get(r.id)).toMatchObject({ lastRunAt: result.at, lastResult: { ok: true, notified: true } });
    expect(usage.routineRuns(r.id)).toEqual([expect.objectContaining({ kind: "routine", routineId: r.id, name: "לידים", trigger: "manual", ok: true, notified: true })]);
  });

  it("records agent errors and crashes without breaking the queue", async () => {
    const r = store.add({ name: "a", schedule: { kind: "manual" }, prompt: "בדוק" }, "admin");
    respond.mockResolvedValueOnce({ text: "משהו השתבש", endCall: false, iterations: 1, toolCalls: [], durationMs: 1, error: "boom" });
    const failed = await runner().run(r.id, { kind: "manual" });
    expect(failed).toMatchObject({ ok: false, notified: false, error: "boom" });

    respond.mockRejectedValueOnce(new Error("crashed"));
    const rn = runner();
    const crashed = await rn.run(r.id, { kind: "manual" });
    expect(crashed).toMatchObject({ ok: false, error: "crashed" });
    const ok = await rn.run(r.id, { kind: "manual" });
    expect(ok.ok).toBe(true);
    expect(await rn.run("rt_missing", { kind: "manual" })).toMatchObject({ ok: false, error: "routine not found" });
    expect(usage.routineRuns(r.id)).toHaveLength(3);
  });

  it("serialises concurrent runs", async () => {
    const a = store.add({ name: "a", schedule: { kind: "manual" }, prompt: "בדוק" }, "admin");
    const b = store.add({ name: "b", schedule: { kind: "manual" }, prompt: "בדוק" }, "admin");
    const order: string[] = [];
    respond.mockImplementation(async (conv: ConversationState) => {
      order.push(`start:${conv.phone}`);
      await new Promise((res) => setTimeout(res, 20));
      order.push(`end:${conv.phone}`);
      return { text: "ok", endCall: false, iterations: 1, toolCalls: [], durationMs: 20 };
    });
    const rn = runner();
    await Promise.all([rn.run(a.id, { kind: "manual" }), rn.run(b.id, { kind: "manual" })]);
    expect(order).toEqual([`start:routine:${a.id}`, `end:routine:${a.id}`, `start:routine:${b.id}`, `end:routine:${b.id}`]);
  });

  it("fires cron and interval routines when due, once per minute, outside quiet hours", async () => {
    const cron = store.add({ name: "בוקר", schedule: { kind: "cron", expression: "0 8 * * 0-4" }, prompt: "תדריך" }, "admin");
    const every = store.add({ name: "כל 30", schedule: { kind: "interval", everyMinutes: 30 }, prompt: "בדוק" }, "admin");
    const off = store.add({ name: "כבויה", enabled: false, schedule: { kind: "cron", expression: "* * * * *" }, prompt: "בדוק משהו" }, "admin");
    const manual = store.add({ name: "ידני", schedule: { kind: "manual" }, prompt: "בדוק משהו" }, "admin");
    const rn = runner();
    const sunday8 = new Date("2026-09-06T05:00:00Z");

    expect(rn.isDue(store.get(off.id)!, sunday8)).toBe(false);
    expect(rn.isDue(store.get(manual.id)!, sunday8)).toBe(false);
    expect(rn.isDue(store.get(cron.id)!, sunday8)).toBe(true);
    expect(rn.isDue(store.get(cron.id)!, new Date("2026-09-06T05:01:00Z"))).toBe(false);
    expect(rn.isDue(store.get(every.id)!, sunday8)).toBe(true); // never ran

    const started = await rn.tick(sunday8);
    expect(started.sort()).toEqual([cron.id, every.id].sort());
    // same minute again: nothing new
    expect(await rn.tick(new Date("2026-09-06T05:00:30Z"))).toEqual([]);
    await rn.run(manual.id, { kind: "manual" }); // drain the queue
    expect(respond).toHaveBeenCalledTimes(3);

    // interval: 29 minutes later not due, 30 minutes later due
    expect(rn.isDue(store.get(every.id)!, new Date(Date.parse(store.get(every.id)!.lastRunAt!) + 29 * 60_000))).toBe(false);
    expect(rn.isDue(store.get(every.id)!, new Date(Date.parse(store.get(every.id)!.lastRunAt!) + 30 * 60_000))).toBe(true);

    // next run of the cron routine: Monday 08:00 Israel
    expect(rn.nextRunAt(store.get(cron.id)!, sunday8)?.toISOString()).toBe("2026-09-07T05:00:00.000Z");
    expect(rn.nextRunAt(store.get(off.id)!, sunday8)).toBeNull();
    expect(rn.nextRunAt(store.get(manual.id)!, sunday8)).toBeNull();

    // quiet hours (global 22:00-07:00): a 23:00 cron is skipped
    const night = store.add({ name: "לילה", schedule: { kind: "cron", expression: "0 23 * * *" }, prompt: "בדוק משהו" }, "admin");
    expect(await rn.tick(new Date("2026-09-06T20:00:00Z"))).toEqual([]);
    expect(logs.log.info).toHaveBeenCalledWith({ routine: night.id }, "routine skipped: quiet hours");
    // per-routine quiet hours override the global ones
    store.update(night.id, { quietHours: { from: "01:00", to: "05:00" } });
    expect(await rn.tick(new Date("2026-09-07T20:00:00Z"))).toEqual([night.id]);
    await rn.run(manual.id, { kind: "manual" });

    // master switch
    settings.update({ routinesEnabled: false });
    expect(await rn.tick(new Date("2026-09-08T20:00:00Z"))).toEqual([]);
  });

  it("dispatches events to subscribed routines with the payload", async () => {
    const lead = store.add({ name: "ליד", schedule: { kind: "event", eventTypes: ["new_lead"] }, prompt: "בדוק ליד" }, "admin");
    const all = store.add({ name: "הכל", schedule: { kind: "event", eventTypes: ["*"] }, prompt: "בדוק משהו" }, "admin");
    const other = store.add({ name: "אחר", schedule: { kind: "event", eventTypes: ["payment"] }, prompt: "בדוק משהו" }, "admin");
    store.add({ name: "כבוי", enabled: false, schedule: { kind: "event", eventTypes: ["new_lead"] }, prompt: "בדוק משהו" }, "admin");
    const rn = runner();
    expect(rn.dispatchEvent("new_lead", { name: "דני", phone: "0501234567" }).sort()).toEqual([lead.id, all.id].sort());
    await rn.run(other.id, { kind: "manual" }); // queued behind the two event runs: waits for them
    const message = respond.mock.calls[0]![1] as string;
    expect(message).toContain('הופעלה על ידי אירוע "new_lead"');
    expect(message).toContain('{"name":"דני","phone":"0501234567"}');
    expect(store.get(lead.id)?.lastResult?.trigger).toBe("event:new_lead");
    expect(rn.dispatchEvent("unknown", {})).toEqual([all.id]);
  });

  it("builds a readable run message", () => {
    const r = store.add({ name: "בדיקה", schedule: { kind: "interval", everyMinutes: 15 }, prompt: "  בדוק משהו  ", channel: "sms" }, "admin");
    const m = buildRunMessage(r, { kind: "schedule" });
    expect(m.split("\n")[0]).toBe('[משימה יזומה] "בדיקה" (כל 15 דקות), ערוץ ההודעה: sms.');
    expect(m).toContain("הופעלה לפי לוח הזמנים.");
    expect(m).toContain("ההנחיה:\nבדוק משהו");
    expect(m).not.toContain("נתוני האירוע");
    expect(buildRunMessage(r, { kind: "event", eventType: "x", payload: "raw text" })).toContain("נתוני האירוע:\nraw text");
  });

  it("start/stop installs and clears the interval timer", () => {
    vi.useFakeTimers();
    try {
      const rn = runner();
      rn.start();
      rn.start(); // idempotent
      expect(vi.getTimerCount()).toBe(1);
      rn.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
