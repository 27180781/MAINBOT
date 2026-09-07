import Anthropic from "@anthropic-ai/sdk";
import type { Logger } from "../logger.js";
import type { McpHub, CatalogTool } from "../mcp/hub.js";
import { ConfirmationGate } from "../mcp/tool-policy.js";
import type { Settings, SettingsStore } from "../config.js";
import type { UsageStore } from "../usage/usage-store.js";
import { buildSystemPrompt, buildCallContext, type CallContext } from "./prompt.js";
import { LOCAL_TOOLS, PROACTIVE_TOOLS, END_CALL_TOOL, LOCAL_TOOL_NAMES, LOCAL_WRITE_TOOLS, runLocalTool } from "./local-tools.js";
import type { RulesStore } from "./rules.js";
import type { RoutineStore, NotifyChannel } from "../routines/store.js";
import type { Notifier } from "../routines/notify.js";

type BetaMessageParam = Anthropic.Beta.BetaMessageParam;
type BetaToolUnion = Anthropic.Beta.BetaToolUnion;
type BetaToolUseBlock = Anthropic.Beta.BetaToolUseBlock;
type BetaToolResultBlockParam = Anthropic.Beta.BetaToolResultBlockParam;

export interface ConversationState {
  callId: string;
  phone: string;
  messages: BetaMessageParam[];
  /** Caller-turn counter (one per utterance). */
  turn: number;
  gate: ConfirmationGate;
  contextSent: boolean;
  /**
   * System prompt and tool list frozen for the whole call: rebuilding them mid-call
   * (a rule saved by the caller, a server reconnecting) would invalidate the prompt
   * cache and, on models that bind thinking blocks to the prompt, fail the request.
   * New calls pick up the latest prompt.
   */
  systemPrompt: string;
  tools: BetaToolUnion[];
  channel: Channel;
  /** proactive = a routine run with nobody on the line: read-only tools plus notify_owner. */
  mode: "interactive" | "proactive";
  /** Owner notifications sent during this conversation (proactive runs). */
  notifications: Array<{ channel: string; ok: boolean; detail: string }>;
  routineId?: string;
  routineChannel?: NotifyChannel;
}

/** What the Messages API accepts per model family (see the claude-api reference). */
export interface ModelCapabilities {
  adaptiveThinking: boolean;
  /** Effort levels the model accepts; empty = do not send output_config.effort. */
  efforts: readonly string[];
  /** Server-side refusal fallbacks ("default") are documented for these families only. */
  fallbacks: boolean;
}

export function modelCapabilities(model: string): ModelCapabilities {
  const m = model.toLowerCase();
  if (/^claude-(opus|fable|mythos)-5/.test(m)) return { adaptiveThinking: true, efforts: ["low", "medium", "high", "xhigh", "max"], fallbacks: /^claude-(opus|fable|mythos)-5/.test(m) };
  if (/^claude-sonnet-5/.test(m) || /^claude-(opus|sonnet)-4-[78]/.test(m)) return { adaptiveThinking: true, efforts: ["low", "medium", "high", "xhigh", "max"], fallbacks: false };
  if (/^claude-(opus|sonnet)-4-6/.test(m)) return { adaptiveThinking: true, efforts: ["low", "medium", "high", "max"], fallbacks: false };
  if (/^claude-opus-4-5/.test(m)) return { adaptiveThinking: false, efforts: ["low", "medium", "high"], fallbacks: false };
  // Haiku 4.5, Sonnet 4.5 and older: manual thinking budgets only, no effort parameter.
  return { adaptiveThinking: false, efforts: [], fallbacks: false };
}

/** Clamps a requested effort to the closest level the model supports. */
export function clampEffort(effort: string, caps: ModelCapabilities): string | undefined {
  if (caps.efforts.length === 0) return undefined;
  if (caps.efforts.includes(effort)) return effort;
  const order = ["low", "medium", "high", "xhigh", "max"];
  const wanted = order.indexOf(effort);
  for (let i = wanted; i >= 0; i--) if (caps.efforts.includes(order[i]!)) return order[i];
  return caps.efforts[0];
}

export interface AgentReply {
  text: string;
  endCall: boolean;
  iterations: number;
  toolCalls: string[];
  durationMs: number;
  error?: string;
}

