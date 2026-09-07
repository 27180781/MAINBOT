import type { Logger } from "../logger.js";
import type { McpHub } from "../mcp/hub.js";
import { toolFullName } from "../mcp/hub.js";
import type { SettingsStore } from "../config.js";
import { normalizePhone } from "../config.js";
import type { UsageStore } from "../usage/usage-store.js";
import type { NotifyChannel } from "./store.js";

/** How a channel maps onto an MCP tool. Strings may use {{text}}, {{subject}}, {{ownerPhone}}, {{ownerPhoneIntl}}, {{ownerEmail}}. */
export interface NotifyTemplate {
  server: string;
  tool: string;
  args: Record<string, unknown>;
}

export const DEFAULT_NOTIFY_TEMPLATES: Record<string, NotifyTemplate> = {
  whatsapp: { server: "crm", tool: "send_whatsapp", args: { to: "{{ownerPhoneIntl}}", message: "{{text}}" } },
  sms: { server: "yemot", tool: "send_sms", args: { phones: "{{ownerPhone}}", message: "{{text}}", confirm: true } },
  email: { server: "crm", tool: "send_email", args: { to: "{{ownerEmail}}", subject: "{{subject}}", content: "{{text}}" } },
};

export interface NotifyOutcome {
  ok: boolean;
  channel: NotifyChannel;
  detail: string;
}

export function renderTemplate(value: unknown, vars: Record<string, string>): unknown {
  if (typeof value === "string") {
    const whole = /^\{\{(\w+)\}\}$/.exec(value.trim());
    if (whole && vars[whole[1]!] !== undefined) return vars[whole[1]!];
    return value.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? "");
  }
  if (Array.isArray(value)) return value.map((v) => renderTemplate(v, vars));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = renderTemplate(v, vars);
    return out;
  }
  return value;
}

/** Sends a message to the business owner through one of the connected MCP servers. */
export class Notifier {
  constructor(
    private readonly hub: McpHub,
    private readonly settings: SettingsStore,
    private readonly usage: UsageStore,
    private readonly logger: Logger,
  ) {}

  templateFor(channel: NotifyChannel): NotifyTemplate | null {
    if (channel === "log") return null;
    const s = this.settings.get();
    const t = (s.notifyTemplates as Record<string, NotifyTemplate | undefined>)[channel] ?? DEFAULT_NOTIFY_TEMPLATES[channel];
    return t ?? null;
  }

  vars(text: string, subject?: string): Record<string, string> {
    const s = this.settings.get();
    const phone = normalizePhone(s.ownerPhone);
    return {
      text,
      subject: subject ?? "עדכון מהעוזר החכם",
      ownerPhone: phone,
      ownerPhoneIntl: phone.startsWith("0") ? `972${phone.slice(1)}` : phone,
      ownerEmail: s.ownerEmail,
    };
  }

  async send(channel: NotifyChannel, text: string, opts: { subject?: string; source: string; callId: string }): Promise<NotifyOutcome> {
    const preview = text.slice(0, 300);
    if (channel === "log") {
      this.usage.recordNotification({ callId: opts.callId, phone: opts.source, channel, ok: true, detail: "logged only", text: preview });
      return { ok: true, channel, detail: "נרשם ביומן (ערוץ log)" };
    }
    const s = this.settings.get();
    if ((channel === "whatsapp" || channel === "sms") && !normalizePhone(s.ownerPhone)) {
      return this.fail(channel, "ownerPhone is not set in the admin settings", opts, preview);
    }
    if (channel === "email" && !s.ownerEmail) return this.fail(channel, "ownerEmail is not set in the admin settings", opts, preview);
    const template = this.templateFor(channel);
    if (!template) return this.fail(channel, `no template for channel ${channel}`, opts, preview);
    const fullName = toolFullName(template.server, template.tool);
    if (!this.hub.tool(fullName)) return this.fail(channel, `tool ${fullName} is not available (server not connected?)`, opts, preview);
    const args = renderTemplate(template.args, this.vars(text, opts.subject)) as Record<string, unknown>;
    const outcome = await this.hub.callTool(fullName, args);
    this.usage.recordTool({ callId: opts.callId, phone: opts.source, tool: fullName, server: template.server, durationMs: outcome.durationMs, ok: !outcome.isError });
    this.usage.recordNotification({ callId: opts.callId, phone: opts.source, channel, ok: !outcome.isError, detail: outcome.text.slice(0, 300), text: preview });
    if (outcome.isError) {
      this.logger.warn({ channel, tool: fullName, err: outcome.text.slice(0, 300) }, "notification failed");
      return { ok: false, channel, detail: outcome.text.slice(0, 300) };
    }
    this.logger.info({ channel, tool: fullName }, "notification sent");
    return { ok: true, channel, detail: outcome.text.slice(0, 300) };
  }

  private fail(channel: NotifyChannel, detail: string, opts: { source: string; callId: string }, preview: string): NotifyOutcome {
    this.logger.warn({ channel, detail }, "notification not sent");
    this.usage.recordNotification({ callId: opts.callId, phone: opts.source, channel, ok: false, detail, text: preview });
    return { ok: false, channel, detail };
  }
}
