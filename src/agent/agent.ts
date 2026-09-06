import Anthropic from "@anthropic-ai/sdk";
import type { Logger } from "../logger.js";
import type { McpHub, CatalogTool } from "../mcp/hub.js";
import { ConfirmationGate } from "../mcp/tool-policy.js";
import type { Settings, SettingsStore } from "../config.js";
import type { UsageStore } from "../usage/usage-store.js";
import { buildSystemPrompt, buildCallContext, type CallContext } from "./prompt.js";
import { LOCAL_TOOLS, END_CALL_TOOL, LOCAL_TOOL_NAMES, LOCAL_WRITE_TOOLS, runLocalTool } from "./local-tools.js";
import type { RulesStore } from "./rules.js";

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
export class VoiceAgent {
  private systemPrompt = "";
  private toolsCache: BetaToolUnion[] = [];
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
    this.systemPrompt = buildSystemPrompt({
      servers: this.o.hub.status(),
      tools: this.o.hub.tools(),
      toolSearchEnabled: s.toolSearch,
      instructionsPath: this.o.instructionsPath,
      extraInstructions: s.extraInstructions,
      rulesText: this.o.rules.renderForPrompt(),
    });
    this.toolsCache = this.buildTools(s, this.o.hub.tools());
    this.toolsCacheKey = `${s.toolSearch}:${s.toolSearchVariant}:${this.o.hub.tools().length}`;
  }

  getSystemPrompt(): string {
    return this.systemPrompt;
  }

  newConversation(callId: string, phone: string): ConversationState {
    const s = this.o.settings.get();
    return {
      callId,
      phone,
      messages: [],
      turn: 0,
      gate: new ConfirmationGate({ confirmWrites: s.confirmWrites, blockedTools: s.blockedTools }),
      contextSent: false,
    };
  }

  private buildTools(s: Settings, catalog: CatalogTool[]): BetaToolUnion[] {
    const tools: BetaToolUnion[] = [];
    const useSearch = s.toolSearch && catalog.length > 0;
    if (useSearch) {
      tools.push(
        s.toolSearchVariant === "bm25"
          ? { type: "tool_search_tool_bm25_20251119", name: "tool_search_tool_bm25" }
          : { type: "tool_search_tool_regex_20251119", name: "tool_search_tool_regex" },
      );
    }
    tools.push(...LOCAL_TOOLS);
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
  async respond(conv: ConversationState, userText: string, ctx: Omit<CallContext, "now" | "timeZone">): Promise<AgentReply> {
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
    const toolCalls: string[] = [];
    let endCall = false;
    let iterations = 0;
    let finalText = "";
    let error: string | undefined;

    try {
      while (iterations < s.maxIterationsPerTurn) {
        iterations++;
        const reqStarted = Date.now();
        const betas: string[] = [];
        if (s.fallbacks === "default") betas.push("server-side-fallback-2026-07-01");
        const response = await this.o.client.beta.messages.create(
          {
            model: s.model,
            max_tokens: s.maxTokens,
            system: [{ type: "text", text: this.systemPrompt, cache_control: { type: "ephemeral" } }],
            messages: conv.messages,
            tools: this.toolsCache,
            thinking: { type: "adaptive" },
            output_config: { effort: s.effort },
            ...(s.fallbacks === "default" ? { fallbacks: "default" as const } : {}),
            ...(betas.length ? { betas: betas as Anthropic.Beta.AnthropicBeta[] } : {}),
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

        conv.messages.push({ role: "assistant", content: response.content });
        const text = response.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        if (text) finalText = text;

        if (response.stop_reason === "pause_turn") continue;

        const toolUses = response.content.filter((b): b is BetaToolUseBlock => b.type === "tool_use");
        if (toolUses.length === 0) break;

        const results = await Promise.all(
          toolUses.map(async (tu): Promise<BetaToolResultBlockParam> => {
            const input = (tu.input ?? {}) as Record<string, unknown>;
            if (tu.name === END_CALL_TOOL) {
              endCall = true;
              return { type: "tool_result", tool_use_id: tu.id, content: "The call will end after your message is spoken." };
            }
            toolCalls.push(tu.name);
            const r = LOCAL_TOOL_NAMES.has(tu.name) ? this.executeLocalTool(conv, tu.name, input) : await this.executeTool(conv, tu.name, input);
            return { type: "tool_result", tool_use_id: tu.id, content: r.text, ...(r.isError ? { is_error: true } : {}) };
          }),
        );
        conv.messages.push({ role: "user", content: results });

        if (response.stop_reason !== "tool_use") break;
      }
      if (!finalText) finalText = endCall ? s.goodbye : "לא הצלחתי לנסח תשובה. אפשר לחזור על הבקשה?";
    } catch (err) {
      const spoken = this.describeError(err);
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
    const decision = conv.gate.check(
      { name: tool.name, annotations: tool.annotations, inputSchema: tool.inputSchema as { properties?: Record<string, unknown> } },
      fullName,
      input,
      conv.turn,
      tool.serverReadOnly,
    );
    if (!decision.allowed) {
      this.log.info({ callId: conv.callId, tool: fullName, reason: decision.reason }, "tool call gated");
      this.o.usage.recordTool({ callId: conv.callId, phone: conv.phone, tool: fullName, server: tool.server, durationMs: 0, ok: true, blocked: true });
      return { text: decision.message ?? "Not allowed.", isError: decision.reason !== "confirmation_required" };
    }
    const outcome = await this.o.hub.callTool(fullName, input, this.o.toolTimeoutMs);
    this.o.usage.recordTool({ callId: conv.callId, phone: conv.phone, tool: fullName, server: tool.server, durationMs: Date.now() - started, ok: !outcome.isError });
    this.log.info({ callId: conv.callId, tool: fullName, ms: outcome.durationMs, error: outcome.isError }, "tool call");
    return outcome;
  }

  /** Rule tools: writes go through the same spoken-confirmation gate as MCP write tools. */
  private executeLocalTool(conv: ConversationState, name: string, input: Record<string, unknown>): { text: string; isError: boolean } {
    const isWrite = LOCAL_WRITE_TOOLS.has(name);
    const decision = conv.gate.check({ name, annotations: { readOnlyHint: !isWrite, destructiveHint: isWrite } }, name, input, conv.turn, false);
    if (!decision.allowed) {
      this.log.info({ callId: conv.callId, tool: name, reason: decision.reason }, "local tool call gated");
      this.o.usage.recordTool({ callId: conv.callId, phone: conv.phone, tool: name, server: "local", durationMs: 0, ok: true, blocked: true });
      return { text: decision.message ?? "Not allowed.", isError: decision.reason !== "confirmation_required" };
    }
    const started = Date.now();
    const r = runLocalTool(name, input, this.o.rules, `phone:${conv.phone}`);
    this.o.usage.recordTool({ callId: conv.callId, phone: conv.phone, tool: name, server: "local", durationMs: Date.now() - started, ok: !r.isError });
    this.log.info({ callId: conv.callId, tool: name, error: r.isError }, "local tool call");
    return r;
  }

  private describeError(err: unknown): string {
    if (err instanceof Anthropic.AuthenticationError) return "יש בעיה בהגדרות החיבור למנוע הבינה. כדאי לבדוק את מפתח ה-API.";
    if (err instanceof Anthropic.RateLimitError) return "יש עומס רגעי על המערכת. נסו שוב בעוד רגע.";
    if (err instanceof Anthropic.BadRequestError) return "נתקלתי בשגיאה בבקשה. אפשר לנסח מחדש?";
    if (err instanceof Anthropic.APIConnectionError) return "אין לי כרגע חיבור למנוע הבינה. נסו שוב בעוד רגע.";
    if (err instanceof Anthropic.APIError) return "המערכת החזירה שגיאה. נסו שוב.";
    if (err instanceof Error && err.name === "AbortError") return "הפעולה לקחה יותר מדי זמן. אפשר לנסות בקשה קטנה יותר?";
    return "משהו השתבש אצלי. אפשר לחזור על הבקשה?";
  }

  /** Very long calls: summarise the transcript with the same model and start fresh. */
  private async maybeCompact(conv: ConversationState, s: Settings): Promise<void> {
    if (conv.messages.length < MAX_HISTORY_MESSAGES) return;
    try {
      const transcript = conv.messages
        .map((m) => {
          const text = typeof m.content === "string" ? m.content : m.content.map((b) => (b.type === "text" ? b.text : b.type === "tool_use" ? `[tool ${b.name}]` : b.type === "tool_result" ? "[tool result]" : "")).join(" ");
          return `${m.role}: ${text}`;
        })
        .join("\n");
      const res = await this.o.client.beta.messages.create({
        model: s.model,
        max_tokens: 1500,
        output_config: { effort: "low" },
        messages: [{ role: "user", content: `סכם את השיחה הבאה בעברית ב-10 שורות לכל היותר, כולל עובדות, החלטות ופעולות שבוצעו או שממתינות לאישור:\n\n${transcript.slice(-40_000)}` }],
      });
      const summary = res.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("\n");
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
      this.log.warn({ err: err instanceof Error ? err.message : String(err) }, "compaction failed - dropping oldest turns instead");
      conv.messages = conv.messages.slice(-20);
      // Never start with a tool_result-only user message
      while (conv.messages.length && (conv.messages[0]!.role !== "user" || typeof conv.messages[0]!.content !== "string")) conv.messages.shift();
    }
  }
}

function describeTool(t: CatalogTool): string {
  const desc = (t.description || "").trim();
  const tag = t.kind === "write" ? "[write]" : "[read]";
  return `${tag} (${t.server}) ${desc || t.name}`.slice(0, 2000);
}
