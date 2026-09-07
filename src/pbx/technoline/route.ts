import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Logger } from "../../logger.js";
import type { SettingsStore } from "../../config.js";
import { isPhoneAllowed, sha256 } from "../../config.js";
import type { UsageStore } from "../../usage/usage-store.js";
import type { VoiceAgent, AgentReply } from "../../agent/agent.js";
import type { CallSession, SessionStore } from "../../calls/session.js";
import { parsePbxRequest, latestNumberedParam } from "./request.js";
import type { PbxRequest, PbxResponse } from "./types.js";
import { chain, getDigits, hangup, listen, menu, say, sayItems } from "./builder.js";

export interface TechnolineDeps {
  agent: VoiceAgent;
  sessions: SessionStore;
  settings: SettingsStore;
  usage: UsageStore;
  logger: Logger;
  webhookSecret: string;
  longPollMs: number;
  /** Shorter wait on the request that carries the utterance, so fast answers need no filler but slow ones don't leave dead air. */
  firstPollMs?: number;
  publicBaseUrl: string;
}

const FILLERS = ["רק רגע, אני בודק.", "עוד רגע.", "עדיין בודק, תודה על הסבלנות."];
const UTT = "utt";

function sleep(ms: number): Promise<null> {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms));
}

/** Counts the `utt_N` parameters below `before` that carry text (empty ones were silence re-prompts). */
function countSpokenUtterances(params: Record<string, string>, before: number): number {
  let n = 0;
  for (let i = 1; i < before; i++) if ((params[`${UTT}_${i}`] ?? "").trim()) n++;
  return n;
}

/**
 * The call flow, driven by the PBX polling our URL (see docs/technoline-api-module.md):
 *
 *   1st request            -> greeting + stt(utt_1)
 *   utt_1 arrives          -> start Claude in the background, wait up to longPollMs
 *        done in time      -> [say(answer), stt(utt_2)]   (or [say(answer), hangup])
 *        still thinking    -> say(filler)  -> PBX calls again with the same params -> keep waiting
 *   PBXcallStatus=HANGUP   -> {} and the session is closed
 *
 * The PBX accumulates every module result in the query string, so each utterance gets a
 * unique parameter name (utt_N) and the session remembers which ones were consumed.
 */
export class TechnolineCallFlow {
  constructor(private readonly d: TechnolineDeps) {
    // A call whose HANGUP never arrived (PBX restart, network) is still recorded when it expires.
    d.sessions.setExpiryHandler((session) => this.finalize(session, "timeout"));
  }

  async handle(req: PbxRequest): Promise<PbxResponse | Record<string, never>> {
    const { sessions, logger } = this.d;
    if (req.status === "HANGUP") {
      const s = sessions.get(req.callId);
      if (s) this.finalize(s, "caller_hangup");
      return {};
    }
    let session = sessions.get(req.callId);
    if (!session) {
      session = sessions.create(req.callId, req.phone, this.d.agent.newConversation(req.callId, req.phone));
      // Server restarted mid-call: pick up the newest utterance instead of greeting again.
      const latest = latestNumberedParam(req.params, UTT);
      if (latest) {
        session.utteranceIndex = latest.index;
        session.expectedParam = latest.name;
        // Every earlier utt_N is still in the query string; only the ones with text were real turns.
        session.turns = countSpokenUtterances(req.params, latest.index);
        // A PIN the caller already entered is still in the query string too.
        const pinHash = this.d.settings.get().pinHash;
        const latestPin = latestNumberedParam(req.params, "pin");
        if (pinHash && latestPin) {
          session.pinAttempts = latestPin.index;
          session.consumed.add(latestPin.name);
          if (sha256((req.params[latestPin.name] ?? "").replace(/\D/g, "")) === pinHash) session.authorized = true;
        }
        logger.warn({ callId: req.callId, param: latest.name, turns: session.turns, authorized: session.authorized }, "recovered call without session state");
      }
    }
    if (session.ended) return hangup();
    return this.step(session, req);
  }

