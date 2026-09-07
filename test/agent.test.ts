import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { VoiceAgent } from "../src/agent/agent.js";
import { RulesStore } from "../src/agent/rules.js";
import { LOCAL_TOOLS } from "../src/agent/local-tools.js";
import { RoutineStore } from "../src/routines/store.js";
import { Notifier } from "../src/routines/notify.js";
import type { CatalogTool, McpHub, McpServerStatus } from "../src/mcp/hub.js";
import { SettingsStore } from "../src/config.js";
import { UsageStore } from "../src/usage/usage-store.js";
import type { Logger } from "../src/logger.js";

type Block = Record<string, unknown>;
type MessageParam = { role: "user" | "assistant"; content: string | Block[] };

const CATALOG: CatalogTool[] = [
  {
    fullName: "crm__search_contacts",
    server: "crm",
    name: "search_contacts",
    description: "Search contacts by free text",
    inputSchema: { type: "object", properties: { q: { type: "string" } } },
    annotations: undefined,
    kind: "read",
    alwaysLoad: true,
    serverReadOnly: false,
  },
  {
    fullName: "crm__list_statuses",
    server: "crm",
    name: "list_statuses",
    description: "List status keys",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    kind: "read",
    alwaysLoad: false,
    serverReadOnly: false,
  },
  {
    fullName: "crm__send_whatsapp",
    server: "crm",
    name: "send_whatsapp",
    description: "Send a WhatsApp message",
    inputSchema: { type: "object", properties: { to: { type: "string" }, text: { type: "string" } } },
    annotations: undefined,
    kind: "write",
    alwaysLoad: false,
    serverReadOnly: false,
  },
  {
    fullName: "crm__delete_contact",
    server: "crm",
    name: "delete_contact",
    description: "Delete a contact",
    inputSchema: { type: "object", properties: { id: { type: "string" } } },
    annotations: { destructiveHint: true },
    kind: "write",
    alwaysLoad: false,
    serverReadOnly: false,
  },
];

const STATUS: McpServerStatus[] = [
  { name: "crm", label: "CRM חוויה בקליק", url: "https://crm.example/mcp", enabled: true, authType: "oauth", state: "connected", toolCount: CATALOG.length },
  { name: "github", label: "GitHub", url: "https://api.githubcopilot.com/mcp/", enabled: false, authType: "bearer", state: "disabled", toolCount: 0 },
];

function fakeHub() {
  const callTool = vi.fn(async (_name: string, _input: Record<string, unknown>, _timeoutMs?: number) => ({ text: "tool says hi", isError: false, durationMs: 2 }));
  const onChange = vi.fn();
  const hub = {
    tools: () => CATALOG,
    tool: (fullName: string) => CATALOG.find((t) => t.fullName === fullName),
    callTool,
    status: () => STATUS,
    onChange,
  };
  return { hub: hub as unknown as McpHub, callTool, onChange };
}

function fakeLogger() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn(), child: vi.fn() };
  log.child.mockReturnValue(log);
  return { logger: log as unknown as Logger, log };
}

let msgCounter = 0;
function apiReply(content: Block[], stop_reason = "end_turn", over: Record<string, unknown> = {}) {
  msgCounter += 1;
  return {
    id: `msg_${msgCounter}`,
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 },
    ...over,
  };
}
const text = (t: string): Block => ({ type: "text", text: t });
const toolUse = (id: string, name: string, input: Record<string, unknown> = {}): Block => ({ type: "tool_use", id, name, input });

/** Every assistant tool_use must be answered by a matching tool_result in the very next user message. */
function assertTranscriptConsistent(messages: MessageParam[]) {
  expect(messages.length).toBeGreaterThan(0);
  expect(messages[0]!.role).toBe("user");
  expect(messages.at(-1)!.role).toBe("assistant");
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    expect(m.role, `message ${i} alternates`).toBe(i % 2 === 0 ? "user" : "assistant");
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    const uses = m.content.filter((b) => b.type === "tool_use").map((b) => b.id);
    if (!uses.length) continue;
    const next = messages[i + 1];
    expect(next, `tool_use in message ${i} has a following message`).toBeDefined();
    expect(next!.role).toBe("user");
    const results = (next!.content as Block[]).filter((b) => b.type === "tool_result").map((b) => b.tool_use_id);
    expect(results.sort()).toEqual([...uses].sort());
  }
}

