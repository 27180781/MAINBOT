import { describe, it, expect } from "vitest";
import { normalizeForSpeech, splitForSpeech, chunkSentences } from "../src/agent/speech-text.js";

describe("normalizeForSpeech", () => {
  it("strips markdown emphasis, headings, bullets and numbered lists", () => {
    expect(normalizeForSpeech("**חשוב** מאוד")).toBe("חשוב מאוד");
    expect(normalizeForSpeech("__דגש__ ו*נטוי*")).toBe("דגש ונטוי");
    expect(normalizeForSpeech("# כותרת\nטקסט")).toBe("כותרת\nטקסט");
    expect(normalizeForSpeech("### תת כותרת")).toBe("תת כותרת");
    expect(normalizeForSpeech("- אחד\n- שתיים\n1. שלוש\n2) ארבע")).toBe("אחד\nשתיים\nשלוש\nארבע");
  });

  it("keeps the text of markdown links and replaces bare URLs with the word קישור", () => {
    expect(normalizeForSpeech("ראו [את האתר](https://example.com/x) עכשיו")).toBe("ראו את האתר עכשיו");
    expect(normalizeForSpeech("היכנסו ל https://example.com/path?x=1 בבקשה")).toBe("היכנסו ל קישור בבקשה");
    expect(normalizeForSpeech("http://a.b/c")).toBe("קישור");
  });

  it("drops code fences and keeps inline code text", () => {
    expect(normalizeForSpeech("```js\nconsole.log(1)\n```\nוגם `inline` כאן")).toBe("וגם inline כאן");
  });

  it("removes emoji and pictographs", () => {
    expect(normalizeForSpeech("שלום 😀👍 עולם ✅")).toBe("שלום עולם");
    expect(normalizeForSpeech("🎉")).toBe("");
  });

  it("expands currency, percent and ampersand symbols into words", () => {
    expect(normalizeForSpeech("המחיר 500₪")).toBe("המחיר 500 שקלים");
    expect(normalizeForSpeech("₪200 מקדמה")).toBe("שקלים 200 מקדמה");
    expect(normalizeForSpeech("עולה $20")).toContain("דולר");
    expect(normalizeForSpeech("5% הנחה")).toBe("5 אחוז הנחה");
    expect(normalizeForSpeech("a & b")).toBe("a ו b");
  });

  it("reads e-mail addresses as words", () => {
    expect(normalizeForSpeech("כתבו ל info@example.co.il")).toBe("כתבו ל info שטרודל example נקודה co נקודה il");
  });

  it("removes characters the TTS engine reads badly", () => {
    const out = normalizeForSpeech("<b>x</b> {y} [z] ~w~ ^v^");
    expect(out).not.toMatch(/[<>{}[\]~^]/);
    expect(out).toContain("x");
    expect(out).toContain("z");
  });

  it("turns table pipes into pauses and collapses whitespace", () => {
    expect(normalizeForSpeech("| a | b |")).toBe(", a , b ,");
    expect(normalizeForSpeech("  a   b\n\n\n\nc  ")).toBe("a b\nc");
    expect(normalizeForSpeech("a\t\tb")).toBe("a b");
  });

  it("handles empty and nullish input", () => {
    expect(normalizeForSpeech("")).toBe("");
    expect(normalizeForSpeech("   ")).toBe("");
    expect(normalizeForSpeech(undefined as unknown as string)).toBe("");
  });
});