  private async step(session: CallSession, req: PbxRequest): Promise<PbxResponse> {
    const s = this.d.settings.get();
    const voice = s.ttsVoice || undefined;

    /* ---------- 1. authorisation (caller allow-list + optional PIN) ---------- */
    if (!session.authorized) {
      if (!isPhoneAllowed(req.phone, s.allowedPhones)) {
        this.d.logger.warn({ callId: req.callId, phone: req.phone }, "caller not in allow-list");
        this.finalize(session, "unauthorized");
        return chain(say("מצטער, המספר הזה לא מורשה להשתמש בעוזר. להתראות.", { voice }), hangup());
      }
      if (s.pinHash) {
        const expecting = session.expectedParam;
        if (expecting?.startsWith("pin_") && req.params[expecting] !== undefined && !session.consumed.has(expecting)) {
          session.consumed.add(expecting);
          const entered = (req.params[expecting] ?? "").replace(/\D/g, "");
          if (entered && sha256(entered) === s.pinHash) {
            session.authorized = true;
            session.expectedParam = null;
          } else {
            session.pinAttempts += 1;
            if (session.pinAttempts >= s.maxPinAttempts) {
              this.finalize(session, "pin_failed");
              return chain(say("קוד שגוי. להתראות.", { voice }), hangup());
            }
            return this.askPin(session, "קוד שגוי. נסו שוב.", voice);
          }
        } else {
          return this.askPin(session, "הקישו את קוד הגישה, ולסיום סולמית.", voice);
        }
      } else {
        session.authorized = true;
      }
    }

    /* ---------- 2. Claude is still working on the previous utterance ---------- */
    if (session.pending) return this.waitOrFiller(session);

    /* ---------- 3. a new utterance arrived ---------- */
    const expected = session.expectedParam;
    if (expected?.startsWith(`${UTT}_`)) {
      if (req.params[expected] !== undefined && !session.consumed.has(expected)) {
        session.consumed.add(expected);
        const text = (req.params[expected] ?? "").trim();
        // DIGIT_utt_N carries the key pressed to confirm a recording; we send confirm:"no",
        // so a value here means the PBX ignored it and the caller had to press a key.
        if ((req.params[`DIGIT_${expected}`] ?? "").trim() && !session.consumed.has("__digit_warned")) {
          session.consumed.add("__digit_warned");
          this.d.logger.warn({ callId: req.callId, digit: req.params[`DIGIT_${expected}`] }, "PBX asked the caller to confirm the recording - stt confirm:\"no\" seems unsupported");
        }
        if (!text) {
          session.silentTurns += 1;
          if (session.silentTurns > s.maxSilentTurns) {
            this.finalize(session, "silence");
            return chain(say(`לא שמעתי אותך. ${s.goodbye}`, { voice }), hangup());
          }
          return this.listenNext(session, "לא שמעתי. אפשר לחזור?", voice);
        }
        session.silentTurns = 0;
        session.turns += 1;
        if (session.turns > s.maxTurns) {
          this.finalize(session, "max_turns");
          return chain(say(`הגענו למגבלת השיחה. ${s.goodbye}`, { voice }), hangup());
        }
        this.startJob(session, text);
        // Music mode: answer at once with a 1-second menu that switches hold music on,
        // so the caller hears music (not silence) during every following long poll.
        if (s.fillerMode === "music") return this.waitMenu(session);
        return this.waitOrFiller(session);
      }
      // The PBX came back without the value we asked for (timeout / no speech): ask again.
      session.silentTurns += 1;
      if (session.silentTurns > s.maxSilentTurns) {
        this.finalize(session, "silence");
        return chain(say(s.goodbye, { voice }), hangup());
      }
      return this.listenNext(session, "אני מקשיב.", voice);
    }

    /* ---------- 4. fresh call ---------- */
    return this.listenNext(session, s.greeting, voice);
  }

  private askPin(session: CallSession, prompt: string, voice?: string): PbxResponse {
    const name = `pin_${session.pinAttempts + 1}`;
    session.expectedParam = name;
    return getDigits(name, { max: 8, min: 1, timeout: 10, skipKey: "#", prompt, confirmType: "no", voice });
  }

  private listenNext(session: CallSession, prompt: string | null, voice?: string): PbxResponse {
    const s = this.d.settings.get();
    session.utteranceIndex += 1;
    const name = `${UTT}_${session.utteranceIndex}`;
    session.expectedParam = name;
    return chain(prompt ? say(prompt, { voice }) : null, listen(name, { maxSeconds: s.sttMaxSeconds }));
  }

  private startJob(session: CallSession, text: string): void {
    const job = {
      utterance: text,
      startedAt: Date.now(),
      fillers: 0,
      result: null as AgentReply | null,
      promise: Promise.resolve<AgentReply | null>(null) as Promise<AgentReply>,
      abort: new AbortController(),
    };
    job.promise = this.d.agent
      .respond(session.conv, text, { phone: session.phone }, { signal: job.abort.signal })
      .catch((err: unknown): AgentReply => {
        this.d.logger.error({ callId: session.callId, err: err instanceof Error ? err.message : String(err) }, "agent crashed");
        return { text: "משהו השתבש אצלי. אפשר לחזור על הבקשה?", endCall: false, iterations: 0, toolCalls: [], durationMs: Date.now() - job.startedAt, error: String(err) };
      })
      .then((r) => {
        job.result = r;
        return r;
      });
    session.pending = job;
    this.d.logger.info({ callId: session.callId, turn: session.turns, text }, "utterance");
  }

  /**
   * A menu nobody is meant to press: it times out after one second and returns
   * `wait_N_M=WAIT`, and its setMusic flag makes the PBX play hold music while it waits
   * for our (long-polling) reply to that request. Unique names keep the accumulated
   * query parameters from colliding.
   */
  private waitMenu(session: CallSession): PbxResponse {
    const job = session.pending;
    const name = `wait_${session.utteranceIndex}_${job ? job.fillers + 1 : 0}`;
    if (job) job.fillers += 1;
    return menu(name, { enabledKeys: "#", timeout: 1, times: 1, errorReturn: "WAIT", setMusic: "yes" });
  }

