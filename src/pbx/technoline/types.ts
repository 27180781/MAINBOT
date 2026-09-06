/**
 * Typed subset of the Technoline PBX API module (docs/technoline-api-module.md).
 * The PBX is the HTTP client: it GETs our URL and expects a JSON module (or an array
 * of modules) in the response body, with Content-Type application/json; charset=utf-8.
 */

export interface TtsItem {
  text: string;
  /** Google default voice when omitted; Gemini voices (Charon, Kore, ...) are a paid add-on. */
  voice?: string;
  activatedKeys?: string;
}
export interface FileIdItem {
  fileId: string;
  extensionId?: string;
  extensionPath?: string;
  activatedKeys?: string;
}
export interface FileNameItem {
  fileName: string;
  extensionId?: string;
  extensionPath?: string;
  activatedKeys?: string;
}
export interface NumberItem {
  number: string;
}
export interface DigitsItem {
  digits: string;
}
export interface FileLinkItem {
  fileLink: string;
  fileName: string;
}
export type AudioItem = TtsItem | FileIdItem | FileNameItem | NumberItem | DigitsItem | FileLinkItem;

export interface SimpleMessageModule {
  type: "simpleMessage";
  files: AudioItem[];
}

export interface SimpleMenuModule {
  type: "simpleMenu";
  name: string;
  enabledKeys: string;
  times?: number;
  timeout?: number;
  errorReturn?: string;
  extensionChange?: string;
  setMusic?: "yes" | "no";
  files?: AudioItem[];
}

export interface GetDtmfModule {
  type: "getDTMF";
  name: string;
  max: number;
  min?: number;
  timeout?: number;
  skipKey?: string;
  skipValue?: string;
  confirmType?: "number" | "digits" | "no";
  setMusic?: "yes" | "no";
  files?: AudioItem[];
}

export interface RecordModule {
  type: "record";
  name: string;
  max?: number;
  min?: number;
  confirm?: "confirmOnly" | "ful" | "no";
  fileName?: string;
  saveFolder?: string;
  files?: AudioItem[];
}

export interface SttModule {
  type: "stt";
  name: string;
  /** Up to 10 seconds per the PBX limit. */
  max?: number;
  min?: number;
  fileName?: string;
  saveFolder?: string;
  campaignBilling?: string;
  /**
   * Inherited from `record` ("stt does everything record does"): "no" skips the
   * confirm / re-record menu after the recording so the conversation flows.
   */
  confirm?: "confirmOnly" | "ful" | "no";
  files?: AudioItem[];
}

export interface SimpleRoutingModule {
  type: "simpleRouting";
  name: string;
  dialPhone: string;
  displayNumber?: string;
  addDigits?: string;
  routingMusic?: "yes" | "no";
  ringSec?: number;
  limit?: number | "";
  campaignBilling?: string;
}

export interface GoToModule {
  type: "goTo";
  goTo: string;
}

export interface HangupModule {
  type: "hangup";
}

export type PbxModule =
  | SimpleMessageModule
  | SimpleMenuModule
  | GetDtmfModule
  | RecordModule
  | SttModule
  | SimpleRoutingModule
  | GoToModule
  | HangupModule;

/** A single module or a chain (array) - see "Chaining vs. splitting" in the docs. */
export type PbxResponse = PbxModule | PbxModule[];

export interface PbxRequest {
  phone: string;
  pbxNum: string;
  did: string;
  callId: string;
  callType: "in" | "out" | "";
  status: "CALL" | "HANGUP";
  extensionId: string;
  extensionPath: string;
  /** Every query parameter, including the accumulated module results. */
  params: Record<string, string>;
}

export interface SttResult {
  text: string;
  file: string;
  path: string;
  sizeMb: number | null;
  durationSec: number | null;
  digit: string;
}