describe("splitForSpeech", () => {
  const PHONE_FORMS = ["050-123-4567", "0501234567", "+972501234567", "972-50-123-4567", "050 123 4567", "+972-50-123-4567"];

  it.each(PHONE_FORMS)("turns the phone number %s into a 10-digit digits segment", (form) => {
    const segs = splitForSpeech(`המספר שלו ${form} תודה`);
    expect(segs).toEqual([
      { kind: "text", value: "המספר שלו" },
      { kind: "digits", value: "0501234567" },
      { kind: "text", value: "תודה" },
    ]);
    const digits = segs.find((s) => s.kind === "digits")!;
    expect(digits.value).toMatch(/^\d{10}$/);
  });

  it("returns only a digits segment when the text is just a phone number", () => {
    expect(splitForSpeech("0501234567")).toEqual([{ kind: "digits", value: "0501234567" }]);
  });

  it("extracts several phone numbers from one sentence", () => {
    expect(splitForSpeech("0501234567 או 0521112222")).toEqual([
      { kind: "digits", value: "0501234567" },
      { kind: "text", value: "או" },
      { kind: "digits", value: "0521112222" },
    ]);
  });

  it("handles 9-digit landline numbers", () => {
    expect(splitForSpeech("משרד 03-1234567")).toEqual([
      { kind: "text", value: "משרד" },
      { kind: "digits", value: "031234567" },
    ]);
  });

  it("does not treat years, prices or other plain numbers as phones", () => {
    expect(splitForSpeech("בשנת 2024 היו 1500 לקוחות")).toEqual([{ kind: "text", value: "בשנת 2024 היו 1500 לקוחות" }]);
    expect(splitForSpeech("המחיר 800 שקלים או 1,200 שקלים")).toEqual([{ kind: "text", value: "המחיר 800 שקלים או 1,200 שקלים" }]);
    expect(splitForSpeech("סכום של 12345678 שקלים").every((s) => s.kind === "text")).toBe(true);
    expect(splitForSpeech("מקדמה 200₪").every((s) => s.kind === "text")).toBe(true);
  });

  it("normalises markdown before splitting", () => {
    expect(splitForSpeech("**0501234567**")).toEqual([{ kind: "digits", value: "0501234567" }]);
  });

  it("returns an empty list for empty or whitespace-only input", () => {
    expect(splitForSpeech("")).toEqual([]);
    expect(splitForSpeech("   \n ")).toEqual([]);
  });

  it("chunks long text segments around the phone number", () => {
    const long = Array.from({ length: 8 }, (_, i) => `זה משפט מספר ${i + 1} שמכיל כמה מילים כדי להיות ארוך מספיק.`).join(" ");
    const segs = splitForSpeech(`${long} המספר 0501234567`);
    expect(segs.filter((s) => s.kind === "text").length).toBeGreaterThan(1);
    expect(segs.at(-1)).toEqual({ kind: "digits", value: "0501234567" });
    for (const s of segs) expect(s.value.length).toBeLessThanOrEqual(220);
  });
});

describe("chunkSentences", () => {
  it("keeps short text as one chunk", () => {
    expect(chunkSentences("שלום. מה שלומך?")).toEqual(["שלום. מה שלומך?"]);
  });

  it("returns nothing for whitespace-only text", () => {
    expect(chunkSentences("   ")).toEqual([]);
    expect(chunkSentences("")).toEqual([]);
  });

  it("splits long text at sentence boundaries with every chunk under 220 chars", () => {
    const sentences = Array.from({ length: 8 }, (_, i) => `זה משפט מספר ${i + 1} שמכיל כמה מילים כדי להיות ארוך מספיק.`);
    const text = sentences.join(" ");
    expect(text.length).toBeGreaterThan(220);
    const chunks = chunkSentences(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(220);
      expect(c.endsWith(".")).toBe(true); // cut only between sentences
    }
    expect(chunks.join(" ")).toBe(text);
  });

  it("splits a single overlong sentence at word boundaries", () => {
    const text = "מילה ".repeat(80).trim();
    expect(text.length).toBeGreaterThan(220);
    const chunks = chunkSentences(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(220);
      expect(c.length).toBeGreaterThan(0);
      expect(c.startsWith(" ")).toBe(false);
      expect(c.endsWith(" ")).toBe(false);
    }
    expect(chunks.join(" ")).toBe(text);
  });

  it("prefers commas when splitting an overlong sentence", () => {
    const text = Array.from({ length: 30 }, (_, i) => `פריט${i}`).join(", ");
    expect(text.length).toBeGreaterThan(220);
    const chunks = chunkSentences(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(220);
      expect(c.startsWith(",")).toBe(false);
      expect(c.endsWith(",")).toBe(false);
    }
    expect(chunks.join(", ")).toBe(text);
  });

  it("honours a custom maximum", () => {
    expect(chunkSentences("אחד. שתיים. שלוש. ארבע.", 12)).toEqual(["אחד. שתיים.", "שלוש. ארבע."]);
  });

  it("normalises internal whitespace and newlines", () => {
    expect(chunkSentences("שלום.\n\nמה   שלומך?")).toEqual(["שלום. מה שלומך?"]);
  });
});