export interface VoiceAgentOptions {
  client: Anthropic;
  hub: McpHub;
  settings: SettingsStore;
  usage: UsageStore;
  rules: RulesStore;
  /** Optional: proactive routines (list/add from a call) and the owner notifier used by routine runs. */
  routines?: RoutineStore;
  notifier?: Notifier;
  logger: Logger;
  instructionsPath: string;
  timeZone: string;
  agentTimeoutMs: number;
  toolTimeoutMs: number;
}

const MAX_HISTORY_MESSAGES = 60;
const REFUSAL_TEXT = "מצטער, אני לא יכול לעזור עם הבקשה הזאת. יש משהו אחר?";

/**
 * One Claude "brain" shared by all calls. Each call keeps its own ConversationState;
 * the agent runs the tool loop (MCP tools + local tools) until Claude produces a
 * spoken answer, and records token usage for the admin dashboard.
 */
export type Channel = "voice" | "chat" | "proactive";

export class VoiceAgent {
  private systemPrompt = "";
  private chatPrompt = "";
  private proactivePrompt = "";
  private toolsCache: BetaToolUnion[] = [];
  private toolsCacheProactive: BetaToolUnion[] = [];
  private toolsCacheKey = "";
  private readonly log: Logger;

  constructor(private readonly o: VoiceAgentOptions) {
    this.log = o.logger;
    this.refresh();
    o.hub.onChange(() => this.refresh());
    o.settings.onChange(() => this.refresh());
    o.rules.onChange(() => this.refresh());
  }

  /** Rebuilds the system prompt and tool list (called when servers or settings change). */
  refresh(): void {
    const s = this.o.settings.get();
    const inputs = {
      servers: this.o.hub.status(),
      tools: this.o.hub.tools(),
      toolSearchEnabled: s.toolSearch,
      instructionsPath: this.o.instructionsPath,
      extraInstructions: s.extraInstructions,
      rulesText: this.o.rules.renderForPrompt(),
    };
    this.systemPrompt = buildSystemPrompt({ ...inputs, channel: "voice" });
    this.chatPrompt = buildSystemPrompt({ ...inputs, channel: "chat" });
    this.proactivePrompt = buildSystemPrompt({ ...inputs, channel: "proactive" });
    this.toolsCache = this.buildTools(s, this.o.hub.tools());
    this.toolsCacheProactive = this.buildTools(s, this.o.hub.tools(), "proactive");
    this.toolsCacheKey = `${s.toolSearch}:${s.toolSearchVariant}:${this.o.hub.tools().length}`;
  }

  getSystemPrompt(channel: Channel = "voice"): string {
    return channel === "chat" ? this.chatPrompt : channel === "proactive" ? this.proactivePrompt : this.systemPrompt;
  }

  /** Tool definitions offered to the model for the given channel. */
  getTools(channel: Channel = "voice"): BetaToolUnion[] {
    return channel === "proactive" ? this.toolsCacheProactive : this.toolsCache;
  }

  newConversation(callId: string, phone: string, opts: { channel?: Channel; routine?: { id: string; channel: NotifyChannel } } = {}): ConversationState {
    const s = this.o.settings.get();
    const channel = opts.channel ?? "voice";
    const proactive = channel === "proactive";
    return {
      callId,
      phone,
      messages: [],
      turn: 0,
      // Live options: blocking a tool or switching confirmations on from /admin applies to
      // conversations that are already open (CRM chat sessions live for hours).
      gate: new ConfirmationGate(() => {
        const live = this.o.settings.get();
        return { confirmWrites: live.confirmWrites, blockedTools: live.blockedTools };
      }),
      contextSent: false,
      systemPrompt: this.getSystemPrompt(channel),
      tools: this.getTools(channel),
      channel,
      mode: proactive ? "proactive" : "interactive",
      notifications: [],
      ...(opts.routine ? { routineId: opts.routine.id, routineChannel: opts.routine.channel } : {}),
    };
  }

