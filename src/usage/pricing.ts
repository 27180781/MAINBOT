/**
 * USD per 1M tokens. Cached-read and cache-write rates follow Anthropic's published
 * multipliers (write = 1.25x input, read = 0.1x input) except where a model publishes
 * its own read rate. Update this table when prices change - it only affects the
 * cost *estimate* shown in the admin UI, never billing itself.
 */
export interface ModelPrice {
  id: string;
  label: string;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  context: string;
}

export const MODEL_PRICES: ModelPrice[] = [
  { id: "claude-opus-5", label: "Claude Opus 5 (מומלץ)", input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5, context: "1M" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5 (מהיר וזול)", input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2, context: "1M" },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1 (החזק ביותר)", input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25, context: "1M" },
  { id: "claude-fable-5", label: "Claude Fable 5", input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1, context: "1M" },
  { id: "claude-opus-4-8", label: "Claude Opus 4.8", input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5, context: "1M" },
  { id: "claude-opus-4-7", label: "Claude Opus 4.7", input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5, context: "1M" },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6", input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5, context: "1M" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3, context: "1M" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 (הזול ביותר)", input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1, context: "200K" },
];

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function findPrice(model: string): ModelPrice | undefined {
  const exact = MODEL_PRICES.find((m) => m.id === model);
  if (exact) return exact;
  // Tolerate dated/suffixed ids such as claude-opus-4-5-20251101
  return MODEL_PRICES.find((m) => model.startsWith(m.id));
}

export function estimateCostUsd(model: string, t: TokenCounts): number {
  const p = findPrice(model);
  if (!p) return 0;
  return (
    (t.inputTokens * p.input + t.outputTokens * p.output + t.cacheReadTokens * p.cacheRead + t.cacheWriteTokens * p.cacheWrite) /
    1_000_000
  );
}
