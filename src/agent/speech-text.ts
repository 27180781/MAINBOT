/**
 * Turns model output into something a Hebrew TTS engine reads well:
 * strips markdown, URLs and emoji, expands a few symbols, and splits the text into
 * short segments (the PBX caches each unique TTS string, and short strings are
 * cheaper and start playing sooner). Phone numbers become `digits` items so the
 * engine reads them digit by digit instead of as one huge number.
 */

export interface SpeechSegment {
  kind: "text" | "digits" | "number";
  value: string;
}

const MAX_SEGMENT_CHARS = 220;

export function normalizeForSpeech(raw: string): string {
  let t = raw ?? "";
  // Code fences / inline code
  t = t.replace(/```[\s\S]*?```/g, " ");
  t = t.replace(/`([^`]*)`/g, "$1");
  // Markdown links [text](url) -> text ; bare URLs -> "קישור"
  t = t.replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, "$1");
  t = t.replace(/https?:\/\/\S+/gi, "קישור");
  t = t.replace(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, (m) => m.replace(/@/g, " שטרודל ").replace(/\./g, " נקודה "));
  // Headings, emphasis, bullets, tables
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  t = t.replace(/(\*\*|__)(.*?)\1/g, "$2");
  t = t.replace(/(\*|_)(.*?)\1/g, "$2");
  t = t.replace(/^\s*[-*•]\s+/gm, "");
  t = t.replace(/^\s*\d+[.)]\s+/gm, "");
  t = t.replace(/\|/g, ", ");
  t = t.replace(/^[\s:,-]*$/gm, "");
  // Symbols the engine reads badly
  t = t.replace(/₪/g, " שקלים ");
  t = t.replace(/\$/g, " דולר ");
  t = t.replace(/%/g, " אחוז ");
  t = t.replace(/&/g, " ו ");
  t = t.replace(/[<>{}[\]#*_~^]/g, " ");
  // Emoji and pictographs
  t = t.replace(/[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, "");
  // Whitespace
  t = t.replace(/[ \t]+/g, " ");
  t = t.replace(/\n{2,}/g, "\n");
  return t.trim();
}

const PHONE_RE = /(?<!\d)(?:\+?972[-\s]?)?0?(?:5\d|7[2-9]|[2-4]|8|9)[-\s]?\d{3}[-\s]?\d{4}(?!\d)/g;

/** Splits normalised text into TTS-sized segments, extracting phone numbers as digit runs. */
export function splitForSpeech(raw: string): SpeechSegment[] {
  const text = normalizeForSpeech(raw);
  if (!text) return [];
  const out: SpeechSegment[] = [];
  const pushText = (s: string) => {
    // A segment that follows a digit run often starts with the sentence's punctuation.
    const trimmed = s.replace(/^[\s.,;:!?]+/, "");
    for (const chunk of chunkSentences(trimmed)) out.push({ kind: "text", value: chunk });
  };
  // Phone numbers first, then any other long digit run (IDs, order/confirmation numbers)
  // that a TTS engine would otherwise read as "one hundred twenty-three million ...".
  const spans: Array<{ start: number; end: number; digits: string }> = [];
  for (const m of text.matchAll(PHONE_RE)) {
    const idx = m.index ?? 0;
    const digits = m[0].replace(/\D/g, "").replace(/^972/, "0");
    if (digits.length < 9 || digits.length > 10) continue; // not a phone number after all
    spans.push({ start: idx, end: idx + m[0].length, digits });
  }
  for (const m of text.matchAll(LONG_DIGITS_RE)) {
    const idx = m.index ?? 0;
    const end = idx + m[0].length;
    if (spans.some((s) => idx < s.end && end > s.start)) continue;
    spans.push({ start: idx, end, digits: m[0] });
  }
  spans.sort((a, b) => a.start - b.start);
  let last = 0;
  for (const s of spans) {
    pushText(text.slice(last, s.start));
    out.push({ kind: "digits", value: s.digits });
    last = s.end;
  }
  pushText(text.slice(last));
  return out.filter((s) => s.value.trim().length > 0);
}

/** 7-12 consecutive digits that are not part of a decimal number, a date or an amount of money. */
const LONG_DIGITS_RE = /(?<![\d.,])\d{7,12}(?!\d)(?![.,]\d)(?!\s*(?:שקל|ש"ח|דולר|אירו|אחוז|%))/g;

/** Sentences shorter than this are glued to their neighbour instead of becoming their own TTS item. */
const MIN_SENTENCE_CHARS = 24;

/**
 * One TTS item per sentence: the PBX synthesises each unique string once and serves
 * exact repeats from cache, so short reusable sentences ("יש עוד משהו?") are faster
 * and cheaper than one long unique paragraph. Fragments shorter than MIN_SENTENCE_CHARS
 * are merged with a neighbour, and a single overlong sentence is still split under `max`.
 */
export function chunkSentences(text: string, max = MAX_SEGMENT_CHARS): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const sentences = clean.split(/(?<=[.!?؟:;\n])\s+/);
  const chunks: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (!s) continue;
    const merged = cur ? `${cur} ${s}` : s;
    const shortEnough = merged.length <= max;
    const eitherFragment = cur.length < MIN_SENTENCE_CHARS || s.length < MIN_SENTENCE_CHARS;
    if (cur && shortEnough && eitherFragment) {
      cur = merged;
    } else if (cur) {
      chunks.push(cur.trim());
      cur = s;
    } else {
      cur = s;
    }
    // A single overlong sentence: split on commas / spaces
    while (cur.length > max) {
      let cut = cur.lastIndexOf(",", max);
      if (cut < max / 2) cut = cur.lastIndexOf(" ", max);
      if (cut <= 0) cut = max;
      chunks.push(cur.slice(0, cut).trim());
      cur = cur.slice(cut).replace(/^[,\s]+/, "");
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}