  /** Request parameters that depend on the selected model and effort. */
  private modelParams(model: string, effort: string): { thinking?: Anthropic.Beta.BetaThinkingConfigParam; output_config?: Anthropic.Beta.BetaOutputConfig; fallbacks?: "default"; betas?: Anthropic.Beta.AnthropicBeta[] } {
    const caps = modelCapabilities(model);
    const out: ReturnType<VoiceAgent["modelParams"]> = {};
    if (caps.adaptiveThinking) out.thinking = { type: "adaptive" };
    const clamped = clampEffort(effort, caps);
    if (clamped) out.output_config = { effort: clamped as Anthropic.Beta.BetaOutputConfig["effort"] };
    if (caps.fallbacks && this.o.settings.get().fallbacks === "default") {
      out.fallbacks = "default";
      out.betas = ["server-side-fallback-2026-07-01" as Anthropic.Beta.AnthropicBeta];
    }
    return out;
  }

  /**
   * Interactive calls get every tool (writes are gated by spoken confirmation). Proactive runs
   * get only read tools - there is nobody to confirm a write - plus notify_owner.
   */
  private buildTools(s: Settings, catalog: CatalogTool[], mode: "interactive" | "proactive" = "interactive"): BetaToolUnion[] {
    const tools: BetaToolUnion[] = [];
    const proactive = mode === "proactive";
    if (proactive) catalog = catalog.filter((t) => t.kind !== "write");
    const useSearch = s.toolSearch && catalog.length > 0;
    if (useSearch) {
      tools.push(
        s.toolSearchVariant === "bm25"
          ? { type: "tool_search_tool_bm25_20251119", name: "tool_search_tool_bm25" }
          : { type: "tool_search_tool_regex_20251119", name: "tool_search_tool_regex" },
      );
    }
    if (proactive) tools.push(...LOCAL_TOOLS.filter((t) => t.name !== END_CALL_TOOL && !LOCAL_WRITE_TOOLS.has(t.name)), ...PROACTIVE_TOOLS);
    else tools.push(...LOCAL_TOOLS);
    for (const t of catalog) {
      const def: Anthropic.Beta.BetaTool = {
        name: t.fullName,
        description: describeTool(t),
        input_schema: (t.inputSchema ?? { type: "object" }) as Anthropic.Beta.BetaTool.InputSchema,
      };
      if (useSearch && !t.alwaysLoad) def.defer_loading = true;
      tools.push(def);
    }
    return tools;
  }

  /**
   * Handles one caller utterance and returns the text to speak. Never throws: errors
   * become a short spoken apology so the call keeps going.
   */
  async respond(conv: ConversationState, userText: string, ctx: Omit<CallContext, "now" | "timeZone">, opts: { signal?: AbortSignal } = {}): Promise<AgentReply> {
    const started = Date.now();
    const s = this.o.settings.get();
    conv.turn += 1;
    conv.gate.expire(conv.turn);
    await this.maybeCompact(conv, s);

    let content = userText.trim();
    if (!conv.contextSent) {
      content = `${buildCallContext({ ...ctx, now: new Date(), timeZone: this.o.timeZone })}\n\n${content}`;
      conv.contextSent = true;
    }
    conv.messages.push({ role: "user", content });

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.o.agentTimeoutMs);
    // The caller (PBX route) aborts the turn when the call is hung up mid-answer.
    if (opts.signal?.aborted) abort.abort();
    else opts.signal?.addEventListener("abort", () => abort.abort(), { once: true });
    const toolCalls: string[] = [];
    let endCall = false;
    let iterations = 0;
    let finalText = "";
    let error: string | undefined;

