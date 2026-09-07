import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import dotenv from "dotenv";

// quiet: dotenv v17 otherwise prints an "injected env" banner on stdout at import time (breaks --json CLIs).
// Skipped under vitest so a populated .env on a developer's or operator's machine cannot change test results.
if (!process.env.VITEST) dotenv.config({ quiet: true });

/* ------------------------------------------------------------------ */
/* Environment (static, read once at boot)                             */
/* ------------------------------------------------------------------ */

function envInt(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function envBool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

/** Boot-time warnings about clamped or suspicious values (logged by the server). */
const warnings: string[] = [];

function clampInt(name: string, value: number, min: number, max: number): number {
  if (value < min || value > max) {
    const clamped = Math.min(Math.max(value, min), max);
    warnings.push(`${name}=${value} is outside ${min}-${max}; using ${clamped}`);
    return clamped;
  }
  return value;
}

const webhookSecret = process.env.WEBHOOK_SECRET ?? "";
if (webhookSecret.length > 1000) warnings.push("WEBHOOK_SECRET is longer than 1000 characters; the PBX route would answer 414 - use a shorter secret");

export const env = {
  warnings,
  port: envInt("PORT", 3000),
  host: process.env.HOST ?? "0.0.0.0",
  publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? "").replace(/\/+$/, ""),
  webhookSecret,
  adminUser: process.env.ADMIN_USER ?? "",
  adminPassword: process.env.ADMIN_PASSWORD ?? "",
  dataDir: path.resolve(process.env.DATA_DIR ?? "./data"),
  mcpConfigPath: path.resolve(process.env.MCP_CONFIG_PATH ?? "./config/mcp-servers.json"),
  mcpAuthDir: path.resolve(process.env.MCP_AUTH_DIR ?? "./.mcp-auth"),
  instructionsPath: path.resolve(process.env.INSTRUCTIONS_PATH ?? "./config/instructions.md"),
  timezone: process.env.TIMEZONE ?? "Asia/Jerusalem",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  /** Max wall-clock time a single PBX request may wait for the agent before a filler is sent (PBX times out at ~30 s). */
  pbxLongPollMs: clampInt("PBX_LONG_POLL_MS", envInt("PBX_LONG_POLL_MS", 20_000), 1_000, 25_000),
  /** Wait on the request that carries the utterance itself; fast answers need no filler at all. */
  pbxFirstPollMs: clampInt("PBX_FIRST_POLL_MS", envInt("PBX_FIRST_POLL_MS", 6_000), 500, 25_000),
  /** Upper bound for one agent turn (all tool calls included). */
  agentTimeoutMs: envInt("AGENT_TIMEOUT_MS", 180_000),
  /** Upper bound for one MCP tool call. */
  toolTimeoutMs: envInt("TOOL_TIMEOUT_MS", 60_000),
  maxToolResultChars: envInt("MAX_TOOL_RESULT_CHARS", 20_000),
  sessionTtlMs: envInt("SESSION_TTL_MS", 30 * 60_000),
  oauthCallbackPort: envInt("MCP_OAUTH_CALLBACK_PORT", 8765),
  trustProxy: envBool("TRUST_PROXY", true),
  /** Bearer key for the text-chat API used by the CRM (empty = API disabled). */
  chatApiKey: process.env.CHAT_API_KEY ?? "",
  /** Bearer key for /internal/* endpoints used by sibling services such as the realtime voice agent. */
  internalApiKey: process.env.INTERNAL_API_KEY ?? "",
  chatCorsOrigins: (process.env.CHAT_CORS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  chatSessionTtlMs: envInt("CHAT_SESSION_TTL_MS", 2 * 60 * 60_000),
};

/* ------------------------------------------------------------------ */
/* Runtime settings (editable from the admin UI, persisted to disk)    */
/* ------------------------------------------------------------------ */

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

/**
 * Tools the assistant may never call. `_delete_` (not `__delete_`) also catches vendor-prefixed
 * names such as `sumit__sumit_crm_delete_entity`; the SUMIT money-moving/removal tools are
 * listed explicitly because their names carry no delete verb.
 */
export const DEFAULT_BLOCKED_TOOLS = [
  "_delete_",
  "hangup_all_active_calls",
  "clear_campaign_entries",
  "transfer_units",
  "bulk_update_contacts",
  "merge_pull_request",
  "create_repository",
  "sumit_(documents|recurring)_cancel",
  "sumit_payments_refund",
  "sumit_(permissions|payment_methods)_remove",
] as const;

export const SettingsSchema = z.object({
  model: z.string().min(1).default(process.env.BOT_MODEL || "claude-opus-5"),
  effort: z.enum(EFFORT_LEVELS).default((process.env.BOT_EFFORT as Effort) || "medium"),
  /** Shared between adaptive thinking and the spoken answer, so leave thinking room. */
  maxTokens: z.number().int().min(256).max(64_000).default(envInt("BOT_MAX_TOKENS", 8192)),
  /** "default" enables Anthropic's server-side refusal fallback chain; "off" disables it. */
  fallbacks: z.enum(["default", "off"]).default((process.env.BOT_FALLBACKS as "default" | "off") || "default"),
  toolSearch: z.boolean().default(envBool("TOOL_SEARCH", true)),
  toolSearchVariant: z.enum(["regex", "bm25"]).default("regex"),
  /** Hard cap on Claude round-trips within one caller turn. */
  maxIterationsPerTurn: z.number().int().min(1).max(50).default(12),
  ttsVoice: z.string().default(process.env.TTS_VOICE ?? ""),
  greeting: z.string().default(process.env.GREETING ?? "שלום, כאן העוזר החכם. אחרי הצפצוף אמרו במה אוכל לעזור."),
  goodbye: z.string().default("להתראות."),
  /**
   * What the caller hears while Claude works: a spoken "one moment" (tts), a silent
   * clip (silence) or the PBX hold music via a 1-second simpleMenu with setMusic (music).
   */
  fillerMode: z.enum(["tts", "silence", "music"]).default("tts"),
  allowedPhones: z.array(z.string()).default(
    (process.env.ALLOWED_CALLER_PHONES ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ),
  /** SHA-256 hex of the PIN, empty = no PIN. */
  pinHash: z.string().default(process.env.BOT_PIN ? sha256(process.env.BOT_PIN) : ""),
  maxPinAttempts: z.number().int().min(1).max(10).default(3),
  confirmWrites: z.boolean().default(envBool("CONFIRM_WRITE_ACTIONS", true)),
  /** Regex patterns (matched against the full tool name) that are never callable from the phone. */
  blockedTools: z.array(z.string()).default([...DEFAULT_BLOCKED_TOOLS]),
  sttMaxSeconds: z.number().int().min(1).max(10).default(envInt("STT_MAX_SECONDS", 10)),
  /** Every turn adds ~1 KB to the query string the PBX re-sends; 150 turns stay far below the 512 KB header budget. */
  maxTurns: z.number().int().min(1).max(150).default(60),
  maxSilentTurns: z.number().int().min(1).max(10).default(2),
  extraInstructions: z.string().default(""),

  /* ---- proactive routines & owner notifications ---- */
  routinesEnabled: z.boolean().default(true),
  /** The owner's phone for WhatsApp / SMS notifications (any Israeli format). */
  ownerPhone: z.string().default(process.env.OWNER_PHONE ?? ""),
  ownerEmail: z.string().default(process.env.OWNER_EMAIL ?? ""),
  /** Default delivery channel for routines created by voice/chat. */
  notifyChannel: z.enum(["log", "whatsapp", "sms", "email"]).default("log"),
  /** Per-channel MCP tool templates ({{text}}, {{subject}}, {{ownerPhone}}, {{ownerPhoneIntl}}, {{ownerEmail}}). */
  notifyTemplates: z
    .record(z.string(), z.object({ server: z.string().min(1), tool: z.string().min(1), args: z.record(z.string(), z.unknown()) }))
    .default({
      whatsapp: { server: "crm", tool: "send_whatsapp", args: { to: "{{ownerPhoneIntl}}", message: "{{text}}" } },
      sms: { server: "yemot", tool: "send_sms", args: { phones: "{{ownerPhone}}", message: "{{text}}", confirm: true } },
      email: { server: "crm", tool: "send_email", args: { to: "{{ownerEmail}}", subject: "{{subject}}", content: "{{text}}" } },
    }),
  /** Scheduled routines do not run inside this window (local time). */
  quietHours: z.object({ from: z.string().regex(/^\d{1,2}:\d{2}$/), to: z.string().regex(/^\d{1,2}:\d{2}$/) }).default({ from: "22:00", to: "07:00" }),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type SettingsPatch = Partial<Settings> & { pin?: string | null };

export function sha256(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

export class SettingsStore {
  private settings: Settings;
  private readonly file: string;
  private listeners: Array<(s: Settings) => void> = [];

  constructor(dataDir: string = env.dataDir) {
    this.file = path.join(dataDir, "settings.json");
    let stored: unknown = {};
    try {
      if (fs.existsSync(this.file)) stored = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      stored = {};
    }
    const parsed = SettingsSchema.safeParse(stored);
    this.settings = parsed.success ? parsed.data : SettingsSchema.parse({});
    // Older settings files stored the narrower "__delete_" pattern; widen it in place.
    if (this.settings.blockedTools.includes("__delete_")) {
      this.settings = { ...this.settings, blockedTools: this.settings.blockedTools.map((p) => (p === "__delete_" ? "_delete_" : p)) };
      try {
        this.persist();
      } catch {
        /* read-only data dir: keep the migrated list in memory */
      }
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.settings, null, 2), "utf8");
    fs.renameSync(tmp, this.file);
  }

  get(): Settings {
    return this.settings;
  }

  onChange(fn: (s: Settings) => void): void {
    this.listeners.push(fn);
  }

  update(patch: SettingsPatch): Settings {
    const { pin, ...rest } = patch;
    const merged: Record<string, unknown> = { ...this.settings, ...rest };
    if (pin !== undefined) merged.pinHash = pin ? sha256(pin) : "";
    if (Array.isArray(merged.allowedPhones)) {
      // Only real numbers (or "*") are kept: a label such as "בעל העסק" normalises to "" and
      // would otherwise match a withheld caller-ID.
      merged.allowedPhones = (merged.allowedPhones as string[]).map((p) => p.trim()).filter((p) => p === "*" || normalizePhone(p).length > 0);
    }
    this.settings = SettingsSchema.parse(merged);
    this.persist();
    for (const fn of this.listeners) fn(this.settings);
    return this.settings;
  }

  /** Public view: never leaks the PIN hash. */
  public view(): Omit<Settings, "pinHash"> & { hasPin: boolean } {
    const { pinHash, ...rest } = this.settings;
    return { ...rest, hasPin: pinHash.length > 0 };
  }
}

/* ------------------------------------------------------------------ */
/* Phone helpers                                                        */
/* ------------------------------------------------------------------ */

/** Normalises Israeli numbers so 0501234567, +972501234567 and 972-50-123-4567 compare equal. */
export function normalizePhone(raw: string): string {
  let digits = (raw ?? "").replace(/\D/g, "");
  if (digits.startsWith("972")) digits = "0" + digits.slice(3);
  if (digits.length === 9 && !digits.startsWith("0")) digits = "0" + digits;
  return digits;
}

export function isPhoneAllowed(phone: string, allowed: string[]): boolean {
  if (allowed.length === 0) return false;
  if (allowed.includes("*")) return true;
  const p = normalizePhone(phone);
  // A withheld / missing caller-ID never matches, and neither does a list entry without digits.
  if (!p) return false;
  return allowed.some((a) => a !== "*" && normalizePhone(a) === p);
}
