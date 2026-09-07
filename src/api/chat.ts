import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Logger } from "../logger.js";
import type { VoiceAgent, ConversationState } from "../agent/agent.js";
import type { RoutineRunner } from "../routines/runner.js";

/**
 * Text-chat API for other systems (the CRM's built-in assistant, internal tools):
 * the same Claude engine, MCP tools, standing rules and confirmation gate as the phone,
 * with a chat-flavoured prompt. Authenticated with a bearer key that stays server-side
 * (call it from a backend / edge function, not from the browser).
 *
 *   POST /api/v1/chat   { message, sessionId?, userId?, userName?, reset?, history? }
 *   -> { sessionId, text, toolCalls, iterations, durationMs, newSession, error? }
 *   `history` (earlier user/assistant turns kept by the caller) seeds a session the server
 *   does not have yet - after a restart or the session TTL - and is ignored otherwise.
 *   DELETE /api/v1/chat/:sessionId
 *   GET /api/v1/health
 *   POST /api/v1/events { type, payload? }  -> runs the proactive routines subscribed to that event type
 */
export interface ChatApiDeps {
  agent: VoiceAgent;
  /** Optional: enables POST /api/v1/events (event-driven routines). */
  runner?: RoutineRunner;
  logger: Logger;
  /** Bearer key, or a getter so a rotated key applies without a restart. */
  apiKey: string | (() => string);
  /** Allowed browser origins for CORS; empty = no CORS headers (backend-to-backend only). */
  corsOrigins: string[];
  sessionTtlMs: number;
  maxSessions?: number;
}

interface ChatSession {
  conv: ConversationState;
  userId: string;
  lastActivity: number;
  /** Turns on one session run one after another: two overlapping requests would corrupt the transcript. */
  busy: Promise<unknown>;
}

export interface ChatRequestBody {
  message?: string;
  sessionId?: string;
  userId?: string;
  userName?: string;
  reset?: boolean;
  history?: unknown;
}

export interface HistoryTurn {
  role: "user" | "assistant";
  content: string;
}

const SESSION_ID_RE = /^[A-Za-z0-9_.:@-]{1,128}$/;
export const MAX_HISTORY_TURNS = 40;
const MAX_HISTORY_TURN_CHARS = 8_000;
const MAX_HISTORY_CHARS = 60_000;

/**
 * Turns caller-supplied history into a transcript the model accepts: user/assistant only,
 * non-empty text, consecutive same-role turns merged, starting on a user turn and ending on
 * an assistant turn (the new message follows), newest turns kept when the cap is exceeded.
 */
export function normalizeHistory(raw: unknown): HistoryTurn[] {
  if (!Array.isArray(raw)) return [];
  const turns: HistoryTurn[] = [];
  for (const item of raw.slice(-MAX_HISTORY_TURNS * 2)) {
    if (!item || typeof item !== "object") continue;
    const { role, content } = item as { role?: unknown; content?: unknown };
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") continue;
    const text = content.trim().slice(0, MAX_HISTORY_TURN_CHARS);
    if (!text) continue;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content = `${last.content}\n${text}`;
    else turns.push({ role, content: text });
  }
  while (turns.length && turns[0]!.role !== "user") turns.shift();
  while (turns.length && turns[turns.length - 1]!.role !== "assistant") turns.pop();
  let out = turns.slice(-MAX_HISTORY_TURNS);
  while (out.length && out[0]!.role !== "user") out.shift();
  let total = out.reduce((n, t) => n + t.content.length, 0);
  while (out.length > 2 && total > MAX_HISTORY_CHARS) {
    total -= out[0]!.content.length + out[1]!.content.length;
    out = out.slice(2);
  }
  return out;
}
const EVENT_TYPE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const MAX_EVENT_PAYLOAD_CHARS = 20_000;

export class ChatSessionStore {
  private readonly sessions = new Map<string, ChatSession>();

  constructor(
    private readonly ttlMs: number,
    private readonly max = 500,
  ) {}

  get(id: string): ChatSession | undefined {
    const s = this.sessions.get(id);
    if (s) s.lastActivity = Date.now();
    return s;
  }

  set(id: string, session: ChatSession): void {
    this.sessions.set(id, session);
    if (this.sessions.size > this.max) {
      const oldest = [...this.sessions.entries()].sort((a, b) => a[1].lastActivity - b[1].lastActivity)[0];
      if (oldest) this.sessions.delete(oldest[0]);
    }
  }

  delete(id: string): boolean {
    return this.sessions.delete(id);
  }

  size(): number {
    return this.sessions.size;
  }

