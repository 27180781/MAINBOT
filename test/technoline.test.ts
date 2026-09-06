import { describe, it, expect } from "vitest";
import { parsePbxRequest, readSttResult, latestNumberedParam } from "../src/pbx/technoline/request.js";
import { say, sayItems, listen, getDigits, menu, chain, hangup, goTo, textToAudioItems } from "../src/pbx/technoline/builder.js";

describe("parsePbxRequest", () => {
  it("maps the fixed PBX parameters", () => {
    const req = parsePbxRequest({
      PBXphone: "0501234567",
      PBXnum: "0733000000",
      PBXdid: "0733000001",
      PBXcallId: "call-1",
      PBXcallType: "in",
      PBXcallStatus: "CALL",
      PBXextensionId: "9",
      PBXextensionPath: "/1/9",
    });
    expect(req).toMatchObject({
      phone: "0501234567",
      pbxNum: "0733000000",
      did: "0733000001",
      callId: "call-1",
      callType: "in",
      status: "CALL",
      extensionId: "9",
      extensionPath: "/1/9",
    });
    expect(req.params.PBXcallId).toBe("call-1");
  });

  it("defaults missing values to empty strings and status CALL", () => {
    const req = parsePbxRequest({});
    expect(req).toEqual({ phone: "", pbxNum: "", did: "", callId: "", callType: "", status: "CALL", extensionId: "", extensionPath: "", params: {} });
  });

  it("detects HANGUP regardless of case", () => {
    expect(parsePbxRequest({ PBXcallStatus: "HANGUP" }).status).toBe("HANGUP");
    expect(parsePbxRequest({ PBXcallStatus: "hangup" }).status).toBe("HANGUP");
    expect(parsePbxRequest({ PBXcallStatus: "Hangup" }).status).toBe("HANGUP");
    expect(parsePbxRequest({ PBXcallStatus: "CALL" }).status).toBe("CALL");
    expect(parsePbxRequest({ PBXcallStatus: "whatever" }).status).toBe("CALL");
  });

  it("normalises call type", () => {
    expect(parsePbxRequest({ PBXcallType: "out" }).callType).toBe("out");
    expect(parsePbxRequest({ PBXcallType: "campaign" }).callType).toBe("");
  });

  it("takes the first element of array values and stringifies scalars", () => {
    const req = parsePbxRequest({ utt_1: ["שלום", "עולם"], n: 5, flag: true, empty: [], nil: null, undef: undefined });
    expect(req.params).toEqual({ utt_1: "שלום", n: "5", flag: "true", empty: "", nil: "", undef: "" });
  });

  it("keeps every accumulated module result in params", () => {
    const req = parsePbxRequest({ PBXcallId: "c", utt_1: "a", utt_2: "b", pin_1: "1234", FILE_utt_1: "f.opus" });
    expect(Object.keys(req.params).sort()).toEqual(["FILE_utt_1", "PBXcallId", "pin_1", "utt_1", "utt_2"]);
  });
});

describe("readSttResult", () => {
  it("reads the whole stt/record result family", () => {
    const params = {
      utt_1: "  שלום עולם ",
      FILE_utt_1: "utt.opus",
      PATH_utt_1: "/rec/utt.opus",
      SIZE_utt_1: "0.25",
      DURATION_utt_1: "4",
      DIGIT_utt_1: "#",
    };
    expect(readSttResult(params, "utt_1")).toEqual({
      text: "שלום עולם",
      file: "utt.opus",
      path: "/rec/utt.opus",
      sizeMb: 0.25,
      durationSec: 4,
      digit: "#",
    });
  });

  it("returns null when the primary parameter is missing", () => {
    expect(readSttResult({ utt_2: "x", FILE_utt_1: "f" }, "utt_1")).toBeNull();
    expect(readSttResult({}, "utt_1")).toBeNull();
  });

  it("treats an empty transcript as an empty string, not null", () => {
    expect(readSttResult({ utt_1: "" }, "utt_1")).toEqual({ text: "", file: "", path: "", sizeMb: null, durationSec: null, digit: "" });
  });

  it("turns missing or non-numeric numbers into null", () => {
    expect(readSttResult({ utt_1: "x", SIZE_utt_1: "abc", DURATION_utt_1: "" }, "utt_1")).toMatchObject({ sizeMb: null, durationSec: null });
  });
});

describe("latestNumberedParam", () => {
  it("finds the highest numbered parameter for the prefix", () => {
    expect(latestNumberedParam({ utt_1: "a", utt_10: "b", utt_3: "c", pin_1: "d", utt_x: "e", utt: "f" }, "utt")).toEqual({ name: "utt_10", index: 10 });
  });

  it("ignores other prefixes and returns null when nothing matches", () => {
    expect(latestNumberedParam({ pin_1: "d", utt_: "x", xutt_2: "y" }, "utt")).toBeNull();
    expect(latestNumberedParam({}, "utt")).toBeNull();
  });

  it("works for the pin prefix too", () => {
    expect(latestNumberedParam({ pin_1: "1", pin_2: "2", utt_9: "x" }, "pin")).toEqual({ name: "pin_2", index: 2 });
  });
});

