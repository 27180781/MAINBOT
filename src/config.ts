import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

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

export const env = {
  port: envInt("PORT", 3000),
  host: process.env.HOST ?? "0.0.0.0",
  publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? "").replace(/\/+$/, ""),
  webhookSecret: process.env.WEBHOOK_SECRET ?? "",
  adminUser: process.env.ADMIN_USER ?? "",
  adminPassword: process.env.ADMIN_PASSWORD ?? "",
  dataDir: path.resolve(process.env.DATA_DIR ?? "./data"),
  mcpConfigPath: path.resolve(process.env.MCP_CONFIG_PATH ?? "./config/mcp-servers.json"),
  mcpAuthDir: path.resolve(process.env.MCP_AUTH_DIR ?? "./.mcp-auth"),
  instructionsPath: path.resolve(process.env.INSTRUCTIONS_PATH ?? "./config/instructions.md"),
  timezone: process.env.TIMEZONE ?? "Asia/Jerusalem",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  /** Max wall-clock time a single PBX request may wait for the agent before a filler is sent. */
  pbxLongPollMs: envInt("PBX_LONG_POLL_MS", 20_000),
  /** Upper bound for one agent turn (all tool calls included). */
  agentTimeoutMs: envInt("AGENT_TIMEOUT_MS", 180_000),
  /** Upper bound for one MCP tool call. */
  toolTimeoutMs: envInt("TOOL_TIMEOUT_MS", 60_000),
  maxToolResultChars: envInt("MAX_TOOL_RESULT_CHARS", 20_000),
  sessionTtlMs: envInt("SESSION_TTL_MS", 30 * 60_000),
  oauthCallbackPort: envInt("MCP_OAUTH_CALLBACK_PORT", 8765),
  trustProxy: envBool("TRUST_PROXY", true),
};

/* ------------------------------------------------------------------ */
/* Runtime settings (editable from the admin UI, persisted to disk)    */
/* ------------------------------------------------------------------ */

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export const SettingsSchema = z.object({
  model: z.string().min(1).default(process.env.BOT_MODEL || "claude-opus-5"),
  effort: z.enum(EFFORT_LEVELS).default((process.env.BOT_EFFORT as Effort) || "medium"),
  maxTokens: z.number().int().min(256).max(64_000).default(envInt("BOT_MAX_TOKENS", 4096)),
  /** "default" enables Anthropic's server-side refusal fallback chain; "off" disables it. */
  fallbacks: z.enum(["default", "off"]).default((process.env.BOT_FALLBACKS as "default" | "off") || "default"),
  toolSearch: z.boolean().default(envBool("TOOL_SEARCH", true)),
  toolSearchVariant: z.enum(["regex", "bm25"]).default("regex"),
  /** Hard cap on Claude round-trips within one caller turn. */
  maxIterationsPerTurn: z.number().int().min(1).max(50).default(12),
  ttsVoice: z.string().default(process.env.TTS_VOICE ?? ""),
  greeting: z.string().default(process.env.GREETING ?? "שלום, כאן העוזר החכם. אחרי הצפצוף אמרו במה אוכל לעזור."),
  goodbye: z.string().default("להתראות."),
  fillerMode: z.enum(["tts", "silence"]).default("tts"),
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
  blockedTools: z.array(z.string()).default([
    "__delete_",
    "hangup_all_active_calls",
    "clear_campaign_entries",
    "transfer_units",
    "bulk_update_contacts",
    "merge_pull_request",
    "create_repository",
  ]),
  sttMaxSeconds: z.number().int().min(1).max(10).default(envInt("STT_MAX_SECONDS", 10)),
  maxTurns: z.number().int().min(1).max(500).default(60),
  maxSilentTurns: z.number().int().min(1).max(10).default(2),
  extraInstructions: z.string().default(""),
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
      merged.allowedPhones = (merged.allowedPhones as string[]).map((p) => p.trim()).filter(Boolean);
    }
    this.settings = SettingsSchema.parse(merged);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.settings, null, 2), "utf8");
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
  return allowed.some((a) => normalizePhone(a) === p);
}
