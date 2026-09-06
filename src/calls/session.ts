import type { AgentReply, ConversationState } from "../agent/agent.js";

export interface PendingJob {
  utterance: string;
  startedAt: number;
  fillers: number;
  promise: Promise<AgentReply>;
  result: AgentReply | null;
}

export interface CallSession {
  callId: string;
  phone: string;
  startedAt: Date;
  lastActivity: number;
  conv: ConversationState;
  authorized: boolean;
  pinAttempts: number;
  /** Query parameter we are waiting for (`utt_3`, `pin_1`). */
  expectedParam: string | null;
  /** Parameters already handled (the PBX re-sends every accumulated value on each request). */
  consumed: Set<string>;
  utteranceIndex: number;
  pending: PendingJob | null;
  silentTurns: number;
  turns: number;
  ended: boolean;
  endedBy: string | null;
}

export class SessionStore {
  private readonly sessions = new Map<string, CallSession>();

  constructor(private readonly ttlMs: number) {}

  get(callId: string): CallSession | undefined {
    const s = this.sessions.get(callId);
    if (s) s.lastActivity = Date.now();
    return s;
  }

  create(callId: string, phone: string, conv: ConversationState): CallSession {
    const s: CallSession = {
      callId,
      phone,
      startedAt: new Date(),
      lastActivity: Date.now(),
      conv,
      authorized: false,
      pinAttempts: 0,
      expectedParam: null,
      consumed: new Set(),
      utteranceIndex: 0,
      pending: null,
      silentTurns: 0,
      turns: 0,
      ended: false,
      endedBy: null,
    };
    this.sessions.set(callId, s);
    return s;
  }

  delete(callId: string): void {
    this.sessions.delete(callId);
  }

  size(): number {
    return this.sessions.size;
  }

  active(): CallSession[] {
    return [...this.sessions.values()].filter((s) => !s.ended);
  }

  /** Drops sessions idle for longer than the TTL; returns how many were removed. */
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
