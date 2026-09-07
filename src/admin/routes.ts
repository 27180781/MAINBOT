import crypto from "node:crypto";
import fs from "node:fs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RulesStore } from "../agent/rules.js";
import type { Logger } from "../logger.js";
import { EFFORT_LEVELS, type SettingsStore, type SettingsPatch } from "../config.js";
import type { McpHub } from "../mcp/hub.js";
import type { VoiceAgent, ConversationState } from "../agent/agent.js";
import type { UsageStore } from "../usage/usage-store.js";
import type { SessionStore } from "../calls/session.js";
import type { RoutineStore, RoutineInput } from "../routines/store.js";
import { NOTIFY_CHANNELS } from "../routines/store.js";
import type { RoutineRunner } from "../routines/runner.js";
import type { Notifier } from "../routines/notify.js";
import { MODEL_PRICES } from "../usage/pricing.js";
import { renderAdminPage } from "./ui.js";

export interface AdminDeps {
  settings: SettingsStore;
  hub: McpHub;
  agent: VoiceAgent;
  usage: UsageStore;
  rules: RulesStore;
  sessions: SessionStore;
  /** Proactive routines (optional so the admin works without a scheduler in tests). */
  routines?: RoutineStore;
  runner?: RoutineRunner;
  notifier?: Notifier;
  /** The Chat API key handed to external systems (CRM): where it comes from and how to rotate it. */
  chatApi?: { key: () => string; source: "env" | "generated"; rotate?: () => string };
  logger: Logger;
  adminUser: string;
  adminPassword: string;
  publicBaseUrl: string;
  webhookSecret: string;
  timeZone: string;
  /** config/instructions.md - the editable business instructions. */
  instructionsPath: string;
}

export const TTS_VOICES = [
  { id: "", label: "ברירת מחדל (Google he-IL-Standard-D, ללא עלות)" },
  ...["Charon", "Puck", "Fenrir", "Orus", "Enceladus", "Iapetus", "Umbriel", "Algieba", "Algenib", "Rasalgethi", "Alnilam", "Schedar", "Achird", "Zubenelgenubi", "Sadachbia", "Sadaltager"].map((v) => ({ id: v, label: `${v} (Gemini, גבר, בתשלום)` })),
  ...["Kore", "Zephyr", "Leda", "Aoede", "Callirrhoe", "Autonoe", "Despina", "Erinome", "Laomedeia", "Achernar", "Gacrux", "Pulcherrima", "Vindemiatrix", "Sulafat"].map((v) => ({ id: v, label: `${v} (Gemini, אישה, בתשלום)` })),
];

function require_dirname(file: string): string {
  const idx = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
  return idx > 0 ? file.slice(0, idx) : ".";
}

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function sinceFor(range: string | undefined, timeZone: string): Date | null {
  const now = new Date();
  switch (range) {
    case "today": {
      // Midnight in the configured time zone
      const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(now);
      const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
      const elapsedMs = ((get("hour") % 24) * 3600 + get("minute") * 60 + get("second")) * 1000;
      return new Date(now.getTime() - elapsedMs);
    }
    case "7d":
      return new Date(now.getTime() - 7 * 86_400_000);
    case "30d":
      return new Date(now.getTime() - 30 * 86_400_000);
    default:
      return null;
  }
}

