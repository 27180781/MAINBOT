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
    for (const chunk of chunkSentences(s)) out.push({ kind: "text", value: chunk });
  };
  let last = 0;
  for (const m of text.matchAll(PHONE_RE)) {
    const idx = m.index ?? 0;
    const digits = m[0].replace(/\D/g, "").replace(/^972/, "0");
    if (digits.length < 9 || digits.length > 10) continue; // not a phone number after all
    pushText(text.slice(last, idx));
    out.push({ kind: "digits", value: digits });
    last = idx + m[0].length;
  }
  pushText(text.slice(last));
  return out.filter((s) => s.value.trim().length > 0);
}

/** Sentence-aware chunking so each TTS item stays short. */
export function chunkSentences(text: string, max = MAX_SEGMENT_CHARS): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const sentences = clean.split(/(?<=[.!?؟:;\n])\s+/);
  const chunks: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (!s) continue;
    if ((cur + " " + s).trim().length > max && cur) {
      chunks.push(cur.trim());
      cur = s;
    } else {
      cur = cur ? `${cur} ${s}` : s;
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
