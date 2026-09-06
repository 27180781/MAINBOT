import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizePhone, isPhoneAllowed, SettingsStore, SettingsSchema, sha256, EFFORT_LEVELS, type Settings } from "../src/config.js";

describe("normalizePhone", () => {
  it("strips formatting and the +972 country code", () => {
    expect(normalizePhone("0501234567")).toBe("0501234567");
    expect(normalizePhone("050-123-4567")).toBe("0501234567");
    expect(normalizePhone("050 123 4567")).toBe("0501234567");
    expect(normalizePhone("+972501234567")).toBe("0501234567");
    expect(normalizePhone("+972-50-123-4567")).toBe("0501234567");
    expect(normalizePhone("972501234567")).toBe("0501234567");
    expect(normalizePhone("(050) 123-4567")).toBe("0501234567");
  });

  it("adds the leading zero to a 9-digit national number", () => {
    expect(normalizePhone("501234567")).toBe("0501234567");
    expect(normalizePhone("31234567")).toBe("31234567"); // too short to guess
  });

  it("handles empty and nullish input", () => {
    expect(normalizePhone("")).toBe("");
    expect(normalizePhone("abc")).toBe("");
    expect(normalizePhone(null as unknown as string)).toBe("");
    expect(normalizePhone(undefined as unknown as string)).toBe("");
  });
});

describe("isPhoneAllowed", () => {
  it("denies everyone when the list is empty", () => {
    expect(isPhoneAllowed("0501234567", [])).toBe(false);
  });

  it("allows everyone with the * wildcard", () => {
    expect(isPhoneAllowed("0501234567", ["*"])).toBe(true);
    expect(isPhoneAllowed("", ["*"])).toBe(true);
    expect(isPhoneAllowed("0501234567", ["0529999999", "*"])).toBe(true);
  });

  it("compares normalised forms of both sides", () => {
    expect(isPhoneAllowed("+972501234567", ["050-123-4567"])).toBe(true);
    expect(isPhoneAllowed("0501234567", ["+972-50-123-4567"])).toBe(true);
    expect(isPhoneAllowed("972501234567", ["501234567"])).toBe(true);
    expect(isPhoneAllowed("0501234567", ["0529999999", "0531111111"])).toBe(false);
    expect(isPhoneAllowed("", ["0501234567"])).toBe(false);
  });
});