    let maxTokens = s.maxTokens;
    let budgetRetried = false;
    let contextRetried = false;
    try {
      while (iterations < s.maxIterationsPerTurn) {
        iterations++;
        const reqStarted = Date.now();
        const response = await this.o.client.beta.messages.create(
          {
            model: s.model,
            max_tokens: maxTokens,
            system: [{ type: "text", text: conv.systemPrompt, cache_control: { type: "ephemeral" } }],
            // Automatic breakpoint on the last cacheable block: the growing conversation (tool
            // results included) is read from cache on every iteration instead of re-sent in full.
            cache_control: { type: "ephemeral" },
            messages: conv.messages,
            tools: conv.tools,
            ...this.modelParams(s.model, s.effort),
          },
          { signal: abort.signal, timeout: 120_000 },
        );
        this.o.usage.recordLlm({
          callId: conv.callId,
          phone: conv.phone,
          requestedModel: s.model,
          servedModel: response.model,
          effort: s.effort,
          durationMs: Date.now() - reqStarted,
          stopReason: response.stop_reason,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
        });

        if (response.stop_reason === "refusal") {
          finalText = REFUSAL_TEXT;
          conv.messages.push({ role: "assistant", content: REFUSAL_TEXT });
          break;
        }

        // The whole context no longer fits: summarise and retry this iteration once.
        if (response.stop_reason === "model_context_window_exceeded" && !contextRetried) {
          contextRetried = true;
          this.log.warn({ callId: conv.callId }, "context window exceeded - compacting and retrying");
          await this.compact(conv, s, abort.signal);
          // compact() folds this turn into the summary and leaves the transcript on an assistant
          // message; put the caller's utterance back so the retry ends on a user turn (a trailing
          // assistant message is a prefill, rejected by current models) and still carries the question.
          conv.messages.push({ role: "user", content });
          continue;
        }

        const text = response.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        const toolUses = response.content.filter((b): b is BetaToolUseBlock => b.type === "tool_use");

        // Thinking ate the whole output budget (no text, no tool call): retry once with more room.
        if (response.stop_reason === "max_tokens" && !text && toolUses.length === 0 && !budgetRetried) {
          budgetRetried = true;
          maxTokens = Math.min(Math.max(maxTokens * 4, 8192), 32_000);
          this.log.warn({ callId: conv.callId, maxTokens }, "response truncated before any text - retrying with a larger max_tokens");
          continue;
        }

        conv.messages.push({ role: "assistant", content: response.content });
        if (text) finalText = text;

        if (response.stop_reason === "pause_turn") continue;
        if (toolUses.length === 0) break;

        const results = await Promise.all(
          toolUses.map(async (tu): Promise<BetaToolResultBlockParam> => {
            const input = (tu.input ?? {}) as Record<string, unknown>;
            if (tu.name === END_CALL_TOOL) {
              endCall = true;
              return { type: "tool_result", tool_use_id: tu.id, content: "The call will end after your message is spoken." };
            }
            toolCalls.push(tu.name);
            const r = LOCAL_TOOL_NAMES.has(tu.name) ? await this.executeLocalTool(conv, tu.name, input) : await this.executeTool(conv, tu.name, input);
            return { type: "tool_result", tool_use_id: tu.id, content: r.text, ...(r.isError ? { is_error: true } : {}) };
          }),
        );
        conv.messages.push({ role: "user", content: results });

        // The farewell was already spoken in this response; another round-trip would only add latency.
        if (endCall) break;
        if (response.stop_reason !== "tool_use") break;
      }
      if (!finalText) finalText = endCall ? s.goodbye : "לא הצלחתי לנסח תשובה. אפשר לחזור על הבקשה?";
    } catch (err) {
      const spoken = this.describeError(err, abort.signal.aborted);
      error = err instanceof Error ? err.message : String(err);
      this.log.error({ callId: conv.callId, err: error }, "agent turn failed");
      finalText = spoken;
      // Keep the transcript consistent: the last message must not be a dangling assistant tool_use.
      const last = conv.messages[conv.messages.length - 1];
      if (last?.role === "assistant" && Array.isArray(last.content) && last.content.some((b) => b.type === "tool_use")) conv.messages.pop();
      if (conv.messages[conv.messages.length - 1]?.role === "user") conv.messages.push({ role: "assistant", content: finalText });
    } finally {
      clearTimeout(timer);
    }

