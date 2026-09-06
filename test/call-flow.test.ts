import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TechnolineCallFlow } from "../src/pbx/technoline/route.js";
import { parsePbxRequest } from "../src/pbx/technoline/request.js";
import type { PbxModule, PbxRequest, PbxResponse } from "../src/pbx/technoline/types.js";
import { SessionStore } from "../src/calls/session.js";
import { SettingsStore } from "../src/config.js";
import { UsageStore } from "../src/usage/usage-store.js";
import { ConfirmationGate } from "../src/mcp/tool-policy.js";
import type { AgentReply, ConversationState, VoiceAgent } from "../src/agent/agent.js";
import type { Logger } from "../src/logger.js";

const PHONE = "0501234567";

function fakeLogger() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn(), child: vi.fn() };
  log.child.mockReturnValue(log);
  return { logger: log as unknown as Logger, log };
}

function fakeAgent() {
  const respond = vi.fn<(conv: ConversationState, text: string, ctx: { phone: string }) => Promise<AgentReply>>();
  const newConversation = vi.fn(
    (callId: string, phone: string): ConversationState => ({
      callId,
      phone,
      messages: [],
      turn: 0,
      gate: new ConfirmationGate({ confirmWrites: true, blockedTools: [] }),
      contextSent: false,
    }),
  );
  return { agent: { respond, newConversation } as unknown as VoiceAgent, respond, newConversation };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const reply = (text: string, endCall = false): AgentReply => ({ text, endCall, iterations: 1, toolCalls: [], durationMs: 3 });

function pbx(callId: string, extra: Record<string, string> = {}, phone = PHONE): PbxRequest {
  return parsePbxRequest({
    PBXphone: phone,
    PBXnum: "0733000000",
    PBXdid: "0733000000",
    PBXcallId: callId,
    PBXcallType: "in",
    PBXcallStatus: "CALL",
    PBXextensionId: "9",
    PBXextensionPath: "/9",
    ...extra,
  });
}

function mods(res: PbxResponse | Record<string, never>): PbxModule[] {
  if (Array.isArray(res)) return res;
  return "type" in res ? [res as PbxModule] : [];
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("TechnolineCallFlow", () => {
  let dir: string;
  let settings: SettingsStore;
  let usage: UsageStore;
  let sessions: SessionStore;
  let logs: ReturnType<typeof fakeLogger>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mainbot-flow-"));
    settings = new SettingsStore(dir);
    settings.update({ allowedPhones: [PHONE] });
    usage = new UsageStore(dir);
    sessions = new SessionStore(60_000);
    logs = fakeLogger();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeFlow(agent: VoiceAgent, over: Partial<{ longPollMs: number; publicBaseUrl: string }> = {}) {
    return new TechnolineCallFlow({
      agent,
      sessions,
      settings,
      usage,
      logger: logs.logger,
      webhookSecret: "secret",
      longPollMs: over.longPollMs ?? 1000,
      publicBaseUrl: over.publicBaseUrl ?? "",
    });
  }

  it("greets and listens on the first request", async () => {
    const { agent, respond, newConversation } = fakeAgent();
    const flow = makeFlow(agent);
    const res = mods(await flow.handle(pbx("c1")));
    expect(res).toEqual([
      { type: "simpleMessage", files: [{ text: settings.get().greeting }] },
      { type: "stt", name: "utt_1", max: settings.get().sttMaxSeconds, confirm: "no" },
    ]);
    expect(newConversation).toHaveBeenCalledWith("c1", PHONE);
    expect(respond).not.toHaveBeenCalled();
    expect(sessions.get("c1")).toMatchObject({ authorized: true, expectedParam: "utt_1", utteranceIndex: 1, ended: false });
  });

  it("uses the configured TTS voice for prompts", async () => {
    settings.update({ ttsVoice: "Kore", greeting: "שלום" });
    const flow = makeFlow(fakeAgent().agent);
    const res = mods(await flow.handle(pbx("c1")));
    expect(res[0]).toEqual({ type: "simpleMessage", files: [{ text: "שלום", voice: "Kore" }] });
  });

  it("rejects a phone that is not in the allow-list and records the call", async () => {
    const { agent, respond } = fakeAgent();
    const flow = makeFlow(agent);
    const res = mods(await flow.handle(pbx("c-bad", {}, "0529999999")));
    expect(res).toHaveLength(2);
    expect(res[0]).toMatchObject({ type: "simpleMessage" });
    expect(res[1]).toEqual({ type: "hangup" });
    expect(respond).not.toHaveBeenCalled();
    const call = usage.callEvents("c-bad").find((e) => e.kind === "call");
    expect(call).toMatchObject({ kind: "call", callId: "c-bad", phone: "0529999999", endedBy: "unauthorized", turns: 0 });
    expect(sessions.get("c-bad")).toMatchObject({ ended: true, endedBy: "unauthorized" });
    // Any further request for the ended call just hangs up.
    expect(await flow.handle(pbx("c-bad", { utt_1: "שלום" }, "0529999999"))).toEqual({ type: "hangup" });
  });

  it("accepts the caller in any phone format that normalises to the allowed number", async () => {
    const flow = makeFlow(fakeAgent().agent);
    const res = mods(await flow.handle(pbx("c1", {}, "+972501234567")));
    expect(res[1]).toMatchObject({ type: "stt", name: "utt_1" });
  });

  it("runs the PIN flow when a PIN is configured", async () => {
    settings.update({ pin: "1234" });
    const { agent, respond } = fakeAgent();
    const flow = makeFlow(agent);

    const ask = mods(await flow.handle(pbx("c1")));
    expect(ask).toHaveLength(1);
    expect(ask[0]).toMatchObject({ type: "getDTMF", name: "pin_1", max: 8, min: 1, skipKey: "#", confirmType: "no" });
    expect(ask[0]).toHaveProperty("files");

    const wrong = mods(await flow.handle(pbx("c1", { pin_1: "0000" })));
    expect(wrong).toHaveLength(1);
    expect(wrong[0]).toMatchObject({ type: "getDTMF", name: "pin_2" });
    expect(JSON.stringify(wrong[0])).toContain("קוד שגוי");
    expect(sessions.get("c1")).toMatchObject({ authorized: false, pinAttempts: 1 });

    const ok = mods(await flow.handle(pbx("c1", { pin_1: "0000", pin_2: "1234" })));
    expect(ok).toEqual([
      { type: "simpleMessage", files: [{ text: settings.get().greeting }] },
      { type: "stt", name: "utt_1", max: settings.get().sttMaxSeconds, confirm: "no" },
    ]);
    expect(sessions.get("c1")).toMatchObject({ authorized: true, expectedParam: "utt_1" });
    expect(respond).not.toHaveBeenCalled();
    expect(usage.callEvents("c1").filter((e) => e.kind === "call")).toHaveLength(0);
  });

  it("accepts a PIN typed with the # terminator or stray characters", async () => {
    settings.update({ pin: "1234" });
    const flow = makeFlow(fakeAgent().agent);
    await flow.handle(pbx("c1"));
    const ok = mods(await flow.handle(pbx("c1", { pin_1: "1234#" })));
    expect(ok[1]).toMatchObject({ type: "stt", name: "utt_1" });
  });

  it("hangs up after too many wrong PINs", async () => {
    settings.update({ pin: "1234", maxPinAttempts: 2 });
    const flow = makeFlow(fakeAgent().agent);
    await flow.handle(pbx("c1"));
    expect(mods(await flow.handle(pbx("c1", { pin_1: "1111" })))[0]).toMatchObject({ type: "getDTMF", name: "pin_2" });
    const res = mods(await flow.handle(pbx("c1", { pin_1: "1111", pin_2: "2222" })));
    expect(res[0]).toMatchObject({ type: "simpleMessage" });
    expect(res[1]).toEqual({ type: "hangup" });
    expect(usage.callEvents("c1").find((e) => e.kind === "call")).toMatchObject({ endedBy: "pin_failed" });
  });

  it("answers an utterance with a fast agent and does not re-run the agent on a repeated request", async () => {
    const { agent, respond } = fakeAgent();
    respond.mockResolvedValue(reply("התשובה שלי"));
    const flow = makeFlow(agent);
    await flow.handle(pbx("c1"));

    const res = mods(await flow.handle(pbx("c1", { utt_1: "מה השעה" })));
    expect(res).toEqual([
      { type: "simpleMessage", files: [{ text: "התשובה שלי" }] },
      { type: "stt", name: "utt_2", max: settings.get().sttMaxSeconds, confirm: "no" },
    ]);
    expect(respond).toHaveBeenCalledTimes(1);
    const [conv, text, ctx] = respond.mock.calls[0]!;
    expect(conv).toMatchObject({ callId: "c1", phone: PHONE });
    expect(text).toBe("מה השעה");
    expect(ctx).toEqual({ phone: PHONE });
    expect(sessions.get("c1")).toMatchObject({ turns: 1, expectedParam: "utt_2", pending: null });

    // The PBX re-sends every accumulated parameter; utt_1 was already consumed.
    const again = mods(await flow.handle(pbx("c1", { utt_1: "מה השעה" })));
    expect(respond).toHaveBeenCalledTimes(1);
    expect(again.at(-1)).toMatchObject({ type: "stt" });
    expect((again.at(-1) as { name: string }).name).not.toBe("utt_1");
    expect(JSON.stringify(again)).not.toContain("התשובה שלי");
    expect(sessions.get("c1")?.ended).toBe(false);
  });

  it("keeps the conversation across turns and passes the transcript text verbatim", async () => {
    const { agent, respond } = fakeAgent();
    respond.mockResolvedValueOnce(reply("אחת")).mockResolvedValueOnce(reply("שתיים"));
    const flow = makeFlow(agent);
    await flow.handle(pbx("c1"));
    await flow.handle(pbx("c1", { utt_1: "ראשון" }));
    const res = mods(await flow.handle(pbx("c1", { utt_1: "ראשון", utt_2: "  שני  " })));
    expect(res[0]).toEqual({ type: "simpleMessage", files: [{ text: "שתיים" }] });
    expect(res[1]).toMatchObject({ type: "stt", name: "utt_3" });
    expect(respond).toHaveBeenCalledTimes(2);
    expect(respond.mock.calls[1]![1]).toBe("שני");
    expect(respond.mock.calls[0]![0]).toBe(respond.mock.calls[1]![0]); // same ConversationState
    expect(sessions.get("c1")?.turns).toBe(2);
  });

  it("sends a filler while the agent is slow and the answer on the next poll", async () => {
    const { agent, respond } = fakeAgent();
    const d = deferred<AgentReply>();
    respond.mockReturnValue(d.promise);
    const flow = makeFlow(agent, { longPollMs: 50 });
    await flow.handle(pbx("c1"));

    const t0 = Date.now();
    const filler = mods(await flow.handle(pbx("c1", { utt_1: "תבדוק משהו ארוך" })));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(45);
    expect(filler).toHaveLength(1);
    expect(filler[0]).toMatchObject({ type: "simpleMessage" });
    expect((filler[0] as { files: unknown[] }).files.length).toBeGreaterThan(0);
    expect(sessions.get("c1")?.pending).not.toBeNull();
    expect(sessions.get("c1")?.pending?.fillers).toBe(1);

    // Still working: the PBX polls again with the same parameters -> another filler, no re-run.
    const filler2 = mods(await flow.handle(pbx("c1", { utt_1: "תבדוק משהו ארוך" })));
    expect(filler2[0]).toMatchObject({ type: "simpleMessage" });
    expect(filler2).not.toEqual(filler); // fillers rotate
    expect(respond).toHaveBeenCalledTimes(1);

    d.resolve(reply("הנה התוצאה"));
    await tick();
    const answer = mods(await flow.handle(pbx("c1", { utt_1: "תבדוק משהו ארוך" })));
    expect(answer).toEqual([
      { type: "simpleMessage", files: [{ text: "הנה התוצאה" }] },
      { type: "stt", name: "utt_2", max: settings.get().sttMaxSeconds, confirm: "no" },
    ]);
    expect(sessions.get("c1")?.pending).toBeNull();
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it("returns the answer directly when the agent finishes inside the long-poll window", async () => {
    const { agent, respond } = fakeAgent();
    respond.mockImplementation(() => new Promise((r) => setTimeout(() => r(reply("מהיר יחסית")), 20)));
    const flow = makeFlow(agent, { longPollMs: 500 });
    await flow.handle(pbx("c1"));
    const res = mods(await flow.handle(pbx("c1", { utt_1: "שאלה" })));
    expect(res[0]).toEqual({ type: "simpleMessage", files: [{ text: "מהיר יחסית" }] });
  });

  it("uses a silence file as the filler when fillerMode is silence and a public URL is known", async () => {
    settings.update({ fillerMode: "silence" });
    const { agent, respond } = fakeAgent();
    const d = deferred<AgentReply>();
    respond.mockReturnValue(d.promise);
    const flow = makeFlow(agent, { longPollMs: 20, publicBaseUrl: "https://bot.example.com" });
    await flow.handle(pbx("c1"));
    const filler = mods(await flow.handle(pbx("c1", { utt_1: "רגע" })));
    expect(filler).toEqual([{ type: "simpleMessage", files: [{ fileLink: "https://bot.example.com/audio/silence.wav", fileName: "mainbot_silence_3s" }] }]);
    d.resolve(reply("סיימתי"));
    await tick();
    expect(mods(await flow.handle(pbx("c1", { utt_1: "רגע" })))[0]).toEqual({ type: "simpleMessage", files: [{ text: "סיימתי" }] });
  });

  it("falls back to a spoken filler in silence mode without a public URL", async () => {
    settings.update({ fillerMode: "silence" });
    const { agent, respond } = fakeAgent();
    respond.mockReturnValue(deferred<AgentReply>().promise);
    const flow = makeFlow(agent, { longPollMs: 20, publicBaseUrl: "" });
    await flow.handle(pbx("c1"));
    const filler = mods(await flow.handle(pbx("c1", { utt_1: "רגע" })));
    expect(filler[0]).toMatchObject({ type: "simpleMessage", files: [{ text: expect.any(String) }] });
  });

  it("hangs up after the farewell when the agent ends the call", async () => {
    const { agent, respond } = fakeAgent();
    respond.mockResolvedValue(reply("להתראות!", true));
    const flow = makeFlow(agent);
    await flow.handle(pbx("c1"));
    const res = mods(await flow.handle(pbx("c1", { utt_1: "ביי" })));
    expect(res).toEqual([{ type: "simpleMessage", files: [{ text: "להתראות!" }] }, { type: "hangup" }]);
    expect(sessions.get("c1")).toMatchObject({ ended: true, endedBy: "agent_end" });
    const call = usage.callEvents("c1").find((e) => e.kind === "call");
    expect(call).toMatchObject({ endedBy: "agent_end", turns: 1, phone: PHONE });
    expect(new Date((call as { endedAt: string }).endedAt).getTime()).toBeGreaterThanOrEqual(new Date((call as { startedAt: string }).startedAt).getTime());
  });

  it("speaks an apology when the agent promise rejects", async () => {
    const { agent, respond } = fakeAgent();
    respond.mockRejectedValue(new Error("boom"));
    const flow = makeFlow(agent);
    await flow.handle(pbx("c1"));
    const res = mods(await flow.handle(pbx("c1", { utt_1: "שאלה" })));
    expect(res[0]).toMatchObject({ type: "simpleMessage" });
    expect(res[1]).toMatchObject({ type: "stt", name: "utt_2" });
    expect(logs.log.error).toHaveBeenCalled();
    expect(sessions.get("c1")?.ended).toBe(false);
  });

  it("re-prompts on an empty utterance and hangs up after maxSilentTurns", async () => {
    const { agent, respond } = fakeAgent();
    const flow = makeFlow(agent);
    await flow.handle(pbx("c1"));
    expect(settings.get().maxSilentTurns).toBe(2);

    const first = mods(await flow.handle(pbx("c1", { utt_1: "" })));
    expect(first).toEqual([{ type: "simpleMessage", files: [{ text: "לא שמעתי. אפשר לחזור?" }] }, { type: "stt", name: "utt_2", max: settings.get().sttMaxSeconds, confirm: "no" }]);
    expect(respond).not.toHaveBeenCalled();

    const second = mods(await flow.handle(pbx("c1", { utt_1: "", utt_2: "   " })));
    expect(second[1]).toMatchObject({ type: "stt", name: "utt_3" });
    expect(sessions.get("c1")).toMatchObject({ silentTurns: 2, ended: false });

    const third = mods(await flow.handle(pbx("c1", { utt_1: "", utt_2: "", utt_3: "" })));
    expect(third[0]).toMatchObject({ type: "simpleMessage" });
    expect(JSON.stringify(third[0])).toContain(settings.get().goodbye);
    expect(third[1]).toEqual({ type: "hangup" });
    expect(sessions.get("c1")).toMatchObject({ ended: true, endedBy: "silence" });
    expect(usage.callEvents("c1").find((e) => e.kind === "call")).toMatchObject({ endedBy: "silence", turns: 0 });
    expect(respond).not.toHaveBeenCalled();
  });

  it("resets the silence counter once the caller speaks", async () => {
    const { agent, respond } = fakeAgent();
    respond.mockResolvedValue(reply("כן"));
    const flow = makeFlow(agent);
    await flow.handle(pbx("c1"));
    await flow.handle(pbx("c1", { utt_1: "" }));
    await flow.handle(pbx("c1", { utt_1: "", utt_2: "שלום" }));
    expect(sessions.get("c1")?.silentTurns).toBe(0);
    const res = mods(await flow.handle(pbx("c1", { utt_1: "", utt_2: "שלום", utt_3: "" })));
    expect(res[1]).toMatchObject({ type: "stt", name: "utt_4" });
    expect(sessions.get("c1")?.ended).toBe(false);
  });

  it("closes the session on HANGUP and returns an empty object", async () => {
    const { agent } = fakeAgent();
    const flow = makeFlow(agent);
    await flow.handle(pbx("c1"));
    const res = await flow.handle(pbx("c1", { PBXcallStatus: "HANGUP" }));
    expect(res).toEqual({});
    expect(sessions.get("c1")).toMatchObject({ ended: true, endedBy: "caller_hangup" });
    expect(usage.callEvents("c1").find((e) => e.kind === "call")).toMatchObject({ endedBy: "caller_hangup", callId: "c1", phone: PHONE });
    // A second HANGUP does not record a second call event.
    expect(await flow.handle(pbx("c1", { PBXcallStatus: "HANGUP" }))).toEqual({});
    expect(usage.callEvents("c1").filter((e) => e.kind === "call")).toHaveLength(1);
  });

  it("ignores a HANGUP for an unknown call without creating a session", async () => {
    const { agent, newConversation } = fakeAgent();
    const flow = makeFlow(agent);
    expect(await flow.handle(pbx("ghost", { PBXcallStatus: "HANGUP" }))).toEqual({});
    expect(sessions.size()).toBe(0);
    expect(newConversation).not.toHaveBeenCalled();
    expect(usage.callEvents("ghost")).toEqual([]);
  });

  it("does not record a second call event after the agent already ended the call", async () => {
    const { agent, respond } = fakeAgent();
    respond.mockResolvedValue(reply("ביי", true));
    const flow = makeFlow(agent);
    await flow.handle(pbx("c1"));
    await flow.handle(pbx("c1", { utt_1: "ביי" }));
    await flow.handle(pbx("c1", { utt_1: "ביי", PBXcallStatus: "HANGUP" }));
    const calls = usage.callEvents("c1").filter((e) => e.kind === "call");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ endedBy: "agent_end" });
  });

  it("recovers a call after a restart from the newest utt_N parameter without greeting again", async () => {
    const { agent, respond, newConversation } = fakeAgent();
    respond.mockResolvedValue(reply("ממשיכים"));
    const flow = makeFlow(agent);
    const res = mods(await flow.handle(pbx("c-restart", { utt_1: "ראשון", utt_2: "שני", utt_3: "שלח לי סיכום" })));
    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond.mock.calls[0]![1]).toBe("שלח לי סיכום");
    expect(newConversation).toHaveBeenCalledWith("c-restart", PHONE);
    expect(res).toEqual([
      { type: "simpleMessage", files: [{ text: "ממשיכים" }] },
      { type: "stt", name: "utt_4", max: settings.get().sttMaxSeconds, confirm: "no" },
    ]);
    expect(JSON.stringify(res)).not.toContain(settings.get().greeting);
    expect(sessions.get("c-restart")).toMatchObject({ turns: 3, expectedParam: "utt_4", utteranceIndex: 4 });
    expect(logs.log.warn).toHaveBeenCalledWith(expect.objectContaining({ callId: "c-restart", param: "utt_3" }), expect.stringMatching(/recovered/));
  });

  it("does not count empty earlier utterances as turns when recovering after a restart", async () => {
    const { agent, respond } = fakeAgent();
    respond.mockResolvedValue(reply("ממשיכים"));
    const flow = makeFlow(agent);
    const res = mods(await flow.handle(pbx("c-restart", { utt_1: "ראשון", utt_2: "", utt_3: "   ", utt_4: "רביעי" })));
    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond.mock.calls[0]![1]).toBe("רביעי");
    expect(res[1]).toMatchObject({ type: "stt", name: "utt_5" });
    // utt_1 and utt_4 were spoken; utt_2 / utt_3 were silence re-prompts.
    expect(sessions.get("c-restart")).toMatchObject({ turns: 2, expectedParam: "utt_5", utteranceIndex: 5 });
  });

  it("enforces the maximum number of turns", async () => {
    settings.update({ maxTurns: 1 });
    const { agent, respond } = fakeAgent();
    respond.mockResolvedValue(reply("תשובה"));
    const flow = makeFlow(agent);
    await flow.handle(pbx("c1"));
    await flow.handle(pbx("c1", { utt_1: "אחת" }));
    const res = mods(await flow.handle(pbx("c1", { utt_1: "אחת", utt_2: "שתיים" })));
    expect(res[1]).toEqual({ type: "hangup" });
    expect(sessions.get("c1")).toMatchObject({ ended: true, endedBy: "max_turns" });
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it("keeps calls independent of each other", async () => {
    const { agent, respond } = fakeAgent();
    respond.mockImplementation(async (_conv, text) => reply(`הד: ${text}`));
    const flow = makeFlow(agent);
    await flow.handle(pbx("a"));
    await flow.handle(pbx("b"));
    const ra = mods(await flow.handle(pbx("a", { utt_1: "אלף" })));
    const rb = mods(await flow.handle(pbx("b", { utt_1: "בית" })));
    expect(ra[0]).toEqual({ type: "simpleMessage", files: [{ text: "הד: אלף" }] });
    expect(rb[0]).toEqual({ type: "simpleMessage", files: [{ text: "הד: בית" }] });
    expect(respond.mock.calls[0]![0]).not.toBe(respond.mock.calls[1]![0]);
    expect(sessions.active()).toHaveLength(2);
  });
});
