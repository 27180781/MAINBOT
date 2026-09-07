import type Anthropic from "@anthropic-ai/sdk";
import type { RulesStore } from "./rules.js";
import type { RoutineStore, RoutineSchedule, NotifyChannel } from "../routines/store.js";
import { NOTIFY_CHANNELS } from "../routines/store.js";
import type { Notifier } from "../routines/notify.js";

export const END_CALL_TOOL = "end_call";
export const LIST_RULES_TOOL = "list_rules";
export const ADD_RULE_TOOL = "add_rule";
export const UPDATE_RULE_TOOL = "update_rule";
export const REMOVE_RULE_TOOL = "remove_rule";
export const LIST_ROUTINES_TOOL = "list_routines";
export const ADD_ROUTINE_TOOL = "add_routine";
export const REMOVE_ROUTINE_TOOL = "remove_routine";
export const TOGGLE_ROUTINE_TOOL = "toggle_routine";
export const NOTIFY_OWNER_TOOL = "notify_owner";

/** Local tools that change persisted state and therefore go through the confirmation gate. */
export const LOCAL_WRITE_TOOLS = new Set([ADD_RULE_TOOL, UPDATE_RULE_TOOL, REMOVE_RULE_TOOL, ADD_ROUTINE_TOOL, REMOVE_ROUTINE_TOOL, TOGGLE_ROUTINE_TOOL]);

const SCHEDULE_HELP =
  "Schedules: cron expressions are 5 fields in Israel time (minute hour day month weekday, weekday 0=Sunday): every morning 08:00 = '0 8 * * *'; weekdays Sunday-Thursday at 09:00 = '0 9 * * 0-4'; every hour during work hours = '0 9-18 * * 0-4'; every Friday 12:00 = '0 12 * * 5'. interval = every N minutes (min 5). event = runs when the CRM/other system posts that event type. manual = only when the owner runs it.";

/** Tools implemented inside the bot itself (not from MCP). Always loaded in interactive calls/chats. */
export const LOCAL_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: END_CALL_TOOL,
    description:
      "Ends the phone call after your current message is spoken. Call it when the caller says goodbye or that they are done, in the same response as your farewell sentence.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: LIST_RULES_TOOL,
    description:
      "Lists the standing rules (the assistant's permanent skill) that the owner dictated in earlier calls, with their numbers. The same rules are already in your instructions; use this only when the caller asks what rules exist or which number a rule has.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: ADD_RULE_TOOL,
    description:
      "Saves a new permanent rule for yourself, written in Hebrew as a short imperative sentence (e.g. 'כשמדווחים על לידים, תמיד לציין את הטלפון'). Use it when the owner says things like 'מעכשיו', 'תזכור ש', 'תמיד', 'אף פעם', 'תכתוב לעצמך כלל'. Read the exact rule text back to the caller and get a yes before it is saved; it takes effect from the next call. Never store passwords or secrets in a rule.",
    input_schema: {
      type: "object",
      properties: { text: { type: "string", description: "The rule text in Hebrew, one or two sentences, general enough to apply in future calls." } },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: UPDATE_RULE_TOOL,
    description: "Rewrites the text of an existing permanent rule by its number (see list_rules or the numbered rules in your instructions). Read the new text back and get a yes first.",
    input_schema: {
      type: "object",
      properties: { id: { type: "integer", description: "Rule number" }, text: { type: "string", description: "New rule text in Hebrew" } },
      required: ["id", "text"],
      additionalProperties: false,
    },
  },
  {
    name: REMOVE_RULE_TOOL,
    description: "Deletes a permanent rule by its number. Read the rule back and get a yes first.",
    input_schema: {
      type: "object",
      properties: { id: { type: "integer", description: "Rule number" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: LIST_ROUTINES_TOOL,
    description: "Lists the proactive routines (scheduled or event-driven tasks the assistant runs on its own and reports to the owner), with ids, schedules, channels and last results.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: ADD_ROUTINE_TOOL,
    description:
      "Creates a proactive routine: the assistant will run the given Hebrew instruction on a schedule (or on an event) with read-only access to all systems, and notify the owner only when there is something worth reporting, with concrete suggestions. Use it when the owner says things like 'כל בוקר תשלח לי סיכום', 'תתריע לי אם...', 'פעם בשבוע תבדוק...'. Read back the name, the schedule and the channel and get a yes before creating it. " +
      SCHEDULE_HELP,
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short Hebrew name, e.g. 'תדריך בוקר'" },
        schedule_kind: { type: "string", enum: ["cron", "interval", "event", "manual"] },
        cron_expression: { type: "string", description: "Required when schedule_kind = cron" },
        every_minutes: { type: "integer", description: "Required when schedule_kind = interval (minimum 5)" },
        event_types: { type: "array", items: { type: "string" }, description: "Required when schedule_kind = event, e.g. ['new_lead']" },
        prompt: { type: "string", description: "The Hebrew instruction: what to check, when it is worth notifying, what to suggest. Write it as a complete standalone task." },
        channel: { type: "string", enum: [...NOTIFY_CHANNELS], description: "Delivery channel for the notification. Omit to use the owner's default." },
      },
      required: ["name", "schedule_kind", "prompt"],
      additionalProperties: false,
    },
  },
  {
    name: TOGGLE_ROUTINE_TOOL,
    description: "Enables or disables a routine by id. Confirm with the owner first.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" }, enabled: { type: "boolean" } },
      required: ["id", "enabled"],
      additionalProperties: false,
    },
  },
  {
    name: REMOVE_ROUTINE_TOOL,
    description: "Deletes a routine by id. Read its name back and get a yes first.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
];

