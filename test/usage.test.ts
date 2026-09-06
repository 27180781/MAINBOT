import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UsageStore } from "../src/usage/usage-store.js";
import { MODEL_PRICES, estimateCostUsd, findPrice } from "../src/usage/pricing.js";

describe("pricing", () => {
  it("findPrice matches exact ids", () => {
    expect(findPrice("claude-opus-5")?.id).toBe("claude-opus-5");
    expect(findPrice("claude-haiku-4-5")?.id).toBe("claude-haiku-4-5");
  });

  it("findPrice tolerates dated suffixes and picks the most specific id", () => {
    expect(findPrice("claude-opus-5-20260101")?.id).toBe("claude-opus-5");
    expect(findPrice("claude-opus-4-7-20260101")?.id).toBe("claude-opus-4-7");
    expect(findPrice("claude-fable-5-1-20260101")?.id).toBe("claude-fable-5-1");
    expect(findPrice("claude-fable-5-20260101")?.id).toBe("claude-fable-5");
    expect(findPrice("claude-sonnet-5-20260301")?.id).toBe("claude-sonnet-5");
  });

  it("findPrice returns undefined for unknown models", () => {
    expect(findPrice("gpt-9")).toBeUndefined();
    expect(findPrice("")).toBeUndefined();
  });

  it("estimateCostUsd applies per-token rates per million tokens", () => {
    const opus = MODEL_PRICES.find((m) => m.id === "claude-opus-5")!;
    const tokens = { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 100 };
    const expected = (1000 * opus.input + 500 * opus.output + 2000 * opus.cacheRead + 100 * opus.cacheWrite) / 1_000_000;
    expect(estimateCostUsd("claude-opus-5", tokens)).toBeCloseTo(expected, 10);
    expect(estimateCostUsd("claude-opus-5", tokens)).toBeCloseTo(0.019125, 10);
    expect(estimateCostUsd("claude-opus-5-20260101", tokens)).toBeCloseTo(expected, 10);
  });

  it("estimateCostUsd is 0 for unknown models and for zero tokens", () => {
    expect(estimateCostUsd("unknown-model", { inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe(0);
    expect(estimateCostUsd("claude-opus-5", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe(0);
  });
});

describe("UsageStore", () => {
  let dir: string;
  let store: UsageStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mainbot-usage-"));
    store = new UsageStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const llm = (callId: string, over: Partial<Parameters<UsageStore["recordLlm"]>[0]> = {}) =>
    store.recordLlm({
      callId,
      phone: "0501234567",
      requestedModel: "claude-opus-5",
      servedModel: "claude-opus-5",
      effort: "medium",
      durationMs: 800,
      stopReason: "end_turn",
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 2000,
      cacheWriteTokens: 100,
      ...over,
    });

  it("creates the usage directory and starts empty", () => {
    expect(fs.existsSync(path.join(dir, "usage"))).toBe(true);
    expect(store.all()).toEqual([]);
    expect(store.calls()).toEqual([]);
    expect(store.aggregate(null).llmRequests).toBe(0);
  });

  it("recordLlm estimates the cost from the served model", () => {
    const ev = llm("c1");
    expect(ev.kind).toBe("llm");
    expect(ev.costUsd).toBeCloseTo(0.019125, 10);
    expect(ev.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(store.all()).toHaveLength(1);
  });

  it("recordLlm falls back to the requested model when the served model is empty", () => {
    const ev = llm("c1", { servedModel: "" });
    expect(ev.costUsd).toBeCloseTo(0.019125, 10);
    const haiku = llm("c1", { servedModel: "claude-haiku-4-5" });
    expect(haiku.costUsd).toBeCloseTo((1000 * 1 + 500 * 5 + 2000 * 0.1 + 100 * 1.25) / 1_000_000, 10);
  });

  it("writes one JSONL file per month and appends one line per event", () => {
    store.record({ kind: "turn", ts: "2026-01-15T10:00:00.000Z", callId: "c1", phone: "p", turn: 1, userText: "a", assistantText: "b", durationMs: 1 });
    store.record({ kind: "turn", ts: "2026-02-15T10:00:00.000Z", callId: "c1", phone: "p", turn: 2, userText: "c", assistantText: "d", durationMs: 1 });
    store.record({ kind: "turn", ts: "2026-02-16T10:00:00.000Z", callId: "c1", phone: "p", turn: 3, userText: "e", assistantText: "f", durationMs: 1 });
    const files = fs.readdirSync(path.join(dir, "usage")).sort();
    expect(files).toEqual(["2026-01.jsonl", "2026-02.jsonl"]);
    const feb = fs.readFileSync(path.join(dir, "usage", "2026-02.jsonl"), "utf8").trim().split("\n");
    expect(feb).toHaveLength(2);
    expect(JSON.parse(feb[0]!)).toMatchObject({ kind: "turn", turn: 2 });
  });

  it("aggregates by model, day and tool", () => {
    store.record({ kind: "llm", ts: "2026-01-01T10:00:00.000Z", callId: "c1", phone: "p", requestedModel: "claude-opus-5", servedModel: "claude-opus-5", effort: "medium", durationMs: 1, costUsd: 0.02, stopReason: "end_turn", inputTokens: 100, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 1 });
    store.record({ kind: "llm", ts: "2026-01-01T11:00:00.000Z", callId: "c1", phone: "p", requestedModel: "claude-opus-5", servedModel: "claude-sonnet-5", effort: "medium", durationMs: 1, costUsd: 0.005, stopReason: "tool_use", inputTokens: 50, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 });
    store.record({ kind: "llm", ts: "2026-01-02T10:00:00.000Z", callId: "c2", phone: "p", requestedModel: "claude-opus-5", servedModel: "claude-opus-5", effort: "high", durationMs: 1, costUsd: 0.03, stopReason: "end_turn", inputTokens: 200, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 });
    store.record({ kind: "tool", ts: "2026-01-01T10:00:30.000Z", callId: "c1", phone: "p", tool: "crm__search_contacts", server: "crm", durationMs: 10, ok: true });
    store.record({ kind: "tool", ts: "2026-01-01T10:00:40.000Z", callId: "c1", phone: "p", tool: "crm__search_contacts", server: "crm", durationMs: 10, ok: false });
    store.record({ kind: "tool", ts: "2026-01-02T10:00:40.000Z", callId: "c2", phone: "p", tool: "crm__send_whatsapp", server: "crm", durationMs: 10, ok: true, blocked: true });
    store.record({ kind: "turn", ts: "2026-01-01T10:01:00.000Z", callId: "c1", phone: "p", turn: 1, userText: "u", assistantText: "a", durationMs: 1 });
    store.record({ kind: "turn", ts: "2026-01-02T10:01:00.000Z", callId: "c2", phone: "p", turn: 1, userText: "u", assistantText: "a", durationMs: 1 });
    store.record({ kind: "call", ts: "2026-01-01T10:05:00.000Z", callId: "c1", phone: "p", startedAt: "2026-01-01T10:00:00.000Z", endedAt: "2026-01-01T10:05:00.000Z", turns: 1, endedBy: "caller_hangup" });
    store.record({ kind: "call", ts: "2026-01-02T10:05:00.000Z", callId: "c2", phone: "p", startedAt: "2026-01-02T10:00:00.000Z", endedAt: "2026-01-02T10:05:00.000Z", turns: 1, endedBy: "agent_end" });

    const agg = store.aggregate(null, "Asia/Jerusalem");
    expect(agg.calls).toBe(2);
    expect(agg.turns).toBe(2);
    expect(agg.llmRequests).toBe(3);
    expect(agg.toolCalls).toBe(3);
    expect(agg.tokens).toEqual({ inputTokens: 350, outputTokens: 35, cacheReadTokens: 5, cacheWriteTokens: 1 });
    expect(agg.costUsd).toBeCloseTo(0.055, 10);

    // byModel: sorted by cost, most expensive first
    expect(agg.byModel.map((m) => m.model)).toEqual(["claude-opus-5", "claude-sonnet-5"]);
    expect(agg.byModel[0]).toMatchObject({ requests: 2, tokens: { inputTokens: 300, outputTokens: 30, cacheReadTokens: 5, cacheWriteTokens: 1 } });
    expect(agg.byModel[0]!.costUsd).toBeCloseTo(0.05, 10);
    expect(agg.byModel[1]).toMatchObject({ requests: 1, tokens: { inputTokens: 50, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } });

    // byDay: newest first, local (Asia/Jerusalem) days
    expect(agg.byDay.map((d) => d.day)).toEqual(["2026-01-02", "2026-01-01"]);
    expect(agg.byDay[0]).toMatchObject({ calls: 1, requests: 1, tokens: { inputTokens: 200 } });
    expect(agg.byDay[1]).toMatchObject({ calls: 1, requests: 2, tokens: { inputTokens: 150 } });
    expect(agg.byDay[1]!.costUsd).toBeCloseTo(0.025, 10);

    // byTool: most called first, with failure count
    expect(agg.byTool).toEqual([
      { tool: "crm__search_contacts", calls: 2, failures: 1 },
      { tool: "crm__send_whatsapp", calls: 1, failures: 0 },
    ]);
  });

  it("aggregate(since) only counts events at or after the cut-off", () => {
    store.record({ kind: "turn", ts: "2026-01-01T10:00:00.000Z", callId: "c1", phone: "p", turn: 1, userText: "u", assistantText: "a", durationMs: 1 });
    store.record({ kind: "turn", ts: "2026-03-01T10:00:00.000Z", callId: "c2", phone: "p", turn: 1, userText: "u", assistantText: "a", durationMs: 1 });
    expect(store.aggregate(null).turns).toBe(2);
    expect(store.aggregate(new Date("2026-02-01T00:00:00Z")).turns).toBe(1);
    expect(store.aggregate(new Date("2026-03-01T10:00:00.000Z")).turns).toBe(1);
    expect(store.aggregate(new Date("2026-04-01T00:00:00Z")).turns).toBe(0);
  });

  it("rolls calls up newest first with per-call totals", () => {
    store.record({ kind: "llm", ts: "2026-01-01T10:00:00.000Z", callId: "c1", phone: "111", requestedModel: "claude-opus-5", servedModel: "claude-opus-5", effort: "medium", durationMs: 1, costUsd: 0.02, stopReason: "end_turn", inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 });
    store.record({ kind: "llm", ts: "2026-01-01T10:00:05.000Z", callId: "c1", phone: "111", requestedModel: "claude-opus-5", servedModel: "claude-sonnet-5", effort: "medium", durationMs: 1, costUsd: 0.01, stopReason: "end_turn", inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 });
    store.record({ kind: "tool", ts: "2026-01-01T10:00:02.000Z", callId: "c1", phone: "111", tool: "crm__search_contacts", server: "crm", durationMs: 10, ok: true });
    store.record({ kind: "turn", ts: "2026-01-01T10:00:06.000Z", callId: "c1", phone: "111", turn: 1, userText: "u", assistantText: "a", durationMs: 1 });
    store.record({ kind: "turn", ts: "2026-01-01T10:01:06.000Z", callId: "c1", phone: "111", turn: 2, userText: "u", assistantText: "a", durationMs: 1 });
    store.record({ kind: "call", ts: "2026-01-01T10:05:00.000Z", callId: "c1", phone: "111", startedAt: "2026-01-01T09:59:00.000Z", endedAt: "2026-01-01T10:05:00.000Z", turns: 2, endedBy: "caller_hangup" });

    store.record({ kind: "call", ts: "2026-01-02T10:05:00.000Z", callId: "c2", phone: "222", startedAt: "2026-01-02T10:00:00.000Z", endedAt: "2026-01-02T10:05:00.000Z", turns: 0, endedBy: "unauthorized" });

    // c3 is still active: no call event, so startedAt comes from its first event
    store.record({ kind: "turn", ts: "2026-03-01T10:00:00.000Z", callId: "c3", phone: "333", turn: 1, userText: "u", assistantText: "a", durationMs: 1 });

    const calls = store.calls();
    expect(calls.map((c) => c.callId)).toEqual(["c3", "c2", "c1"]);
    expect(calls[2]).toEqual({
      callId: "c1",
      phone: "111",
      startedAt: "2026-01-01T09:59:00.000Z",
      endedAt: "2026-01-01T10:05:00.000Z",
      turns: 2,
      llmRequests: 2,
      toolCalls: 1,
      tokens: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: expect.closeTo(0.03, 10),
      models: ["claude-opus-5", "claude-sonnet-5"],
      endedBy: "caller_hangup",
    });
    expect(calls[1]).toMatchObject({ callId: "c2", endedBy: "unauthorized", turns: 0, llmRequests: 0 });
    expect(calls[0]).toMatchObject({ callId: "c3", startedAt: "2026-03-01T10:00:00.000Z", endedAt: null, endedBy: null, turns: 1 });

    expect(store.calls(2).map((c) => c.callId)).toEqual(["c3", "c2"]);
    expect(store.calls(50, new Date("2026-01-02T00:00:00Z")).map((c) => c.callId)).toEqual(["c3", "c2"]);
  });

  it("callEvents returns only that call's events in order", () => {
    store.record({ kind: "turn", ts: "2026-01-01T10:00:00.000Z", callId: "c1", phone: "p", turn: 1, userText: "u1", assistantText: "a1", durationMs: 1 });
    store.record({ kind: "turn", ts: "2026-01-01T10:00:00.000Z", callId: "c2", phone: "p", turn: 1, userText: "u2", assistantText: "a2", durationMs: 1 });
    store.record({ kind: "call", ts: "2026-01-01T10:05:00.000Z", callId: "c1", phone: "p", startedAt: "2026-01-01T10:00:00.000Z", endedAt: "2026-01-01T10:05:00.000Z", turns: 1, endedBy: "agent_end" });
    const events = store.callEvents("c1");
    expect(events.map((e) => e.kind)).toEqual(["turn", "call"]);
    expect(events.every((e) => e.callId === "c1")).toBe(true);
    expect(store.callEvents("nope")).toEqual([]);
  });

  it("persists events so a second store reading the same directory sees them", () => {
    llm("c1");
    store.recordTool({ callId: "c1", phone: "p", tool: "crm__search_contacts", server: "crm", durationMs: 5, ok: true });
    store.recordTurn({ callId: "c1", phone: "p", turn: 1, userText: "u", assistantText: "a", durationMs: 9 });
    store.recordCall({ callId: "c1", phone: "p", startedAt: "2026-01-01T10:00:00.000Z", endedAt: "2026-01-01T10:05:00.000Z", turns: 1, endedBy: "caller_hangup" });

    const reopened = new UsageStore(dir);
    expect(reopened.all()).toEqual(store.all());
    expect(reopened.all().map((e) => e.kind)).toEqual(["llm", "tool", "turn", "call"]);
    expect(reopened.calls()[0]).toMatchObject({ callId: "c1", llmRequests: 1, toolCalls: 1, turns: 1, endedBy: "caller_hangup" });
    expect(reopened.aggregate(null).costUsd).toBeCloseTo(0.019125, 10);
  });

  it("skips corrupt lines when loading", () => {
    llm("c1");
    const file = fs.readdirSync(path.join(dir, "usage")).find((f) => f.endsWith(".jsonl"))!;
    fs.appendFileSync(path.join(dir, "usage", file), "this is not json\n\n");
    const reopened = new UsageStore(dir);
    expect(reopened.all()).toHaveLength(1);
  });
});
