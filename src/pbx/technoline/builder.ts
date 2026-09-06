import type { AudioItem, GetDtmfModule, GoToModule, HangupModule, PbxModule, SimpleMenuModule, SimpleMessageModule, SttModule } from "./types.js";
import { splitForSpeech } from "../../agent/speech-text.js";

export interface SpeechOptions {
  voice?: string;
}

/** Converts free text (already normalised for speech) into PBX audio items. */
export function textToAudioItems(text: string, opts: SpeechOptions = {}): AudioItem[] {
  const items: AudioItem[] = [];
  for (const seg of splitForSpeech(text)) {
    if (seg.kind === "digits") items.push({ digits: seg.value });
    else if (seg.kind === "number") items.push({ number: seg.value });
    else if (seg.value.trim()) items.push(opts.voice ? { text: seg.value, voice: opts.voice } : { text: seg.value });
  }
  return items;
}

export function say(text: string, opts: SpeechOptions = {}): SimpleMessageModule {
  return { type: "simpleMessage", files: textToAudioItems(text, opts) };
}

export function sayItems(files: AudioItem[]): SimpleMessageModule {
  return { type: "simpleMessage", files };
}

export interface ListenOptions extends SpeechOptions {
  maxSeconds?: number;
  minSeconds?: number;
  prompt?: string;
  fileName?: string;
}

/** Speech-to-text turn: records the caller (<= 10 s) and returns the transcript under `name`. */
export function listen(name: string, opts: ListenOptions = {}): SttModule {
  const mod: SttModule = { type: "stt", name, max: Math.min(10, Math.max(1, opts.maxSeconds ?? 10)) };
  if (opts.minSeconds) mod.min = opts.minSeconds;
  if (opts.fileName) mod.fileName = opts.fileName;
  if (opts.prompt) mod.files = textToAudioItems(opts.prompt, opts);
  return mod;
}

export function hangup(): HangupModule {
  return { type: "hangup" };
}

export function goTo(extensionId: string): GoToModule {
  return { type: "goTo", goTo: extensionId };
}

export interface DtmfOptions extends SpeechOptions {
  max: number;
  min?: number;
  timeout?: number;
  prompt?: string;
  confirmType?: "number" | "digits" | "no";
  skipKey?: string;
  skipValue?: string;
}

export function getDigits(name: string, opts: DtmfOptions): GetDtmfModule {
  const mod: GetDtmfModule = { type: "getDTMF", name, max: opts.max, confirmType: opts.confirmType ?? "no" };
  if (opts.min !== undefined) mod.min = opts.min;
  if (opts.timeout !== undefined) mod.timeout = opts.timeout;
  if (opts.skipKey) mod.skipKey = opts.skipKey;
  if (opts.skipValue) mod.skipValue = opts.skipValue;
  if (opts.prompt) mod.files = textToAudioItems(opts.prompt, opts);
  return mod;
}

export interface MenuOptions extends SpeechOptions {
  enabledKeys: string;
  prompt?: string;
  times?: number;
  timeout?: number;
  errorReturn?: string;
  extensionChange?: string;
}

export function menu(name: string, opts: MenuOptions): SimpleMenuModule {
  const mod: SimpleMenuModule = { type: "simpleMenu", name, enabledKeys: opts.enabledKeys };
  if (opts.times !== undefined) mod.times = opts.times;
  if (opts.timeout !== undefined) mod.timeout = opts.timeout;
  if (opts.errorReturn !== undefined) mod.errorReturn = opts.errorReturn;
  if (opts.extensionChange !== undefined) mod.extensionChange = opts.extensionChange;
  if (opts.prompt) mod.files = textToAudioItems(opts.prompt, opts);
  return mod;
}

/** Chains modules; drops empty simpleMessages so the PBX never receives an empty `files` array. */
export function chain(...modules: Array<PbxModule | null | undefined>): PbxModule[] {
  return modules.filter((m): m is PbxModule => !!m && !(m.type === "simpleMessage" && m.files.length === 0));
}