/** Extra tool available only in proactive runs (no human on the line). */
export const PROACTIVE_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: NOTIFY_OWNER_TOOL,
    description:
      "Sends a message to the business owner on the routine's channel (WhatsApp / SMS / email / log). Use it at most once per run, only when there is something worth their attention: a short, concrete Hebrew message (a few lines, plain text, no markdown tables), ending with suggested next steps the owner can approve by calling or chatting with you. Do not send 'nothing new' messages.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The message body in Hebrew (up to ~1500 characters)." },
        subject: { type: "string", description: "Subject line (email only)." },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
];

export const LOCAL_TOOL_NAMES = new Set([...LOCAL_TOOLS, ...PROACTIVE_TOOLS].map((t) => t.name));

export interface LocalToolResult {
  text: string;
  isError: boolean;
}

export interface LocalToolContext {
  rules: RulesStore;
  routines?: RoutineStore;
  notifier?: Notifier;
  /** "interactive" (call / chat) or "proactive" (routine run, nobody on the line). */
  mode: "interactive" | "proactive";
  source: string;
  callId: string;
  /** Channel + subject the current routine delivers on (proactive mode). */
  routineChannel?: NotifyChannel;
  defaultChannel: NotifyChannel;
  /** Filled by notify_owner so the runner knows whether the owner was contacted. */
  notifications: Array<{ channel: string; ok: boolean; detail: string }>;
}