describe("SettingsStore", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mainbot-settings-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const file = () => path.join(dir, "settings.json");

  it("starts from the schema defaults when no file exists", () => {
    const store = new SettingsStore(dir);
    const s = store.get();
    expect(s).toEqual(SettingsSchema.parse({}));
    expect(EFFORT_LEVELS).toContain(s.effort);
    expect(s.fallbacks).toBe("default");
    expect(s.toolSearch).toBe(true);
    expect(s.toolSearchVariant).toBe("regex");
    expect(s.maxSilentTurns).toBe(2);
    expect(s.sttMaxSeconds).toBeLessThanOrEqual(10);
    expect(s.confirmWrites).toBe(true);
    expect(s.blockedTools).toContain("__delete_");
    expect(s.greeting.length).toBeGreaterThan(0);
    expect(fs.existsSync(file())).toBe(false); // nothing written until an update
  });

  it("update() merges, validates and persists to settings.json", () => {
    const store = new SettingsStore(dir);
    const out = store.update({ greeting: "היי", maxSilentTurns: 3, allowedPhones: ["0501234567"] });
    expect(out.greeting).toBe("היי");
    expect(store.get().maxSilentTurns).toBe(3);
    expect(store.get().model).toBe(SettingsSchema.parse({}).model); // untouched keys keep their value

    const onDisk = JSON.parse(fs.readFileSync(file(), "utf8")) as Settings;
    expect(onDisk.greeting).toBe("היי");
    expect(onDisk.allowedPhones).toEqual(["0501234567"]);

    const reopened = new SettingsStore(dir);
    expect(reopened.get()).toEqual(store.get());
  });

  it("trims and filters the allowed phone list", () => {
    const store = new SettingsStore(dir);
    store.update({ allowedPhones: [" 0501234567 ", "", "   ", "*"] });
    expect(store.get().allowedPhones).toEqual(["0501234567", "*"]);
  });

  it("stores the PIN as a sha256 hash and never exposes it through view()", () => {
    const store = new SettingsStore(dir);
    store.update({ pin: "1234" });
    expect(store.get().pinHash).toBe(sha256("1234"));
    expect(store.get().pinHash).toMatch(/^[0-9a-f]{64}$/);
    const view = store.view();
    expect(view.hasPin).toBe(true);
    expect("pinHash" in view).toBe(false);
    expect("pin" in view).toBe(false);
    expect(JSON.stringify(view)).not.toContain("1234");
    expect(JSON.stringify(view)).not.toContain(sha256("1234"));
  });

  it("clears the PIN with an empty string or null", () => {
    const store = new SettingsStore(dir);
    store.update({ pin: "1234" });
    store.update({ pin: "" });
    expect(store.get().pinHash).toBe("");
    expect(store.view().hasPin).toBe(false);

    store.update({ pin: "9999" });
    store.update({ pin: null });
    expect(store.get().pinHash).toBe("");
  });

  it("does not touch the PIN when the patch omits it", () => {
    const store = new SettingsStore(dir);
    store.update({ pin: "1234" });
    store.update({ greeting: "x" });
    expect(store.get().pinHash).toBe(sha256("1234"));
  });

  it("view() mirrors every other setting", () => {
    const store = new SettingsStore(dir);
    const { pinHash: _hash, ...rest } = store.get();
    expect(store.view()).toEqual({ ...rest, hasPin: false });
  });

  it("rejects invalid values and keeps the previous settings", () => {
    const store = new SettingsStore(dir);
    store.update({ greeting: "לפני" });
    const before = structuredClone(store.get());
    const diskBefore = fs.readFileSync(file(), "utf8");

    expect(() => store.update({ effort: "ultra" as unknown as Settings["effort"] })).toThrow();
    expect(() => store.update({ maxTokens: 10 })).toThrow();
    expect(() => store.update({ maxTokens: 1.5 })).toThrow();
    expect(() => store.update({ sttMaxSeconds: 11 })).toThrow();
    expect(() => store.update({ fallbacks: "sometimes" as unknown as Settings["fallbacks"] })).toThrow();
    expect(() => store.update({ fillerMode: "music" as unknown as Settings["fillerMode"] })).toThrow();
    expect(() => store.update({ model: "" })).toThrow();
    expect(() => store.update({ maxPinAttempts: 0 })).toThrow();
    expect(() => store.update({ allowedPhones: "0501234567" as unknown as string[] })).toThrow();

    expect(store.get()).toEqual(before);
    expect(fs.readFileSync(file(), "utf8")).toBe(diskBefore);
  });

  it("accepts every valid effort level and both fallback modes", () => {
    const store = new SettingsStore(dir);
    for (const effort of EFFORT_LEVELS) expect(store.update({ effort }).effort).toBe(effort);
    expect(store.update({ fallbacks: "off" }).fallbacks).toBe("off");
    expect(store.update({ fallbacks: "default" }).fallbacks).toBe("default");
    expect(store.update({ toolSearchVariant: "bm25" }).toolSearchVariant).toBe("bm25");
  });

  it("notifies listeners after every successful update", () => {
    const store = new SettingsStore(dir);
    const seen: string[] = [];
    store.onChange((s) => seen.push(s.greeting));
    store.update({ greeting: "a" });
    store.update({ greeting: "b" });
    expect(() => store.update({ maxTokens: 1 })).toThrow();
    expect(seen).toEqual(["a", "b"]);
  });

  it("falls back to defaults when the stored file is corrupt or invalid", () => {
    fs.writeFileSync(file(), "{ not json", "utf8");
    expect(new SettingsStore(dir).get()).toEqual(SettingsSchema.parse({}));

    fs.writeFileSync(file(), JSON.stringify({ effort: "ultra", greeting: "x" }), "utf8");
    expect(new SettingsStore(dir).get()).toEqual(SettingsSchema.parse({}));
  });

  it("fills missing keys of a partial stored file with defaults", () => {
    fs.writeFileSync(file(), JSON.stringify({ greeting: "מהקובץ" }), "utf8");
    const s = new SettingsStore(dir).get();
    expect(s.greeting).toBe("מהקובץ");
    expect(s.maxTurns).toBe(SettingsSchema.parse({}).maxTurns);
  });
});

describe("sha256", () => {
  it("is the hex digest of the utf-8 input", () => {
    expect(sha256("1234")).toBe("03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4");
    expect(sha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});