    const durationMs = Date.now() - started;
    this.o.usage.recordTurn({ callId: conv.callId, phone: conv.phone, turn: conv.turn, userText, assistantText: finalText, durationMs });
    return { text: finalText, endCall, iterations, toolCalls, durationMs, error };
  }

  private async executeTool(conv: ConversationState, fullName: string, input: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const tool = this.o.hub.tool(fullName);
    const started = Date.now();
    if (!tool) {
      this.o.usage.recordTool({ callId: conv.callId, phone: conv.phone, tool: fullName, server: "?", durationMs: 0, ok: false });
      return { text: `Unknown tool "${fullName}". Search for the correct tool name first.`, isError: true };
    }
    if (conv.mode === "proactive" && tool.kind === "write") {
      this.log.info({ callId: conv.callId, tool: fullName }, "write tool refused in proactive run");
      this.o.usage.recordTool({ callId: conv.callId, phone: conv.phone, tool: fullName, server: tool.server, durationMs: 0, ok: true, blocked: true, reason: "proactive" });
      return { text: "Write tools are not available in proactive runs (nobody is on the line to confirm). Suggest this action to the owner in your notify_owner message instead.", isError: true };
    }
    const decision = conv.gate.check(
      { name: tool.name, annotations: tool.annotations, inputSchema: tool.inputSchema as { properties?: Record<string, unknown> } },
      fullName,
      input,
      conv.turn,
      tool.serverReadOnly,
    );
    if (!decision.allowed) {
      this.log.info({ callId: conv.callId, tool: fullName, reason: decision.reason }, "tool call gated");
      this.o.usage.recordTool({ callId: conv.callId, phone: conv.phone, tool: fullName, server: tool.server, durationMs: 0, ok: true, blocked: true, reason: decision.reason });
      return { text: decision.message ?? "Not allowed.", isError: decision.reason !== "confirmation_required" };
    }
    const outcome = await this.o.hub.callTool(fullName, input, this.o.toolTimeoutMs);
    this.o.usage.recordTool({ callId: conv.callId, phone: conv.phone, tool: fullName, server: tool.server, durationMs: Date.now() - started, ok: !outcome.isError });
    this.log.info({ callId: conv.callId, tool: fullName, ms: outcome.durationMs, error: outcome.isError }, "tool call");
    return outcome;
  }

  /** Rule / routine tools: writes go through the same spoken-confirmation gate as MCP write tools. */
  private async executeLocalTool(conv: ConversationState, name: string, input: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const isWrite = LOCAL_WRITE_TOOLS.has(name);
    if (conv.mode === "proactive" && isWrite) {
      this.o.usage.recordTool({ callId: conv.callId, phone: conv.phone, tool: name, server: "local", durationMs: 0, ok: true, blocked: true, reason: "proactive" });
      return { text: "This tool is not available in proactive runs. Suggest the change to the owner instead.", isError: true };
    }
    // notify_owner is the one "write" a proactive run may do; it is never gated (no caller to confirm).
    const decision = name === "notify_owner" ? { allowed: true as const } : conv.gate.check({ name, annotations: { readOnlyHint: !isWrite, destructiveHint: isWrite } }, name, input, conv.turn, false);
    if (!decision.allowed) {
      this.log.info({ callId: conv.callId, tool: name, reason: decision.reason }, "local tool call gated");
      this.o.usage.recordTool({ callId: conv.callId, phone: conv.phone, tool: name, server: "local", durationMs: 0, ok: true, blocked: true, reason: decision.reason });
      return { text: decision.message ?? "Not allowed.", isError: decision.reason !== "confirmation_required" };
    }
    const started = Date.now();
    const s = this.o.settings.get();
    const r = await runLocalTool(name, input, {
      rules: this.o.rules,
      routines: this.o.routines,
      notifier: this.o.notifier,
      mode: conv.mode,
      source: conv.mode === "proactive" ? conv.phone : conv.channel === "chat" ? `chat:${conv.phone}` : `phone:${conv.phone}`,
      callId: conv.callId,
      routineChannel: conv.routineChannel,
      defaultChannel: s.notifyChannel,
      notifications: conv.notifications,
    });
    this.o.usage.recordTool({ callId: conv.callId, phone: conv.phone, tool: name, server: "local", durationMs: Date.now() - started, ok: !r.isError });
    this.log.info({ callId: conv.callId, tool: name, error: r.isError }, "local tool call");
    return r;
  }

  private describeError(err: unknown, aborted = false): string {
    // The SDK raises APIUserAbortError (an APIError subclass) when our timeout fires, so check it first.
    if (aborted || err instanceof Anthropic.APIUserAbortError || (err instanceof Error && err.name === "AbortError")) return "הפעולה לקחה יותר מדי זמן. אפשר לנסות בקשה קטנה יותר?";
    if (err instanceof Anthropic.AuthenticationError) return "יש בעיה בהגדרות החיבור למנוע הבינה. כדאי לבדוק את מפתח ה-API.";
    if (err instanceof Anthropic.RateLimitError) return "יש עומס רגעי על המערכת. נסו שוב בעוד רגע.";
    if (err instanceof Anthropic.BadRequestError) return "נתקלתי בשגיאה בבקשה. אפשר לנסח מחדש?";
    if (err instanceof Anthropic.APIConnectionError) return "אין לי כרגע חיבור למנוע הבינה. נסו שוב בעוד רגע.";
    if (err instanceof Anthropic.APIError) return "המערכת החזירה שגיאה. נסו שוב.";
    return "משהו השתבש אצלי. אפשר לחזור על הבקשה?";
  }

  /** Very long calls: summarise the transcript with the same model and start fresh. */
  private async maybeCompact(conv: ConversationState, s: Settings): Promise<void> {
    if (conv.messages.length < MAX_HISTORY_MESSAGES) return;
    await this.compact(conv, s);
  }

  private async compact(conv: ConversationState, s: Settings, signal?: AbortSignal): Promise<void> {
    try {
      const transcript = conv.messages
        .map((m) => {
          const text = typeof m.content === "string" ? m.content : m.content.map((b) => (b.type === "text" ? b.text : b.type === "tool_use" ? `[tool ${b.name}]` : b.type === "tool_result" ? "[tool result]" : "")).join(" ");
          return `${m.role}: ${text}`;
        })
        .join("\n");
      const { fallbacks: _f, betas: _b, ...modelParams } = this.modelParams(s.model, "low");
      const res = await this.o.client.beta.messages.create(
        {
          model: s.model,
          // Thinking shares this budget with the visible summary, so leave it room.
          max_tokens: 4000,
          ...modelParams,
          messages: [{ role: "user", content: `סכם את השיחה הבאה בעברית ב-10 שורות לכל היותר, כולל עובדות, החלטות ופעולות שבוצעו או שממתינות לאישור:\n\n${transcript.slice(-40_000)}` }],
        },
        { signal, timeout: 60_000 },
      );
      const summary = res.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
      if (res.stop_reason !== "end_turn" || !summary) throw new Error(`compaction returned stop_reason=${res.stop_reason} with ${summary.length} chars`);
      this.o.usage.recordLlm({
        callId: conv.callId,
        phone: conv.phone,
        requestedModel: s.model,
        servedModel: res.model,
        effort: "low",
        durationMs: 0,
        stopReason: res.stop_reason,
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
        cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
      });
      conv.messages = [
        { role: "user", content: `[סיכום החלק הקודם של השיחה]\n${summary}\n[סוף סיכום]` },
        { role: "assistant", content: "הבנתי, ממשיכים." },
      ];
    } catch (err) {
      this.log.warn({ err: err instanceof Error ? err.message : String(err) }, "compaction failed - keeping a text-only tail instead");
      conv.messages = textOnlyTail(conv.messages, 12);
    }
  }
}