/** Executes a local tool (never throws). end_call is handled by the agent itself. */
export async function runLocalTool(name: string, input: Record<string, unknown>, ctx: LocalToolContext): Promise<LocalToolResult> {
  try {
    switch (name) {
      case LIST_RULES_TOOL:
        return { text: ctx.rules.renderForTool(), isError: false };
      case ADD_RULE_TOOL: {
        const rule = ctx.rules.add(String(input.text ?? ""), ctx.source);
        return { text: `נשמר ככלל ${rule.id}: ${rule.text}. הכלל ייכנס לתוקף מהשיחה הבאה.`, isError: false };
      }
      case UPDATE_RULE_TOOL: {
        const rule = ctx.rules.update(Number(input.id), String(input.text ?? ""), ctx.source);
        return { text: `כלל ${rule.id} עודכן: ${rule.text}`, isError: false };
      }
      case REMOVE_RULE_TOOL: {
        const rule = ctx.rules.remove(Number(input.id));
        return { text: `כלל ${rule.id} נמחק: ${rule.text}`, isError: false };
      }
      case LIST_ROUTINES_TOOL:
        if (!ctx.routines) return { text: "Routines are not enabled on this server.", isError: true };
        return { text: ctx.routines.renderForTool(), isError: false };
      case ADD_ROUTINE_TOOL: {
        if (!ctx.routines) return { text: "Routines are not enabled on this server.", isError: true };
        const schedule = scheduleFromInput(input);
        const channel = (typeof input.channel === "string" && (NOTIFY_CHANNELS as readonly string[]).includes(input.channel) ? input.channel : ctx.defaultChannel) as NotifyChannel;
        const routine = ctx.routines.add({ name: String(input.name ?? ""), schedule, prompt: String(input.prompt ?? ""), channel }, ctx.source);
        return { text: `נוצרה משימה ${routine.id} "${routine.name}" (${channel}). היא תרוץ לפי לוח הזמנים ותודיע רק כשיש משהו לדווח.`, isError: false };
      }
      case TOGGLE_ROUTINE_TOOL: {
        if (!ctx.routines) return { text: "Routines are not enabled on this server.", isError: true };
        const r = ctx.routines.update(String(input.id ?? ""), { enabled: Boolean(input.enabled) }, ctx.source);
        return { text: `המשימה "${r.name}" ${r.enabled ? "הופעלה" : "כובתה"}.`, isError: false };
      }
      case REMOVE_ROUTINE_TOOL: {
        if (!ctx.routines) return { text: "Routines are not enabled on this server.", isError: true };
        const r = ctx.routines.remove(String(input.id ?? ""));
        return { text: `המשימה "${r.name}" נמחקה.`, isError: false };
      }
      case NOTIFY_OWNER_TOOL: {
        if (ctx.mode !== "proactive" || !ctx.notifier) return { text: "notify_owner is only available in proactive runs.", isError: true };
        if (ctx.notifications.length >= 1) return { text: "The owner was already notified in this run; do not send a second message.", isError: true };
        const text = String(input.text ?? "").trim().slice(0, 1500);
        if (!text) return { text: "text is required", isError: true };
        const channel = ctx.routineChannel ?? ctx.defaultChannel;
        // Reserve the slot before awaiting: tool calls in one response run in parallel, and two
        // notify_owner calls must not both slip past the once-per-run check.
        const entry = { channel, ok: false, detail: "sending" };
        ctx.notifications.push(entry);
        const outcome = await ctx.notifier.send(channel, text, { subject: typeof input.subject === "string" ? input.subject : undefined, source: ctx.source, callId: ctx.callId });
        entry.channel = outcome.channel;
        entry.ok = outcome.ok;
        entry.detail = outcome.detail;
        return outcome.ok ? { text: `ההודעה נשלחה (${outcome.channel}).`, isError: false } : { text: `Notification failed (${outcome.channel}): ${outcome.detail}`, isError: true };
      }
      default:
        return { text: `Unknown local tool ${name}`, isError: true };
    }
  } catch (err) {
    return { text: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

function scheduleFromInput(input: Record<string, unknown>): RoutineSchedule {
  const kind = String(input.schedule_kind ?? "manual");
  switch (kind) {
    case "cron":
      return { kind: "cron", expression: String(input.cron_expression ?? "") };
    case "interval":
      return { kind: "interval", everyMinutes: Number(input.every_minutes ?? 0) };
    case "event":
      return { kind: "event", eventTypes: Array.isArray(input.event_types) ? input.event_types.map(String) : [] };
    default:
      return { kind: "manual" };
  }
}