  private async waitOrFiller(session: CallSession): Promise<PbxResponse> {
    const job = session.pending!;
    const s = this.d.settings.get();
    const voice = s.ttsVoice || undefined;
    // First wait is short so a slow answer does not mean 20 s of dead air before the first filler.
    const waitMs = job.fillers === 0 ? Math.min(this.d.firstPollMs ?? this.d.longPollMs, this.d.longPollMs) : this.d.longPollMs;
    const result = job.result ?? (await Promise.race([job.promise, sleep(waitMs)]));
    if (!result) {
      job.fillers += 1;
      this.d.logger.info({ callId: session.callId, fillers: job.fillers, waitedMs: Date.now() - job.startedAt }, "agent still working - sending filler");
      if (s.fillerMode === "music") return this.waitMenu(session);
      if (s.fillerMode === "silence" && this.d.publicBaseUrl) {
        return sayItems([{ fileLink: `${this.d.publicBaseUrl}/audio/silence.wav`, fileName: "mainbot_silence_3s" }]);
      }
      return say(FILLERS[(job.fillers - 1) % FILLERS.length]!, { voice });
    }
    session.pending = null;
    this.d.logger.info({ callId: session.callId, ms: result.durationMs, tools: result.toolCalls, endCall: result.endCall }, "reply");
    if (result.endCall) {
      this.finalize(session, "agent_end");
      return chain(say(result.text, { voice }), hangup());
    }
    return this.listenNext(session, result.text, voice);
  }

  finalize(session: CallSession, reason: string): void {
    if (session.ended) return;
    session.ended = true;
    session.endedBy = reason;
    // Nobody will hear the answer: stop the model and tool loop instead of paying for it.
    if (session.pending && !session.pending.result) {
      this.d.logger.info({ callId: session.callId, reason }, "cancelling the pending agent turn");
      session.pending.abort.abort();
    }
    // Keep the ended session briefly so the trailing HANGUP request is recognised, then drop it.
    setTimeout(() => this.d.sessions.delete(session.callId), 60_000).unref();
    this.d.logger.info({ callId: session.callId, reason, turns: session.turns }, "call ended");
    try {
      this.d.usage.recordCall({
        callId: session.callId,
        phone: session.phone,
        startedAt: session.startedAt.toISOString(),
        endedAt: new Date().toISOString(),
        turns: session.turns,
        endedBy: reason,
      });
    } catch (err) {
      // A full disk must never change what the PBX hears.
      this.d.logger.error({ callId: session.callId, err: err instanceof Error ? err.message : String(err) }, "could not record the call in the usage log");
    }
  }
}

/** Parses an application/x-www-form-urlencoded body into a plain object (no dependency needed). */
export function parseFormBody(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(body)) out[k] = v;
  return out;
}

export function registerTechnolineRoutes(app: FastifyInstance, deps: TechnolineDeps): TechnolineCallFlow {
  const flow = new TechnolineCallFlow(deps);
  const secretOk = (secret: string | undefined): boolean => {
    if (!deps.webhookSecret || !secret) return false;
    const a = Buffer.from(secret);
    const b = Buffer.from(deps.webhookSecret);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    const { secret } = request.params as { secret?: string };
    if (!secretOk(secret)) {
      deps.logger.warn({ ip: request.ip }, "PBX request with bad secret");
      return reply.code(403).send({});
    }
    const query = { ...(request.query as Record<string, unknown>), ...((request.body as Record<string, unknown> | null) ?? {}) };
    const req = parsePbxRequest(query);
    if (!req.callId) return reply.code(400).send({});
    try {
      const response = await flow.handle(req);
      return reply.header("Content-Type", "application/json; charset=utf-8").send(response);
    } catch (err) {
      deps.logger.error({ err: err instanceof Error ? err.stack : String(err), callId: req.callId }, "PBX handler failed");
      // After HANGUP there is no caller: the PBX must get an empty 200, never a module.
      if (req.status === "HANGUP") return reply.header("Content-Type", "application/json; charset=utf-8").send({});
      return reply.header("Content-Type", "application/json; charset=utf-8").send(chain(say("אירעה שגיאה. נסו שוב מאוחר יותר."), hangup()));
    }
  };
  // The PBX uses GET; the POST variant accepts JSON or form bodies for manual testing. The form
  // parser lives in this encapsulated plugin only: the admin API must keep rejecting form
  // bodies, or a cross-site form post with the browser's cached Basic credentials could drive it.
  void app.register(async (pbx) => {
    pbx.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
      try {
        done(null, parseFormBody(String(body)));
      } catch (err) {
        done(err as Error, undefined);
      }
    });
    pbx.get("/pbx/technoline/:secret", handler);
    pbx.post("/pbx/technoline/:secret", handler);
  });
  return flow;
}