export function registerAdminRoutes(app: FastifyInstance, d: AdminDeps): void {
  const enabled = d.adminUser.length > 0 && d.adminPassword.length > 0;
  const chats = new Map<string, ConversationState>();
  // Conversations snapshot the prompt and tools when they start; drop test chats so the
  // next message reflects the settings/rules the admin just changed.
  d.settings.onChange(() => chats.clear());
  d.rules.onChange(() => chats.clear());

  const requireAuth = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!enabled) {
      return reply.code(503).type("text/plain; charset=utf-8").send("ממשק הניהול כבוי. הגדירו ADMIN_USER ו-ADMIN_PASSWORD בקובץ .env והפעילו מחדש.");
    }
    const header = request.headers.authorization ?? "";
    const [scheme, encoded] = header.split(" ");
    let ok = false;
    if (scheme === "Basic" && encoded) {
      const decoded = Buffer.from(encoded, "base64").toString("utf8");
      const idx = decoded.indexOf(":");
      const user = decoded.slice(0, idx);
      const pass = decoded.slice(idx + 1);
      ok = timingSafeEqual(user, d.adminUser) && timingSafeEqual(pass, d.adminPassword);
    }
    if (!ok) {
      return reply.code(401).header("WWW-Authenticate", 'Basic realm="MAINBOT admin", charset="UTF-8"').send("Unauthorized");
    }
    reply.header("Cache-Control", "no-store");
    // Browsers replay Basic credentials on cross-site form posts. The admin API only ever
    // receives JSON from its own page, so anything else (a form body, an explicit cross-site
    // fetch) is refused before it can change settings, rules or logins.
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      if (request.headers["sec-fetch-site"] === "cross-site") return reply.code(403).send({ ok: false, error: "cross-site request refused" });
      const contentType = String(request.headers["content-type"] ?? "");
      if (contentType && !/^application\/json\b/i.test(contentType)) return reply.code(415).send({ ok: false, error: "the admin API accepts application/json only" });
    }
  };

  app.get("/admin", { preHandler: requireAuth }, async (_req, reply) => {
    return reply
      .type("text/html; charset=utf-8")
      .header("Content-Security-Policy", "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'")
      .header("X-Frame-Options", "DENY")
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .send(renderAdminPage());
  });

  app.get("/admin/api/state", { preHandler: requireAuth }, async () => {
    const tools = d.hub.tools();
    return {
      settings: d.settings.view(),
      servers: d.hub.status().map((s) => ({ ...s, tools: tools.filter((t) => t.server === s.name).map((t) => ({ name: t.name, fullName: t.fullName, kind: t.kind, alwaysLoad: t.alwaysLoad, description: t.description.slice(0, 160) })) })),
      models: MODEL_PRICES,
      effortLevels: EFFORT_LEVELS,
      voices: TTS_VOICES,
      publicBaseUrl: d.publicBaseUrl,
      webhookUrl: `${d.publicBaseUrl || "https://<your-domain>"}/pbx/technoline/${d.webhookSecret || "<WEBHOOK_SECRET>"}`,
      activeCalls: d.sessions.active().map((s) => ({ callId: s.callId, phone: s.phone, startedAt: s.startedAt, turns: s.turns, thinking: !!s.pending })),
      systemPromptChars: d.agent.getSystemPrompt().length,
      toolCount: tools.length,
      routines: listRoutines(),
      notifyChannels: NOTIFY_CHANNELS,
      chatApi: chatApiInfo(),
    };
  });

  /* ---- Chat API key for the CRM / other systems ---- */
  function chatApiInfo() {
    const base = d.publicBaseUrl || "https://<your-domain>";
    const key = d.chatApi?.key() ?? "";
    return {
      enabled: key.length >= 16,
      source: d.chatApi?.source ?? "env",
      canRotate: !!d.chatApi?.rotate,
      chatUrl: `${base}/api/v1/chat`,
      eventsUrl: `${base}/api/v1/events`,
      keyHint: key ? `${key.slice(0, 4)}…${key.slice(-4)}` : "",
    };
  }

  app.get("/admin/api/chat-key", { preHandler: requireAuth }, async () => ({ ...chatApiInfo(), key: d.chatApi?.key() ?? "" }));

  app.post("/admin/api/chat-key/rotate", { preHandler: requireAuth }, async (_req, reply) => {
    if (!d.chatApi?.rotate) return reply.code(409).send({ ok: false, error: "the key comes from CHAT_API_KEY in the environment - change it there" });
    const key = d.chatApi.rotate();
    d.logger.warn("chat API key rotated from the admin UI - external systems must be updated");
    return { ok: true, ...chatApiInfo(), key };
  });

  /* ---- Proactive routines ---- */
  function listRoutines() {
    if (!d.routines) return [];
    return d.routines.list().map((r) => ({
      ...r,
      nextRunAt: d.runner?.nextRunAt(r)?.toISOString() ?? null,
      running: d.runner?.isRunning(r.id) ?? false,
    }));
  }

  app.get("/admin/api/routines", { preHandler: requireAuth }, async () => ({
    enabled: d.settings.get().routinesEnabled,
    routines: listRoutines(),
    notifications: d.usage.notifications(30),
  }));

  app.post("/admin/api/routines", { preHandler: requireAuth }, async (request, reply) => {
    if (!d.routines) return reply.code(503).send({ ok: false, error: "routines are not enabled on this server" });
    try {
      const routine = d.routines.add((request.body ?? {}) as RoutineInput, "admin");
      d.logger.info({ routine: routine.id, name: routine.name }, "routine created from admin UI");
      return { ok: true, routine, routines: listRoutines() };
    } catch (err) {
      return reply.code(400).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.put("/admin/api/routines/:id", { preHandler: requireAuth }, async (request, reply) => {
    if (!d.routines) return reply.code(503).send({ ok: false, error: "routines are not enabled on this server" });
    const { id } = request.params as { id: string };
    try {
      const routine = d.routines.update(id, (request.body ?? {}) as Partial<RoutineInput>, "admin");
      return { ok: true, routine, routines: listRoutines() };
    } catch (err) {
      return reply.code(400).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete("/admin/api/routines/:id", { preHandler: requireAuth }, async (request, reply) => {
    if (!d.routines) return reply.code(503).send({ ok: false, error: "routines are not enabled on this server" });
    const { id } = request.params as { id: string };
    try {
      const routine = d.routines.remove(id);
      return { ok: true, routine, routines: listRoutines() };
    } catch (err) {
      return reply.code(400).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Runs a routine now (waits for the result; a run can take a minute or two). */
  app.post("/admin/api/routines/:id/run", { preHandler: requireAuth }, async (request, reply) => {
    if (!d.routines || !d.runner) return reply.code(503).send({ ok: false, error: "routines are not enabled on this server" });
    const { id } = request.params as { id: string };
    if (!d.routines.get(id)) return reply.code(404).send({ ok: false, error: `routine ${id} does not exist` });
    const result = await d.runner.run(id, { kind: "manual" });
    return { ok: result.ok, result, routines: listRoutines() };
  });

  app.get("/admin/api/routines/:id/runs", { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    return { id, runs: d.usage.routineRuns(id, 50) };
  });

  /** Sends a test message on a channel so the owner can verify WhatsApp / SMS / email delivery. */
  app.post("/admin/api/notify/test", { preHandler: requireAuth }, async (request, reply) => {
    if (!d.notifier) return reply.code(503).send({ ok: false, error: "notifier is not enabled on this server" });
    const body = (request.body ?? {}) as { channel?: string; text?: string };
    const channel = (NOTIFY_CHANNELS as readonly string[]).includes(body.channel ?? "") ? (body.channel as (typeof NOTIFY_CHANNELS)[number]) : d.settings.get().notifyChannel;
    const text = (typeof body.text === "string" && body.text.trim()) || "בדיקה: זו הודעת ניסיון מהעוזר החכם. אם קיבלת אותה, ערוץ ההתראות עובד.";
    const outcome = await d.notifier.send(channel, text.slice(0, 1500), { subject: "בדיקת התראות", source: "admin", callId: `admin-notify-${Date.now()}` });
    return { ok: outcome.ok, channel: outcome.channel, detail: outcome.detail };
  });

  app.put("/admin/api/settings", { preHandler: requireAuth }, async (request, reply) => {
    try {
      const patch = (request.body ?? {}) as SettingsPatch;
      d.settings.update(patch);
      d.logger.info({ keys: Object.keys(patch) }, "settings updated from admin UI");
      return { ok: true, settings: d.settings.view() };
    } catch (err) {
      return reply.code(400).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/admin/api/usage", { preHandler: requireAuth }, async (request) => {
    const { range } = request.query as { range?: string };
    const since = sinceFor(range, d.timeZone);
    return { range: range ?? "all", aggregate: d.usage.aggregate(since, d.timeZone), calls: d.usage.calls(100, since) };
  });

  app.get("/admin/api/calls/:callId", { preHandler: requireAuth }, async (request) => {
    const { callId } = request.params as { callId: string };
    return { callId, events: d.usage.callEvents(callId) };
  });

  app.get("/admin/api/prompt", { preHandler: requireAuth }, async (_req, reply) => {
    return reply.type("text/plain; charset=utf-8").send(d.agent.getSystemPrompt());
  });

  /* ---- Standing rules (the bot's editable skill) ---- */
  app.get("/admin/api/rules", { preHandler: requireAuth }, async () => ({ rules: d.rules.list() }));

  app.post("/admin/api/rules", { preHandler: requireAuth }, async (request, reply) => {
    const body = (request.body ?? {}) as { text?: string };
    try {
      const rule = d.rules.add(String(body.text ?? ""), "admin");
      return { ok: true, rule, rules: d.rules.list() };
    } catch (err) {
      return reply.code(400).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.put("/admin/api/rules", { preHandler: requireAuth }, async (request, reply) => {
    const body = (request.body ?? {}) as { texts?: string[] };
    if (!Array.isArray(body.texts)) return reply.code(400).send({ ok: false, error: "texts must be an array of strings" });
    const rules = d.rules.replaceAll(body.texts.map(String), "admin");
    d.logger.info({ count: rules.length }, "rules replaced from admin UI");
    return { ok: true, rules };
  });

  app.put("/admin/api/rules/:id", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { text?: string };
    try {
      const rule = d.rules.update(Number(id), String(body.text ?? ""), "admin");
      return { ok: true, rule, rules: d.rules.list() };
    } catch (err) {
      return reply.code(400).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete("/admin/api/rules/:id", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const rule = d.rules.remove(Number(id));
      return { ok: true, rule, rules: d.rules.list() };
    } catch (err) {
      return reply.code(400).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  /* ---- Business instructions file (config/instructions.md) ---- */
  app.get("/admin/api/instructions", { preHandler: requireAuth }, async (_req, reply) => {
    let text = "";
    try {
      if (fs.existsSync(d.instructionsPath)) text = fs.readFileSync(d.instructionsPath, "utf8");
    } catch {
      text = "";
    }
    return reply.type("text/plain; charset=utf-8").send(text);
  });

  app.put("/admin/api/instructions", { preHandler: requireAuth }, async (request, reply) => {
    const body = (request.body ?? {}) as { text?: string };
    if (typeof body.text !== "string") return reply.code(400).send({ ok: false, error: "text must be a string" });
    if (body.text.length > 200_000) return reply.code(400).send({ ok: false, error: "instructions too long" });
    fs.mkdirSync(require_dirname(d.instructionsPath), { recursive: true });
    fs.writeFileSync(d.instructionsPath, body.text, "utf8");
    d.agent.refresh();
    d.logger.info({ chars: body.text.length }, "instructions.md updated from admin UI");
    return { ok: true };
  });

  /** Text chat with the same agent - lets the admin test tools without a phone. */
  const chatBusy = new Map<string, Promise<unknown>>();
  app.post("/admin/api/chat", { preHandler: requireAuth }, async (request) => {
    const body = (request.body ?? {}) as { message?: string; sessionId?: string; reset?: boolean };
    const sessionId = body.sessionId || `admin-${crypto.randomUUID()}`;
    if (body.reset) {
      await chatBusy.get(sessionId);
      chats.delete(sessionId);
    }
    let conv = chats.get(sessionId);
    if (!conv) {
      conv = d.agent.newConversation(sessionId, "admin-chat", { channel: "chat" });
      chats.set(sessionId, conv);
      if (chats.size > 50) chats.delete(chats.keys().next().value as string);
    }
    const message = (body.message ?? "").trim();
    if (!message) return { sessionId, text: "", endCall: false };
    // One turn at a time per session (a double-click must not interleave two turns in one transcript).
    const current = conv;
    const turn = (chatBusy.get(sessionId) ?? Promise.resolve()).then(() => d.agent.respond(current, message, { phone: "admin-chat", channel: "צ'אט בדיקה מממשק הניהול (טקסט)" }));
    chatBusy.set(
      sessionId,
      turn.then(
        () => undefined,
        () => undefined,
      ),
    );
    const reply = await turn;
    if (reply.endCall) chats.delete(sessionId);
    return { sessionId, ...reply };
  });

  app.post("/admin/api/mcp/:name/reconnect", { preHandler: requireAuth }, async (request) => {
    const { name } = request.params as { name: string };
    await d.hub.reconnect(name);
    return { ok: true, servers: d.hub.status() };
  });

  app.post("/admin/api/mcp/:name/logout", { preHandler: requireAuth }, async (request) => {
    const { name } = request.params as { name: string };
    d.hub.logout(name);
    return { ok: true };
  });

  app.get("/admin/mcp/:name/login", { preHandler: requireAuth }, async (request, reply) => {
    const { name } = request.params as { name: string };
    // A link on another site must not be able to start (and so reset) a login.
    if (request.headers["sec-fetch-site"] === "cross-site") return reply.redirect("/admin?login=error&message=" + encodeURIComponent("cross-site login link refused - open it from the admin page"));
    try {
      const url = await d.hub.beginLogin(name);
      return reply.redirect(url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "already-authorized") return reply.redirect("/admin?login=ok");
      d.logger.error({ server: name, err: msg }, "OAuth login could not start");
      return reply.redirect(`/admin?login=error&message=${encodeURIComponent(msg)}`);
    }
  });

  // No basic-auth here: the browser arrives from the authorization server. The OAuth
  // state parameter (checked by the hub) binds the callback to the login we started.
  app.get("/oauth/callback/:name", async (request, reply) => {
    const { name } = request.params as { name: string };
    const q = request.query as { code?: string; state?: string; error?: string; error_description?: string };
    if (q.error) return reply.redirect(`/admin?login=error&message=${encodeURIComponent(q.error_description ?? q.error)}`);
    if (!q.code) return reply.code(400).send("Missing authorization code");
    try {
      await d.hub.finishLogin(name, q.code, q.state);
      return reply.redirect("/admin?login=ok");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      d.logger.error({ server: name, err: msg }, "OAuth callback failed");
      return reply.redirect(`/admin?login=error&message=${encodeURIComponent(msg)}`);
    }
  });
}