describe("VoiceAgent", () => {
  let dir: string;
  let settings: SettingsStore;
  let usage: UsageStore;
  let rules: RulesStore;
  let create: ReturnType<typeof vi.fn>;
  let client: Anthropic;
  let hubParts: ReturnType<typeof fakeHub>;
  let logs: ReturnType<typeof fakeLogger>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mainbot-agent-"));
    fs.writeFileSync(path.join(dir, "instructions.md"), "המקדמה היא 200 שקלים.", "utf8");
    settings = new SettingsStore(dir);
    usage = new UsageStore(dir);
    rules = new RulesStore(dir);
    create = vi.fn();
    client = { beta: { messages: { create } } } as unknown as Anthropic;
    hubParts = fakeHub();
    logs = fakeLogger();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeAgent(over: Partial<{ agentTimeoutMs: number; toolTimeoutMs: number; instructionsPath: string; routines: RoutineStore; notifier: Notifier }> = {}) {
    return new VoiceAgent({
      client,
      hub: hubParts.hub,
      settings,
      usage,
      rules,
      routines: over.routines,
      notifier: over.notifier,
      logger: logs.logger,
      instructionsPath: over.instructionsPath ?? path.join(dir, "instructions.md"),
      timeZone: "Asia/Jerusalem",
      agentTimeoutMs: over.agentTimeoutMs ?? 5000,
      toolTimeoutMs: over.toolTimeoutMs ?? 1234,
    });
  }

  const firstRequest = () => create.mock.calls[0]![0] as Record<string, any>;

  it("subscribes to hub and settings changes and builds a cacheable system prompt", () => {
    const agent = makeAgent();
    expect(hubParts.onChange).toHaveBeenCalledTimes(1);
    const prompt = agent.getSystemPrompt();
    expect(prompt).toContain("העוזר החכם");
    expect(prompt).toContain("CRM חוויה בקליק");
    expect(prompt).toContain("crm__search_contacts"); // always-loaded tools are listed
    expect(prompt).not.toContain("crm__send_whatsapp");
    expect(prompt).not.toContain("GitHub (");
    expect(prompt).toContain("tool search");
    expect(prompt).toContain("המקדמה היא 200 שקלים.");
    expect(prompt).toContain("עדיין לא נשמרו כללים קבועים.");
    // Per-call context (caller number, date, time) never goes into the cached system prompt.
    expect(prompt).not.toContain("מספר המתקשר:");
    expect(prompt).not.toContain("[סוף הקשר]");

    settings.update({ extraInstructions: "תמיד תסיים בברכה." });
    expect(agent.getSystemPrompt()).toContain("תמיד תסיים בברכה.");
  });

  it("sends the request with cached system, adaptive thinking, effort, tool search and deferred tools", async () => {
    const agent = makeAgent();
    create.mockResolvedValueOnce(apiReply([text("היי, במה אפשר לעזור?")]));
    const conv = agent.newConversation("call-1", "0501234567");
    const reply = await agent.respond(conv, "שלום", { phone: "0501234567" });
    expect(reply.text).toBe("היי, במה אפשר לעזור?");
    expect(reply.endCall).toBe(false);
    expect(reply.iterations).toBe(1);
    expect(reply.toolCalls).toEqual([]);
    expect(reply.error).toBeUndefined();

    expect(create).toHaveBeenCalledTimes(1);
    const req = firstRequest();
    const opts = create.mock.calls[0]![1] as { signal: AbortSignal; timeout: number };
    expect(req.model).toBe(settings.get().model);
    expect(req.max_tokens).toBe(settings.get().maxTokens);
    expect(req.system).toEqual([{ type: "text", text: agent.getSystemPrompt(), cache_control: { type: "ephemeral" } }]);
    expect(req.cache_control).toEqual({ type: "ephemeral" });
    expect(req.thinking).toEqual({ type: "adaptive" });
    expect(req).not.toHaveProperty("thinking.budget_tokens");
    expect(req.output_config).toEqual({ effort: settings.get().effort });
    expect(req.fallbacks).toBe("default");
    expect(req.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(req.messages).toBe(conv.messages);
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(opts.timeout).toBe(120_000);

    const tools = req.tools as Array<Record<string, unknown>>;
    expect(tools[0]).toEqual({ type: "tool_search_tool_regex_20251119", name: "tool_search_tool_regex" });
    expect(tools.filter((t) => String(t.type ?? "").startsWith("tool_search"))).toHaveLength(1);
    const byName = new Map(tools.map((t) => [t.name as string, t]));
    expect(byName.get("end_call")).toBeDefined();
    expect(byName.get("end_call")).not.toHaveProperty("defer_loading");
    expect(byName.get("crm__search_contacts")).not.toHaveProperty("defer_loading");
    expect(byName.get("crm__list_statuses")).toMatchObject({ defer_loading: true });
    expect(byName.get("crm__send_whatsapp")).toMatchObject({ defer_loading: true, description: expect.stringContaining("[write]") });
    expect(byName.get("crm__search_contacts")).toMatchObject({ description: expect.stringContaining("[read]"), input_schema: { type: "object" } });
    for (const local of LOCAL_TOOLS) {
      expect(byName.get(local.name), local.name).toBeDefined();
      expect(byName.get(local.name), local.name).not.toHaveProperty("defer_loading");
    }
    expect(tools).toHaveLength(1 + LOCAL_TOOLS.length + CATALOG.length);
  });

  it("omits fallbacks and the beta header when fallbacks are off", async () => {
    settings.update({ fallbacks: "off", effort: "high" });
    const agent = makeAgent();
    create.mockResolvedValueOnce(apiReply([text("ok")]));
    await agent.respond(agent.newConversation("c", "p"), "היי", { phone: "p" });
    const req = firstRequest();
    expect(req).not.toHaveProperty("fallbacks");
    expect(req).not.toHaveProperty("betas");
    expect(req.output_config).toEqual({ effort: "high" });
  });

  it("switches to the bm25 search tool or to no search tool according to settings", async () => {
    settings.update({ toolSearchVariant: "bm25" });
    let agent = makeAgent();
    create.mockResolvedValue(apiReply([text("ok")]));
    await agent.respond(agent.newConversation("c", "p"), "היי", { phone: "p" });
    expect((firstRequest().tools as Block[])[0]).toEqual({ type: "tool_search_tool_bm25_20251119", name: "tool_search_tool_bm25" });

    create.mockClear();
    settings.update({ toolSearch: false });
    agent = makeAgent();
    await agent.respond(agent.newConversation("c", "p"), "היי", { phone: "p" });
    const tools = firstRequest().tools as Block[];
    expect(tools.some((t) => String(t.type ?? "").startsWith("tool_search"))).toBe(false);
    expect(tools.some((t) => t.defer_loading)).toBe(false);
    expect(tools[0]).toMatchObject({ name: "end_call" });
  });

  it("runs a read tool through the hub and feeds the result back before answering", async () => {
    const agent = makeAgent();
    create
      .mockResolvedValueOnce(apiReply([text("רגע, בודק."), toolUse("tu_1", "crm__search_contacts", { q: "דוד" })], "tool_use"))
      .mockResolvedValueOnce(apiReply([text("מצאתי את דוד כהן.")]));
    const conv = agent.newConversation("call-2", "0501234567");
    const reply = await agent.respond(conv, "תמצא את דוד", { phone: "0501234567" });

    expect(reply.text).toBe("מצאתי את דוד כהן.");
    expect(reply.iterations).toBe(2);
    expect(reply.toolCalls).toEqual(["crm__search_contacts"]);
    expect(hubParts.callTool).toHaveBeenCalledTimes(1);
    expect(hubParts.callTool).toHaveBeenCalledWith("crm__search_contacts", { q: "דוד" }, 1234);

    const messages = conv.messages as MessageParam[];
    expect(messages).toHaveLength(4);
    expect(messages[1]).toEqual({ role: "assistant", content: [text("רגע, בודק."), toolUse("tu_1", "crm__search_contacts", { q: "דוד" })] });
    expect(messages[2]).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "tool says hi" }] });
    expect(messages[3]).toEqual({ role: "assistant", content: [text("מצאתי את דוד כהן.")] });
    assertTranscriptConsistent(messages);
    // The second request carried the whole transcript including the tool result.
    expect((create.mock.calls[1]![0] as Record<string, unknown>).messages).toBe(conv.messages);
  });

  it("marks tool errors with is_error and runs parallel tool calls together", async () => {
    hubParts.callTool.mockImplementation(async (name) => (name === "crm__list_statuses" ? { text: "Tool error: nope", isError: true, durationMs: 1 } : { text: "ok", isError: false, durationMs: 1 }));
    const agent = makeAgent();
    create
      .mockResolvedValueOnce(apiReply([toolUse("tu_a", "crm__search_contacts", { q: "x" }), toolUse("tu_b", "crm__list_statuses")], "tool_use"))
      .mockResolvedValueOnce(apiReply([text("סיימתי")]));
    const conv = agent.newConversation("c", "p");
    const reply = await agent.respond(conv, "היי", { phone: "p" });
    expect(reply.toolCalls).toEqual(["crm__search_contacts", "crm__list_statuses"]);
    expect(conv.messages[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu_a", content: "ok" },
        { type: "tool_result", tool_use_id: "tu_b", content: "Tool error: nope", is_error: true },
      ],
    });
  });

  it("gates a write tool on the first turn and executes it after the caller confirms", async () => {
    const agent = makeAgent();
    const conv = agent.newConversation("call-3", "0501234567");
    const send = toolUse("tu_w1", "crm__send_whatsapp", { to: "0521111111", text: "שלום" });

    // Turn 1: Claude wants to send -> gated, must ask the caller.
    create
      .mockResolvedValueOnce(apiReply([send], "tool_use"))
      .mockResolvedValueOnce(apiReply([text("לשלוח לדוד את ההודעה 'שלום'?")]));
    const turn1 = await agent.respond(conv, "שלח לדוד שלום", { phone: "0501234567" });
    expect(turn1.text).toBe("לשלוח לדוד את ההודעה 'שלום'?");
    expect(hubParts.callTool).not.toHaveBeenCalled();
    const gated = conv.messages[2] as MessageParam;
    expect(gated.role).toBe("user");
    const gatedResult = (gated.content as Block[])[0]!;
    expect(gatedResult).toMatchObject({ type: "tool_result", tool_use_id: "tu_w1" });
    expect(String(gatedResult.content)).toContain("CONFIRMATION REQUIRED");
    expect(gatedResult).not.toHaveProperty("is_error");
    expect(turn1.toolCalls).toEqual(["crm__send_whatsapp"]);
    expect(conv.gate.pendingCount()).toBe(1);

    // Turn 2: the caller confirms and Claude calls the same tool again -> executed.
    create
      .mockResolvedValueOnce(apiReply([{ ...send, id: "tu_w2" }], "tool_use"))
      .mockResolvedValueOnce(apiReply([text("נשלח.")]));
    const turn2 = await agent.respond(conv, "כן", { phone: "0501234567" });
    expect(turn2.text).toBe("נשלח.");
    expect(hubParts.callTool).toHaveBeenCalledTimes(1);
    expect(hubParts.callTool).toHaveBeenCalledWith("crm__send_whatsapp", { to: "0521111111", text: "שלום" }, 1234);
    expect(conv.messages[6]).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "tu_w2", content: "tool says hi" }] });
    expect(conv.gate.pendingCount()).toBe(0);
    expect(conv.turn).toBe(2);
    assertTranscriptConsistent(conv.messages as MessageParam[]);

    const toolEvents = usage.callEvents("call-3").filter((e) => e.kind === "tool");
    expect(toolEvents).toHaveLength(2);
    expect(toolEvents[0]).toMatchObject({ tool: "crm__send_whatsapp", blocked: true, ok: true });
    expect(toolEvents[1]).toMatchObject({ tool: "crm__send_whatsapp", ok: true });
    expect(toolEvents[1]).not.toHaveProperty("blocked");
  });

  it("refuses blocked tools with an error result", async () => {
    expect(settings.get().blockedTools).toContain("_delete_");
    const agent = makeAgent();
    create
      .mockResolvedValueOnce(apiReply([toolUse("tu_d", "crm__delete_contact", { id: "1" })], "tool_use"))
      .mockResolvedValueOnce(apiReply([text("אי אפשר מהטלפון.")]));
    const conv = agent.newConversation("c", "p");
    await agent.respond(conv, "תמחק את דוד", { phone: "p" });
    expect(hubParts.callTool).not.toHaveBeenCalled();
    expect((conv.messages[2] as MessageParam).content).toEqual([expect.objectContaining({ type: "tool_result", tool_use_id: "tu_d", is_error: true, content: expect.stringMatching(/blocked/i) })]);
  });

  it("answers unknown tools with an error result instead of calling the hub", async () => {
    const agent = makeAgent();
    create.mockResolvedValueOnce(apiReply([toolUse("tu_u", "crm__nonexistent", {})], "tool_use")).mockResolvedValueOnce(apiReply([text("x")]));
    const conv = agent.newConversation("c", "p");
    await agent.respond(conv, "היי", { phone: "p" });
    expect(hubParts.callTool).not.toHaveBeenCalled();
    expect((conv.messages[2] as MessageParam).content).toEqual([expect.objectContaining({ tool_use_id: "tu_u", is_error: true, content: expect.stringContaining("Unknown tool") })]);
  });

  it("sets endCall when Claude uses the local end_call tool", async () => {
    const agent = makeAgent();
    create.mockResolvedValueOnce(apiReply([text("להתראות ויום טוב!"), toolUse("tu_end", "end_call")], "tool_use")).mockResolvedValueOnce(apiReply([]));
    const conv = agent.newConversation("c", "p");
    const reply = await agent.respond(conv, "תודה, ביי", { phone: "p" });
    expect(reply.endCall).toBe(true);
    expect(reply.text).toBe("להתראות ויום טוב!");
    expect(reply.toolCalls).toEqual([]); // local tool, not an MCP call
    expect(hubParts.callTool).not.toHaveBeenCalled();
    expect((conv.messages[2] as MessageParam).content).toEqual([{ type: "tool_result", tool_use_id: "tu_end", content: expect.stringContaining("call will end") }]);
  });

  it("falls back to the goodbye text when end_call comes without any text", async () => {
    settings.update({ goodbye: "יאללה ביי." });
    const agent = makeAgent();
    create.mockResolvedValueOnce(apiReply([toolUse("tu_end", "end_call")], "tool_use")).mockResolvedValueOnce(apiReply([]));
    const reply = await agent.respond(agent.newConversation("c", "p"), "ביי", { phone: "p" });
    expect(reply).toMatchObject({ endCall: true, text: "יאללה ביי." });
  });

  it("speaks the apology on a refusal and keeps the transcript well-formed", async () => {
    const agent = makeAgent();
    create.mockResolvedValueOnce(apiReply([], "refusal"));
    const conv = agent.newConversation("c", "p");
    const reply = await agent.respond(conv, "משהו בעייתי", { phone: "p" });
    expect(reply.text).toBe("מצטער, אני לא יכול לעזור עם הבקשה הזאת. יש משהו אחר?");
    expect(reply.endCall).toBe(false);
    expect(reply.error).toBeUndefined();
    expect(conv.messages).toHaveLength(2);
    expect(conv.messages[1]).toEqual({ role: "assistant", content: reply.text });
    assertTranscriptConsistent(conv.messages as MessageParam[]);
  });

  it("keeps looping on pause_turn", async () => {
    const agent = makeAgent();
    create.mockResolvedValueOnce(apiReply([{ type: "server_tool_use", id: "st_1", name: "tool_search_tool_regex", input: { query: "sms" } }], "pause_turn")).mockResolvedValueOnce(apiReply([text("המשכתי")]));
    const conv = agent.newConversation("c", "p");
    const reply = await agent.respond(conv, "היי", { phone: "p" });
    expect(reply.text).toBe("המשכתי");
    expect(create).toHaveBeenCalledTimes(2);
    expect(conv.messages).toHaveLength(3); // user, assistant(paused, passed back unchanged), assistant(final)
    expect((conv.messages[1] as MessageParam).content).toEqual([{ type: "server_tool_use", id: "st_1", name: "tool_search_tool_regex", input: { query: "sms" } }]);
  });

  it("stops after maxIterationsPerTurn and still answers something", async () => {
    settings.update({ maxIterationsPerTurn: 2 });
    const agent = makeAgent();
    create.mockImplementation(async () => apiReply([toolUse(`tu_${Math.random()}`, "crm__search_contacts", { q: "x" })], "tool_use"));
    const conv = agent.newConversation("c", "p");
    const reply = await agent.respond(conv, "היי", { phone: "p" });
    expect(create).toHaveBeenCalledTimes(2);
    expect(reply.iterations).toBe(2);
    expect(reply.text.length).toBeGreaterThan(0);
  });

  it("turns a plain Error from the API into a spoken apology with a consistent transcript", async () => {
    const agent = makeAgent();
    create.mockRejectedValueOnce(new Error("boom"));
    const conv = agent.newConversation("c", "p");
    const reply = await agent.respond(conv, "היי", { phone: "p" });
    expect(reply.text).toBe("משהו השתבש אצלי. אפשר לחזור על הבקשה?");
    expect(reply.error).toBe("boom");
    expect(reply.endCall).toBe(false);
    expect(conv.messages).toHaveLength(2);
    expect(conv.messages[1]).toEqual({ role: "assistant", content: reply.text });
    expect(logs.log.error).toHaveBeenCalled();
    assertTranscriptConsistent(conv.messages as MessageParam[]);
  });

  it("maps SDK error classes to specific apologies", async () => {
    const agent = makeAgent();
    const conv = agent.newConversation("c", "p");
    const cases: Array<[Error, string]> = [
      [new Anthropic.RateLimitError(429, { type: "error", error: { type: "rate_limit_error", message: "slow down" } }, "slow down", new Headers()), "עומס"],
      [new Anthropic.AuthenticationError(401, { type: "error", error: { type: "authentication_error", message: "bad key" } }, "bad key", new Headers()), "מפתח"],
      [new Anthropic.BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message: "bad" } }, "bad", new Headers()), "לנסח"],
      [new Anthropic.APIConnectionError({ message: "no network" }), "חיבור"],
      [new Anthropic.InternalServerError(500, { type: "error", error: { type: "api_error", message: "oops" } }, "oops", new Headers()), "שגיאה"],
    ];
    for (const [err, expected] of cases) {
      create.mockRejectedValueOnce(err);
      const reply = await agent.respond(conv, "היי", { phone: "p" });
      expect(reply.text, err.constructor.name).toContain(expected);
      expect(reply.error).toBe(err.message);
    }
    assertTranscriptConsistent(conv.messages as MessageParam[]);
  });

  it("recovers from an API error in the middle of a tool loop without a dangling tool_use", async () => {
    const agent = makeAgent();
    create
      .mockResolvedValueOnce(apiReply([toolUse("tu_1", "crm__search_contacts", { q: "x" })], "tool_use"))
      .mockRejectedValueOnce(new Anthropic.RateLimitError(429, { type: "error", error: { type: "rate_limit_error", message: "slow down" } }, "slow down", new Headers()));
    const conv = agent.newConversation("c", "p");
    const reply = await agent.respond(conv, "היי", { phone: "p" });
    expect(reply.text).toBe("יש עומס רגעי על המערכת. נסו שוב בעוד רגע.");
    expect(reply.error).toContain("slow down");
    expect(hubParts.callTool).toHaveBeenCalledTimes(1);
    assertTranscriptConsistent(conv.messages as MessageParam[]);
    expect(conv.messages.at(-1)).toEqual({ role: "assistant", content: reply.text });

    // The conversation can continue normally afterwards.
    create.mockResolvedValueOnce(apiReply([text("עכשיו זה עובד")]));
    const next = await agent.respond(conv, "נסה שוב", { phone: "p" });
    expect(next.text).toBe("עכשיו זה עובד");
    assertTranscriptConsistent(conv.messages as MessageParam[]);
  });

  it("drops the assistant tool_use message when tool execution itself throws", async () => {
    hubParts.callTool.mockRejectedValueOnce(new Error("transport exploded"));
    const agent = makeAgent();
    create.mockResolvedValueOnce(apiReply([toolUse("tu_1", "crm__search_contacts", { q: "x" })], "tool_use"));
    const conv = agent.newConversation("c", "p");
    const reply = await agent.respond(conv, "היי", { phone: "p" });
    expect(reply.text).toBe("משהו השתבש אצלי. אפשר לחזור על הבקשה?");
    expect(reply.error).toBe("transport exploded");
    expect(conv.messages).toHaveLength(2);
    expect(conv.messages[0]!.role).toBe("user");
    expect(conv.messages[1]).toEqual({ role: "assistant", content: reply.text });
    assertTranscriptConsistent(conv.messages as MessageParam[]);
  });

  it("aborts a turn that exceeds agentTimeoutMs", async () => {
    const agent = makeAgent({ agentTimeoutMs: 30 });
    create.mockImplementation((_params: unknown, opts: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      opts.signal.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    }));
    const reply = await agent.respond(agent.newConversation("c", "p"), "היי", { phone: "p" });
    expect(reply.text).toContain("יותר מדי זמן");
    expect(reply.error).toBe("aborted");
  });

  it("records llm, tool and turn usage events for the call", async () => {
    const agent = makeAgent();
    create
      .mockResolvedValueOnce(apiReply([toolUse("tu_1", "crm__search_contacts", { q: "x" })], "tool_use", { model: "claude-opus-5-20260101" }))
      .mockResolvedValueOnce(apiReply([text("סיימתי")]));
    const conv = agent.newConversation("call-usage", "0501234567");
    const reply = await agent.respond(conv, "תחפש", { phone: "0501234567" });

    const events = usage.callEvents("call-usage");
    expect(events.map((e) => e.kind)).toEqual(["llm", "tool", "llm", "turn"]);
    expect(events[0]).toMatchObject({
      kind: "llm",
      callId: "call-usage",
      phone: "0501234567",
      requestedModel: settings.get().model,
      servedModel: "claude-opus-5-20260101",
      effort: settings.get().effort,
      stopReason: "tool_use",
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 50,
      cacheWriteTokens: 10,
    });
    expect((events[0] as { costUsd: number }).costUsd).toBeGreaterThan(0);
    expect(events[1]).toMatchObject({ kind: "tool", tool: "crm__search_contacts", server: "crm", ok: true });
    expect(events[2]).toMatchObject({ kind: "llm", stopReason: "end_turn" });
    expect(events[3]).toMatchObject({ kind: "turn", turn: 1, userText: "תחפש", assistantText: "סיימתי", durationMs: reply.durationMs });
    expect(usage.calls()[0]).toMatchObject({ callId: "call-usage", llmRequests: 2, toolCalls: 1, turns: 1 });
  });

  it("prepends the call context block to the first user message only", async () => {
    const agent = makeAgent();
    create.mockResolvedValue(apiReply([text("ok")]));
    const conv = agent.newConversation("c", "0501234567");
    await agent.respond(conv, "  שלום  ", { phone: "0501234567" });
    await agent.respond(conv, "עוד שאלה", { phone: "0501234567" });

    const first = conv.messages[0]!.content as string;
    const third = conv.messages[2]!.content as string;
    expect(first.split("[הקשר שיחה]").length - 1).toBe(1);
    expect(first).toContain("[סוף הקשר]");
    expect(first).toContain("מספר המתקשר: 0501234567");
    expect(first).toMatch(/תאריך: .*\(\d{4}-\d{2}-\d{2}\)/);
    expect(first).toMatch(/שעה בישראל: \d{2}:\d{2}/);
    expect(first.endsWith("\n\nשלום")).toBe(true);
    expect(third).toBe("עוד שאלה");
    expect(third).not.toContain("[הקשר שיחה]");
    expect(conv.contextSent).toBe(true);
    expect(conv.turn).toBe(2);
    expect(conv.messages.filter((m) => typeof m.content === "string" && m.content.includes("[הקשר שיחה]"))).toHaveLength(1);
  });

  it("uses the provided channel label in the context block", async () => {
    const agent = makeAgent();
    create.mockResolvedValue(apiReply([text("ok")]));
    const conv = agent.newConversation("admin-1", "admin-chat");
    await agent.respond(conv, "היי", { phone: "admin-chat", channel: "צ'אט בדיקה" });
    expect(conv.messages[0]!.content as string).toContain("ערוץ: צ'אט בדיקה");
  });

  it("runs list_rules locally without touching the hub", async () => {
    const agent = makeAgent();
    create.mockResolvedValueOnce(apiReply([toolUse("tu_lr", "list_rules")], "tool_use")).mockResolvedValueOnce(apiReply([text("אין כללים.")]));
    const conv = agent.newConversation("call-rules", "0501234567");
    const reply = await agent.respond(conv, "אילו כללים יש?", { phone: "0501234567" });
    expect(reply.text).toBe("אין כללים.");
    expect(reply.toolCalls).toEqual(["list_rules"]);
    expect(hubParts.callTool).not.toHaveBeenCalled();
    expect((conv.messages[2] as MessageParam).content).toEqual([{ type: "tool_result", tool_use_id: "tu_lr", content: "אין עדיין כללים קבועים." }]);
    expect(usage.callEvents("call-rules").filter((e) => e.kind === "tool")).toEqual([expect.objectContaining({ tool: "list_rules", server: "local", ok: true })]);
  });

  it("gates add_rule like a write tool and persists the rule once the caller confirms", async () => {
    const agent = makeAgent();
    const conv = agent.newConversation("call-rules", "0501234567");
    const add = toolUse("tu_r1", "add_rule", { text: "כשמדווחים על לידים, תמיד לציין את הטלפון." });

    create.mockResolvedValueOnce(apiReply([add], "tool_use")).mockResolvedValueOnce(apiReply([text("לשמור את הכלל?")]));
    await agent.respond(conv, "מעכשיו תמיד תגיד לי את הטלפון של הליד", { phone: "0501234567" });
    const gated = ((conv.messages[2] as MessageParam).content as Block[])[0]!;
    expect(String(gated.content)).toContain("CONFIRMATION REQUIRED");
    expect(gated).not.toHaveProperty("is_error");
    expect(rules.list()).toEqual([]);
    expect(agent.getSystemPrompt()).toContain("עדיין לא נשמרו כללים קבועים.");
    expect(usage.callEvents("call-rules").filter((e) => e.kind === "tool")).toEqual([expect.objectContaining({ tool: "add_rule", server: "local", blocked: true })]);

    create.mockResolvedValueOnce(apiReply([{ ...add, id: "tu_r2" }], "tool_use")).mockResolvedValueOnce(apiReply([text("נשמר.")]));
    const reply = await agent.respond(conv, "כן", { phone: "0501234567" });
    expect(reply.text).toBe("נשמר.");
    const result = ((conv.messages[6] as MessageParam).content as Block[])[0]!;
    expect(result).toMatchObject({ type: "tool_result", tool_use_id: "tu_r2" });
    expect(String(result.content)).toContain("נשמר ככלל 1");
    expect(result).not.toHaveProperty("is_error");
    expect(rules.list()).toEqual([expect.objectContaining({ id: 1, text: "כשמדווחים על לידים, תמיד לציין את הטלפון.", source: "phone:0501234567" })]);
    expect(new RulesStore(dir).list()).toEqual(rules.list()); // persisted to disk
    expect(agent.getSystemPrompt()).toContain("1. כשמדווחים על לידים, תמיד לציין את הטלפון."); // rules.onChange -> refresh
    expect(hubParts.callTool).not.toHaveBeenCalled();
    assertTranscriptConsistent(conv.messages as MessageParam[]);
  });

  it("reports rule tool failures as tool errors", async () => {
    settings.update({ confirmWrites: false });
    const agent = makeAgent();
    create.mockResolvedValueOnce(apiReply([toolUse("tu_rm", "remove_rule", { id: 99 })], "tool_use")).mockResolvedValueOnce(apiReply([text("אין כלל כזה.")]));
    const conv = agent.newConversation("c", "p");
    await agent.respond(conv, "תמחק כלל 99", { phone: "p" });
    expect((conv.messages[2] as MessageParam).content).toEqual([expect.objectContaining({ tool_use_id: "tu_rm", is_error: true, content: expect.stringContaining("Rule 99 does not exist") })]);
    expect(usage.callEvents("c").filter((e) => e.kind === "tool")).toEqual([expect.objectContaining({ tool: "remove_rule", server: "local", ok: false })]);
  });

  it("newConversation honours confirmWrites=false", async () => {
    settings.update({ confirmWrites: false });
    const agent = makeAgent();
    create.mockResolvedValueOnce(apiReply([toolUse("tu_w", "crm__send_whatsapp", { to: "x", text: "y" })], "tool_use")).mockResolvedValueOnce(apiReply([text("נשלח")]));
    const reply = await agent.respond(agent.newConversation("c", "p"), "שלח", { phone: "p" });
    expect(reply.text).toBe("נשלח");
    expect(hubParts.callTool).toHaveBeenCalledTimes(1);
  });

  describe("proactive runs (routines)", () => {
    const toolNames = (conv: { tools: unknown[] }) => conv.tools.map((t) => (t as { name?: string }).name ?? "");

    it("offers only read tools plus notify_owner, with the proactive prompt", () => {
      const agent = makeAgent({ routines: new RoutineStore(dir), notifier: new Notifier(hubParts.hub, settings, usage, logs.logger) });
      const conv = agent.newConversation("run-1", "routine:rt_1", { channel: "proactive", routine: { id: "rt_1", channel: "log" } });
      expect(conv).toMatchObject({ mode: "proactive", channel: "proactive", routineId: "rt_1", routineChannel: "log", notifications: [] });
      const names = toolNames(conv);
      expect(names).toEqual(expect.arrayContaining(["tool_search_tool_regex", "list_rules", "list_routines", "notify_owner", "crm__search_contacts", "crm__list_statuses"]));
      for (const n of ["end_call", "add_rule", "update_rule", "remove_rule", "add_routine", "remove_routine", "toggle_routine", "crm__send_whatsapp", "crm__delete_contact"]) expect(names).not.toContain(n);
      expect(conv.systemPrompt).toContain("מצב הרצה יזומה");
      expect(conv.systemPrompt).toContain("notify_owner");
      expect(conv.systemPrompt).not.toContain("end_call");
      expect(agent.getSystemPrompt("proactive")).toBe(conv.systemPrompt);
      // interactive conversations are untouched
      const voice = agent.newConversation("c", "p");
      expect(voice.mode).toBe("interactive");
      expect(toolNames(voice)).toEqual(expect.arrayContaining(["end_call", "add_rule", "add_routine", "crm__send_whatsapp"]));
      expect(toolNames(voice)).not.toContain("notify_owner");
    });

    it("delivers notify_owner once per run and refuses write tools", async () => {
      const notifier = new Notifier(hubParts.hub, settings, usage, logs.logger);
      const agent = makeAgent({ routines: new RoutineStore(dir), notifier });
      create
        .mockResolvedValueOnce(apiReply([toolUse("tu_read", "crm__search_contacts", { q: "לידים" }), toolUse("tu_wa", "crm__send_whatsapp", { to: "1", text: "x" }), toolUse("tu_rule", "add_rule", { text: "כלל" })], "tool_use"))
        .mockResolvedValueOnce(apiReply([toolUse("tu_n1", "notify_owner", { text: "יש 2 לידים חדשים: דני ורונית." }), toolUse("tu_n2", "notify_owner", { text: "שוב" })], "tool_use"))
        .mockResolvedValueOnce(apiReply([text("בדקתי לידים ושלחתי הודעה.")]));
      const conv = agent.newConversation("run-2", "routine:rt_2", { channel: "proactive", routine: { id: "rt_2", channel: "log" } });
      const reply = await agent.respond(conv, "[משימה יזומה] בדוק לידים", { phone: "routine:rt_2", channel: "הרצה יזומה" });
      expect(reply.text).toBe("בדקתי לידים ושלחתי הודעה.");
      expect(reply.toolCalls).toEqual(["crm__search_contacts", "crm__send_whatsapp", "add_rule", "notify_owner", "notify_owner"]);
      expect(hubParts.callTool).toHaveBeenCalledTimes(1); // only the read tool reached the hub
      const results1 = (conv.messages[2] as MessageParam).content as Block[];
      expect(results1).toEqual([
        expect.objectContaining({ tool_use_id: "tu_read", content: "tool says hi" }),
        expect.objectContaining({ tool_use_id: "tu_wa", is_error: true, content: expect.stringContaining("Write tools are not available in proactive runs") }),
        expect.objectContaining({ tool_use_id: "tu_rule", is_error: true, content: expect.stringContaining("not available in proactive runs") }),
      ]);
      const results2 = (conv.messages[4] as MessageParam).content as Block[];
      expect(results2).toEqual([
        expect.objectContaining({ tool_use_id: "tu_n1", content: "ההודעה נשלחה (log)." }),
        expect.objectContaining({ tool_use_id: "tu_n2", is_error: true, content: expect.stringContaining("already notified") }),
      ]);
      expect(conv.notifications).toEqual([{ channel: "log", ok: true, detail: "נרשם ביומן (ערוץ log)" }]);
      expect(usage.notifications(5)).toEqual([expect.objectContaining({ callId: "run-2", phone: "routine:rt_2", channel: "log", ok: true, text: "יש 2 לידים חדשים: דני ורונית." })]);
      expect(usage.callEvents("run-2").filter((e) => e.kind === "tool" && e.blocked)).toHaveLength(2);
      assertTranscriptConsistent(conv.messages as MessageParam[]);
    });

    it("rejects notify_owner outside proactive runs", async () => {
      const agent = makeAgent({ notifier: new Notifier(hubParts.hub, settings, usage, logs.logger) });
      create.mockResolvedValueOnce(apiReply([toolUse("tu_n", "notify_owner", { text: "x" })], "tool_use")).mockResolvedValueOnce(apiReply([text("אוקיי")]));
      const conv = agent.newConversation("c", "0501234567");
      await agent.respond(conv, "תשלח לי הודעה", { phone: "0501234567" });
      expect((conv.messages[2] as MessageParam).content).toEqual([expect.objectContaining({ is_error: true, content: expect.stringContaining("only available in proactive runs") })]);
      expect(conv.notifications).toEqual([]);
    });

    it("lets the caller create a routine by voice after a spoken confirmation", async () => {
      const routines = new RoutineStore(dir);
      settings.update({ notifyChannel: "whatsapp" });
      const agent = makeAgent({ routines });
      const args = { name: "תדריך בוקר", schedule_kind: "cron", cron_expression: "0 8 * * 0-4", prompt: "סכם לי את היום: פגישות, לידים חדשים ופניות שלא נענו." };
      create
        .mockResolvedValueOnce(apiReply([toolUse("tu_a1", "add_routine", args)], "tool_use"))
        .mockResolvedValueOnce(apiReply([text("אני אצור משימה בשם תדריך בוקר, כל יום ראשון עד חמישי בשמונה בבוקר, בוואטסאפ. לאשר?")]))
        .mockResolvedValueOnce(apiReply([toolUse("tu_a2", "add_routine", args)], "tool_use"))
        .mockResolvedValueOnce(apiReply([text("נוצר. מה עוד?")]))
        .mockResolvedValueOnce(apiReply([toolUse("tu_l", "list_routines", {})], "tool_use"))
        .mockResolvedValueOnce(apiReply([text("יש משימה אחת: תדריך בוקר.")]));
      const conv = agent.newConversation("c", "0501234567");
      const ask = await agent.respond(conv, "כל בוקר תשלח לי סיכום של היום", { phone: "0501234567" });
      expect(ask.text).toContain("לאשר?");
      expect(routines.list()).toEqual([]);
      expect(String(((conv.messages[2] as MessageParam).content as Block[])[0]!.content)).toContain("CONFIRMATION REQUIRED");

      const done = await agent.respond(conv, "כן", { phone: "0501234567" });
      expect(done.text).toBe("נוצר. מה עוד?");
      expect(routines.list()).toEqual([expect.objectContaining({ name: "תדריך בוקר", channel: "whatsapp", source: "phone:0501234567", schedule: { kind: "cron", expression: "0 8 * * 0-4" }, enabled: true })]);
      const created = ((conv.messages[6] as MessageParam).content as Block[])[0]!;
      expect(String(created.content)).toContain(`נוצרה משימה ${routines.list()[0]!.id}`);

      await agent.respond(conv, "אילו משימות יש?", { phone: "0501234567" });
      const listed = ((conv.messages[10] as MessageParam).content as Block[])[0]!;
      expect(String(listed.content)).toContain("תדריך בוקר");
      expect(usage.callEvents("c").filter((e) => e.kind === "tool").map((e) => [e.tool, e.blocked ?? false])).toEqual([["add_routine", true], ["add_routine", false], ["list_routines", false]]);
      assertTranscriptConsistent(conv.messages as MessageParam[]);
    });

    it("reports routine tools as unavailable when no store is configured", async () => {
      settings.update({ confirmWrites: false });
      const agent = makeAgent();
      create.mockResolvedValueOnce(apiReply([toolUse("tu_l", "list_routines", {})], "tool_use")).mockResolvedValueOnce(apiReply([text("אין")]));
      const conv = agent.newConversation("c", "p");
      await agent.respond(conv, "משימות?", { phone: "p" });
      expect((conv.messages[2] as MessageParam).content).toEqual([expect.objectContaining({ is_error: true, content: "Routines are not enabled on this server." })]);
    });
  });
});
