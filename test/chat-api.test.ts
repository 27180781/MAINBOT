import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify from "fastify";
import { registerChatApi, normalizeHistory } from "../src/api/chat.js";
import type { VoiceAgent, ConversationState, AgentReply } from "../src/agent/agent.js";
import type { RoutineRunner } from "../src/routines/runner.js";
import type { Logger } from "../src/logger.js";

const KEY = "test-chat-api-key-0123456789";

function fakeLogger(): Logger {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn(), child: vi.fn() };
  log.child.mockReturnValue(log);
  return log as unknown as Logger;
}

function fakeAgent() {
  const newConversation = vi.fn((callId: string, phone: string, opts?: { channel?: string }) => ({ callId, phone, channel: opts?.channel, messages: [], turn: 0 }) as unknown as ConversationState);
  const respond = vi.fn(async (conv: ConversationState, text: string, _ctx?: { phone: string; channel?: string; userName?: string }): Promise<AgentReply> => ({
    text: `echo(${conv.callId}): ${text}`,
    endCall: false,
    iterations: 1,
    toolCalls: ["crm__search_contacts"],
    durationMs: 5,
  }));
  return { agent: { newConversation, respond } as unknown as VoiceAgent, newConversation, respond };
}

describe("chat API", () => {
  const app = Fastify();
  const parts = fakeAgent();
  const dispatchEvent = vi.fn((type: string, _payload: unknown) => (type === "new_lead" ? ["rt_abc123"] : []));

  beforeAll(async () => {
    registerChatApi(app, { agent: parts.agent, runner: { dispatchEvent } as unknown as RoutineRunner, logger: fakeLogger(), apiKey: KEY, corsOrigins: ["https://crm.example.com"], sessionTtlMs: 60_000 });
    await app.ready();
  });

  it("accepts events and hands them to the routine runner", async () => {
    const anon = await app.inject({ method: "POST", url: "/api/v1/events", payload: { type: "new_lead" } });
    expect(anon.statusCode).toBe(401);

    const ok = await app.inject({ method: "POST", url: "/api/v1/events", headers: { authorization: `Bearer ${KEY}` }, payload: { type: "new_lead", payload: { name: "דני", phone: "0501234567" } } });
    expect(ok.statusCode).toBe(202);
    expect(ok.json()).toEqual({ ok: true, type: "new_lead", routines: ["rt_abc123"] });
    expect(dispatchEvent).toHaveBeenCalledWith("new_lead", { name: "דני", phone: "0501234567" });

    const none = await app.inject({ method: "POST", url: "/api/v1/events", headers: { authorization: `Bearer ${KEY}` }, payload: { type: "payment_received" } });
    expect(none.statusCode).toBe(202);
    expect(none.json()).toEqual({ ok: true, type: "payment_received", routines: [] });
    expect(dispatchEvent).toHaveBeenLastCalledWith("payment_received", undefined);

    const bad = await app.inject({ method: "POST", url: "/api/v1/events", headers: { authorization: `Bearer ${KEY}` }, payload: { type: "bad type!" } });
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject({ method: "POST", url: "/api/v1/events", headers: { authorization: `Bearer ${KEY}` }, payload: {} });
    expect(missing.statusCode).toBe(400);
    const huge = await app.inject({ method: "POST", url: "/api/v1/events", headers: { authorization: `Bearer ${KEY}` }, payload: { type: "x", payload: "a".repeat(30_000) } });
    expect(huge.statusCode).toBe(413);

    const preflight = await app.inject({ method: "OPTIONS", url: "/api/v1/events", headers: { origin: "https://crm.example.com" } });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("https://crm.example.com");
  });

  it("seeds a new session from the caller's history and reports newSession", async () => {
    const headers = { authorization: `Bearer ${KEY}` };
    const history = [
      { role: "user", content: "מי הלקוח האחרון?" },
      { role: "assistant", content: "דני כהן." },
      { role: "assistant", content: "" },
      { role: "user", content: "ומה הטלפון שלו?" },
    ];
    const first = await app.inject({ method: "POST", url: "/api/v1/chat", headers, payload: { message: "תודה", sessionId: "crm:u:hist", history } });
    expect(first.statusCode).toBe(200);
    expect(first.json().newSession).toBe(true);
    const conv = parts.newConversation.mock.results.at(-1)!.value as ConversationState;
    // the trailing unanswered user turn was dropped so the new message follows an assistant turn
    expect(conv.messages.slice(0, 2)).toEqual([
      { role: "user", content: "מי הלקוח האחרון?" },
      { role: "assistant", content: "דני כהן." },
    ]);
    const second = await app.inject({ method: "POST", url: "/api/v1/chat", headers, payload: { message: "עוד", sessionId: "crm:u:hist", history } });
    expect(second.json().newSession).toBe(false);
    expect(parts.newConversation.mock.calls.filter((c) => c[0] === "crm:u:hist")).toHaveLength(1);
  });

  it("reads the key through a getter so rotation applies immediately", async () => {
    let key = "first-key-0123456789abcdef";
    const rotating = Fastify();
    registerChatApi(rotating, { agent: parts.agent, logger: fakeLogger(), apiKey: () => key, corsOrigins: [], sessionTtlMs: 60_000 });
    await rotating.ready();
    try {
      expect((await rotating.inject({ method: "POST", url: "/api/v1/chat", headers: { authorization: `Bearer ${key}` }, payload: { message: "היי" } })).statusCode).toBe(200);
      const old = key;
      key = "second-key-0123456789abcdef";
      expect((await rotating.inject({ method: "POST", url: "/api/v1/chat", headers: { authorization: `Bearer ${old}` }, payload: { message: "היי" } })).statusCode).toBe(401);
      expect((await rotating.inject({ method: "POST", url: "/api/v1/chat", headers: { authorization: `Bearer ${key}` }, payload: { message: "היי" } })).statusCode).toBe(200);
      key = "";
      expect((await rotating.inject({ method: "GET", url: "/api/v1/health" })).json().enabled).toBe(false);
    } finally {
      await rotating.close();
    }
  });

  it("answers 503 for events when no runner is configured", async () => {
    const bare = Fastify();
    registerChatApi(bare, { agent: parts.agent, logger: fakeLogger(), apiKey: KEY, corsOrigins: [], sessionTtlMs: 60_000 });
    await bare.ready();
    try {
      const res = await bare.inject({ method: "POST", url: "/api/v1/events", headers: { authorization: `Bearer ${KEY}` }, payload: { type: "new_lead" } });
      expect(res.statusCode).toBe(503);
    } finally {
      await bare.close();
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it("reports itself on /api/v1/health without auth", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, enabled: true });
  });

  it("rejects missing or wrong bearer keys", async () => {
    const anon = await app.inject({ method: "POST", url: "/api/v1/chat", payload: { message: "שלום" } });
    expect(anon.statusCode).toBe(401);
    const wrong = await app.inject({ method: "POST", url: "/api/v1/chat", headers: { authorization: "Bearer nope" }, payload: { message: "שלום" } });
    expect(wrong.statusCode).toBe(401);
    expect(parts.respond).not.toHaveBeenCalled();
  });

  it("answers with the agent and keeps the session across messages", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/chat",
      headers: { authorization: `Bearer ${KEY}` },
      payload: { message: "מה חדש?", sessionId: "crm:user-1:conv-1", userId: "user-1", userName: "נסים" },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ sessionId: "crm:user-1:conv-1", text: "echo(crm:user-1:conv-1): מה חדש?", toolCalls: ["crm__search_contacts"], iterations: 1 });
    expect(parts.newConversation).toHaveBeenCalledWith("crm:user-1:conv-1", "chat:user-1", { channel: "chat" });
    expect(parts.respond.mock.calls[0]![2]).toMatchObject({ phone: "chat:user-1", userName: "נסים" });

    const second = await app.inject({ method: "POST", url: "/api/v1/chat", headers: { authorization: `Bearer ${KEY}` }, payload: { message: "עוד", sessionId: "crm:user-1:conv-1" } });
    expect(second.statusCode).toBe(200);
    expect(parts.newConversation).toHaveBeenCalledTimes(1); // same conversation object reused
    expect(parts.respond.mock.calls[1]![0]).toBe(parts.respond.mock.calls[0]![0]);
  });

  it("generates a session id when none is given and starts fresh on reset", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/chat", headers: { authorization: `Bearer ${KEY}` }, payload: { message: "היי" } });
    expect(res.json().sessionId).toMatch(/^chat-/);
    const before = parts.newConversation.mock.calls.length;
    await app.inject({ method: "POST", url: "/api/v1/chat", headers: { authorization: `Bearer ${KEY}` }, payload: { message: "מחדש", sessionId: "crm:user-1:conv-1", reset: true } });
    expect(parts.newConversation.mock.calls.length).toBe(before + 1);
  });

  it("validates the message and deletes sessions", async () => {
    const empty = await app.inject({ method: "POST", url: "/api/v1/chat", headers: { authorization: `Bearer ${KEY}` }, payload: { message: "   " } });
    expect(empty.statusCode).toBe(400);
    const del = await app.inject({ method: "DELETE", url: "/api/v1/chat/crm:user-1:conv-1", headers: { authorization: `Bearer ${KEY}` } });
    expect(del.json()).toEqual({ ok: true, deleted: true });
    const again = await app.inject({ method: "DELETE", url: "/api/v1/chat/crm:user-1:conv-1", headers: { authorization: `Bearer ${KEY}` } });
    expect(again.json()).toEqual({ ok: true, deleted: false });
  });

  it("runs overlapping messages on one session one after another", async () => {
    const order: string[] = [];
    parts.respond.mockImplementation(async (conv: ConversationState, text: string) => {
      order.push(`start:${text}`);
      await new Promise((r) => setTimeout(r, 15));
      order.push(`end:${text}`);
      return { text: `echo(${conv.callId}): ${text}`, endCall: false, iterations: 1, toolCalls: [], durationMs: 15 };
    });
    const headers = { authorization: `Bearer ${KEY}` };
    const [a, b] = await Promise.all([
      app.inject({ method: "POST", url: "/api/v1/chat", headers, payload: { message: "א", sessionId: "crm:u:serial" } }),
      app.inject({ method: "POST", url: "/api/v1/chat", headers, payload: { message: "ב", sessionId: "crm:u:serial" } }),
    ]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(order).toEqual(["start:א", "end:א", "start:ב", "end:ב"]);
    // a reset waits for the running turn instead of pulling the conversation from under it
    const c = app.inject({ method: "POST", url: "/api/v1/chat", headers, payload: { message: "ג", sessionId: "crm:u:serial" } });
    const d = app.inject({ method: "POST", url: "/api/v1/chat", headers, payload: { message: "ד", sessionId: "crm:u:serial", reset: true } });
    await Promise.all([c, d]);
    expect(order.slice(4)).toEqual(["start:ג", "end:ג", "start:ד", "end:ד"]);
    expect(parts.newConversation.mock.calls.filter((call) => call[0] === "crm:u:serial")).toHaveLength(2);
  });

  it("sends CORS headers only for allowed origins", async () => {
    const ok = await app.inject({ method: "OPTIONS", url: "/api/v1/chat", headers: { origin: "https://crm.example.com" } });
    expect(ok.statusCode).toBe(204);
    expect(ok.headers["access-control-allow-origin"]).toBe("https://crm.example.com");
    const bad = await app.inject({ method: "OPTIONS", url: "/api/v1/chat", headers: { origin: "https://evil.example.com" } });
    expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("chat API without a key", () => {
  it("answers 503 so callers know it is disabled", async () => {
    const app = Fastify();
    registerChatApi(app, { agent: fakeAgent().agent, logger: fakeLogger(), apiKey: "", corsOrigins: [], sessionTtlMs: 1000 });
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/api/v1/chat", headers: { authorization: "Bearer x" }, payload: { message: "שלום" } });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
});

describe("normalizeHistory", () => {
  it("keeps only clean alternating user/assistant text turns", () => {
    expect(normalizeHistory(undefined)).toEqual([]);
    expect(normalizeHistory("nope")).toEqual([]);
    expect(
      normalizeHistory([
        { role: "assistant", content: "פתיחה שלא תישמר" },
        { role: "user", content: " שאלה " },
        { role: "tool", content: "x" },
        { role: "user", content: "המשך" },
        { role: "assistant", content: "תשובה" },
        { role: "assistant", content: 42 },
        { role: "user", content: "   " },
        { role: "user", content: "ללא תשובה" },
      ]),
    ).toEqual([
      { role: "user", content: "שאלה\nהמשך" },
      { role: "assistant", content: "תשובה" },
    ]);
  });

  it("caps the number of turns and the total size, keeping the newest", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `t${i}` }));
    const out = normalizeHistory(many);
    expect(out).toHaveLength(40);
    expect(out[0]).toEqual({ role: "user", content: "t60" });
    expect(out.at(-1)).toEqual({ role: "assistant", content: "t99" });
    const big = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: (i % 2 === 0 ? "u" : "a").repeat(7000) }));
    const trimmed = normalizeHistory(big);
    expect(trimmed.length).toBeLessThan(20);
    expect(trimmed[0]!.role).toBe("user");
    expect(trimmed.reduce((n, t) => n + t.content.length, 0)).toBeLessThanOrEqual(60_000);
  });
});