  sweep(now = Date.now()): number {
    let n = 0;
    for (const [id, s] of this.sessions) {
      if (now - s.lastActivity > this.ttlMs) {
        this.sessions.delete(id);
        n++;
      }
    }
    return n;
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function registerChatApi(app: FastifyInstance, d: ChatApiDeps): ChatSessionStore {
  const sessions = new ChatSessionStore(d.sessionTtlMs, d.maxSessions);
  const currentKey = () => (typeof d.apiKey === "function" ? d.apiKey() : d.apiKey);
  const isEnabled = () => currentKey().length >= 16;
  if (!isEnabled()) d.logger.warn("CHAT_API_KEY is unset or shorter than 16 chars - the chat API (/api/v1/chat) is disabled");

  const cors = async (request: FastifyRequest, reply: FastifyReply) => {
    const origin = request.headers.origin;
    if (!origin || d.corsOrigins.length === 0) return;
    if (d.corsOrigins.includes("*") || d.corsOrigins.includes(origin)) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Vary", "Origin");
      reply.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      reply.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
      reply.header("Access-Control-Max-Age", "600");
    }
  };

  const requireKey = async (request: FastifyRequest, reply: FastifyReply) => {
    await cors(request, reply);
    if (request.method === "OPTIONS") return reply.code(204).send();
    if (!isEnabled()) return reply.code(503).send({ error: "chat API disabled: set CHAT_API_KEY (at least 16 characters)" });
    const header = request.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token || !timingSafeEqual(token, currentKey())) {
      return reply.code(401).header("WWW-Authenticate", "Bearer").send({ error: "unauthorized" });
    }
  };

  app.options("/api/v1/chat", { preHandler: cors }, async (_req, reply) => reply.code(204).send());
  app.options("/api/v1/chat/:sessionId", { preHandler: cors }, async (_req, reply) => reply.code(204).send());
  app.options("/api/v1/events", { preHandler: cors }, async (_req, reply) => reply.code(204).send());

  /**
   * Event webhook: the CRM (or any system) posts { type, payload } and every enabled routine
   * with schedule.kind = "event" that lists this type (or "*") runs in the background.
   */
  app.post("/api/v1/events", { preHandler: requireKey }, async (request, reply) => {
    if (!d.runner) return reply.code(503).send({ error: "routines are not enabled on this server" });
    const body = (request.body ?? {}) as { type?: unknown; payload?: unknown };
    const type = typeof body.type === "string" ? body.type.trim() : "";
    if (!EVENT_TYPE_RE.test(type)) return reply.code(400).send({ error: "type is required: letters, digits, _ . : - (max 64 chars)" });
    let payload = body.payload;
    if (payload !== undefined) {
      let size = 0;
      try {
        size = JSON.stringify(payload).length;
      } catch {
        return reply.code(400).send({ error: "payload must be JSON-serialisable" });
      }
      if (size > MAX_EVENT_PAYLOAD_CHARS) return reply.code(413).send({ error: `payload too large (max ${MAX_EVENT_PAYLOAD_CHARS} chars)` });
    } else {
      payload = undefined;
    }
    const routines = d.runner.dispatchEvent(type, payload);
    d.logger.info({ type, routines }, "event received");
    return reply.code(202).send({ ok: true, type, routines });
  });

  app.get("/api/v1/health", { preHandler: cors }, async () => ({ ok: true, enabled: isEnabled(), sessions: sessions.size() }));

  app.post("/api/v1/chat", { preHandler: requireKey }, async (request, reply) => {
    const body = (request.body ?? {}) as ChatRequestBody;
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) return reply.code(400).send({ error: "message is required" });
    if (message.length > 20_000) return reply.code(413).send({ error: "message too long (max 20000 chars)" });
    const userId = (typeof body.userId === "string" && body.userId.trim()) || "crm";
    const sessionId = typeof body.sessionId === "string" && SESSION_ID_RE.test(body.sessionId) ? body.sessionId : `chat-${crypto.randomUUID()}`;
    if (body.reset) {
      const old = sessions.get(sessionId);
      if (old) await old.busy; // let an in-flight turn finish before its conversation is dropped
      sessions.delete(sessionId);
    }

    let session = sessions.get(sessionId);
    let newSession = false;
    if (!session) {
      newSession = true;
      const conv = d.agent.newConversation(sessionId, `chat:${userId}`, { channel: "chat" });
      // The caller keeps the thread (the CRM stores every message); replay it so a session the
      // server lost - restart, TTL - continues with the same context.
      const history = normalizeHistory(body.history);
      if (history.length) {
        conv.messages.push(...history.map((t) => ({ role: t.role, content: t.content })));
        d.logger.info({ sessionId, turns: history.length }, "chat session seeded from caller history");
      }
      session = { conv, userId, lastActivity: Date.now(), busy: Promise.resolve() };
      sessions.set(sessionId, session);
    }
    const current = session;
    const turn = current.busy.then(() =>
      d.agent.respond(current.conv, message, {
        phone: `chat:${userId}`,
        channel: "צ'אט טקסט (מערכת חיצונית)",
        userName: typeof body.userName === "string" && body.userName.trim() ? body.userName.trim() : undefined,
      }),
    );
    current.busy = turn.then(
      () => undefined,
      () => undefined,
    );
    const result = await turn;
    d.logger.info({ sessionId, userId, ms: result.durationMs, tools: result.toolCalls, error: result.error }, "chat api reply");
    return {
      sessionId,
      text: result.text,
      toolCalls: result.toolCalls,
      iterations: result.iterations,
      durationMs: result.durationMs,
      newSession,
      ...(result.error ? { error: result.error } : {}),
    };
  });

  app.delete("/api/v1/chat/:sessionId", { preHandler: requireKey }, async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    return { ok: true, deleted: sessions.delete(sessionId) };
  });

  const sweeper = setInterval(() => sessions.sweep(), 60_000);
  sweeper.unref();
  app.addHook("onClose", async () => clearInterval(sweeper));
  return sessions;
}