/**
 * Fallback history when summarising fails: the last `turns` caller/assistant exchanges
 * as plain text. Thinking, tool_use and tool_result blocks are dropped on purpose - a
 * truncated history must not carry thinking blocks bound to context that is gone.
 */
export function textOnlyTail(messages: BetaMessageParam[], turns: number): BetaMessageParam[] {
  const out: BetaMessageParam[] = [];
  for (const m of messages) {
    const text = typeof m.content === "string" ? m.content : m.content.filter((b): b is Anthropic.Beta.BetaTextBlockParam => b.type === "text").map((b) => b.text).join("\n");
    if (!text.trim()) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content = `${last.content as string}\n${text}`;
    else out.push({ role: m.role, content: text });
  }
  // Start on a user message and end on an assistant message.
  while (out.length && out[0]!.role !== "user") out.shift();
  const tail = out.slice(-(turns * 2));
  while (tail.length && tail[0]!.role !== "user") tail.shift();
  if (tail.length && tail[tail.length - 1]!.role === "user") tail.pop();
  return tail;
}

function describeTool(t: CatalogTool): string {
  const desc = (t.description || "").trim();
  const tag = t.kind === "write" ? "[write]" : "[read]";
  return `${tag} (${t.server}) ${desc || t.name}`.slice(0, 2000);
}
