import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Logger } from "../../logger.js";
import type { SettingsStore } from "../../config.js";
import { isPhoneAllowed, sha256 } from "../../config.js";
import type { UsageStore } from "../../usage/usage-store.js";
import type { VoiceAgent, AgentReply } from "../../agent/agent.js";
import type { CallSession, SessionStore } from "../../calls/session.js";
import { parsePbxRequest, latestNumberedParam } from "./request.js";
import type { PbxRequest, PbxResponse } from "./types.js";
import { chain, getDigits, hangup, listen, say, sayItems } from "./builder.js";

export interface TechnolineDeps {
  agent: VoiceAgent;
  sessions: SessionStore;
  settings: SettingsStore;
  usage: UsageStore;
  logger: Logger;
  webhookSecret: string;
  longPollMs: number;
  publicBaseUrl: string;
}

const FILLERS = ["רק רגע, אני בודק.", "עוד רגע.", "עדיין בודק, תודה על הסבלנות."];
const UTT = "utt";

function sleep(ms: number): Promise<null> {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms));
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
  constructor(private readonly d: TechnolineDeps) {}

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
        session.turns = latest.index - 1;
        logger.warn({ callId: req.callId, param: latest.name }, "recovered call without session state");
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
    };
    job.promise = this.d.agent
      .respond(session.conv, text, { phone: session.phone })
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

  private async waitOrFiller(session: CallSession): Promise<PbxResponse> {
    const job = session.pending!;
    const s = this.d.settings.get();
    const voice = s.ttsVoice || undefined;
    const result = job.result ?? (await Promise.race([job.promise, sleep(this.d.longPollMs)]));
    if (!result) {
      job.fillers += 1;
      this.d.logger.info({ callId: session.callId, fillers: job.fillers, waitedMs: Date.now() - job.startedAt }, "agent still working - sending filler");
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
    this.d.usage.recordCall({
      callId: session.callId,
      phone: session.phone,
      startedAt: session.startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      turns: session.turns,
      endedBy: reason,
    });
    this.d.logger.info({ callId: session.callId, reason, turns: session.turns }, "call ended");
    // Keep the ended session briefly so the trailing HANGUP request is recognised, then drop it.
    setTimeout(() => this.d.sessions.delete(session.callId), 60_000).unref();
  }
}

export function registerTechnolineRoutes(app: FastifyInstance, deps: TechnolineDeps): TechnolineCallFlow {
  const flow = new TechnolineCallFlow(deps);
  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    const { secret } = request.params as { secret?: string };
    if (!deps.webhookSecret || secret !== deps.webhookSecret) {
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
      return reply.header("Content-Type", "application/json; charset=utf-8").send(chain(say("אירעה שגיאה. נסו שוב מאוחר יותר."), hangup()));
    }
  };
  app.get("/pbx/technoline/:secret", handler);
  app.post("/pbx/technoline/:secret", handler);
  return flow;
}