describe("builder helpers", () => {
  it("say() wraps text in a simpleMessage with TTS items", () => {
    expect(say("שלום עולם")).toEqual({ type: "simpleMessage", files: [{ text: "שלום עולם" }] });
  });

  it("say() propagates the voice to text items only, never to digits", () => {
    expect(say("המספר 0501234567 תודה", { voice: "Kore" })).toEqual({
      type: "simpleMessage",
      files: [{ text: "המספר", voice: "Kore" }, { digits: "0501234567" }, { text: "תודה", voice: "Kore" }],
    });
  });

  it("say() yields an empty files array for empty text (so chain can drop it)", () => {
    expect(say("")).toEqual({ type: "simpleMessage", files: [] });
    expect(say("😀")).toEqual({ type: "simpleMessage", files: [] });
  });

  it("textToAudioItems splits long text into several items", () => {
    const long = Array.from({ length: 8 }, (_, i) => `משפט ${i + 1} שמכיל כמה מילים כדי להיות ארוך מספיק לבדיקה.`).join(" ");
    const items = textToAudioItems(long);
    expect(items.length).toBeGreaterThan(1);
    for (const it of items) expect("text" in it && it.text.length <= 220).toBe(true);
  });

  it("sayItems passes audio items through untouched", () => {
    const files = [{ fileLink: "https://x/y.wav", fileName: "y" }];
    expect(sayItems(files)).toEqual({ type: "simpleMessage", files });
  });

  it("listen() clamps max to the PBX limit of 10 seconds and at least 1", () => {
    expect(listen("utt_1", { maxSeconds: 30 })).toEqual({ type: "stt", name: "utt_1", max: 10, confirm: "no" });
    expect(listen("utt_1", { maxSeconds: 0 })).toEqual({ type: "stt", name: "utt_1", max: 1, confirm: "no" });
    expect(listen("utt_1", { maxSeconds: 7 })).toEqual({ type: "stt", name: "utt_1", max: 7, confirm: "no" });
    expect(listen("utt_1")).toEqual({ type: "stt", name: "utt_1", max: 10, confirm: "no" });
  });

  it("listen() adds optional prompt, min and fileName", () => {
    const mod = listen("utt_2", { prompt: "דברו", minSeconds: 1, fileName: "rec_{{PBXcallId}}", voice: "Puck" });
    expect(mod).toEqual({ type: "stt", name: "utt_2", max: 10, confirm: "no", min: 1, fileName: "rec_{{PBXcallId}}", files: [{ text: "דברו", voice: "Puck" }] });
  });

  it("getDigits() builds a getDTMF module with confirmType 'no' by default", () => {
    expect(getDigits("pin_1", { max: 8, min: 1, timeout: 10, skipKey: "#", prompt: "הקישו קוד", voice: "Kore" })).toEqual({
      type: "getDTMF",
      name: "pin_1",
      max: 8,
      confirmType: "no",
      min: 1,
      timeout: 10,
      skipKey: "#",
      files: [{ text: "הקישו קוד", voice: "Kore" }],
    });
    expect(getDigits("amount", { max: 4, confirmType: "number", skipValue: "SKIP" })).toEqual({ type: "getDTMF", name: "amount", max: 4, confirmType: "number", skipValue: "SKIP" });
  });

  it("menu() builds a simpleMenu module", () => {
    expect(menu("m", { enabledKeys: "1,2", prompt: "בחרו", times: 3, timeout: 5, errorReturn: "ERR", extensionChange: ".." })).toEqual({
      type: "simpleMenu",
      name: "m",
      enabledKeys: "1,2",
      times: 3,
      timeout: 5,
      errorReturn: "ERR",
      extensionChange: "..",
      files: [{ text: "בחרו" }],
    });
    expect(menu("m", { enabledKeys: "1" })).toEqual({ type: "simpleMenu", name: "m", enabledKeys: "1" });
  });

  it("hangup() and goTo() build their modules", () => {
    expect(hangup()).toEqual({ type: "hangup" });
    expect(goTo("1234")).toEqual({ type: "goTo", goTo: "1234" });
  });

  it("chain() drops null/undefined entries and empty simpleMessages but keeps everything else", () => {
    const out = chain(say(""), null, undefined, hangup(), say("היי"), listen("utt_1"));
    expect(out).toEqual([{ type: "hangup" }, { type: "simpleMessage", files: [{ text: "היי" }] }, { type: "stt", name: "utt_1", max: 10, confirm: "no" }]);
    expect(chain()).toEqual([]);
    expect(chain(say(""))).toEqual([]);
  });
});
