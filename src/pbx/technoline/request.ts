import type { PbxRequest, SttResult } from "./types.js";

function str(v: unknown): string {
  if (Array.isArray(v)) return String(v[0] ?? "");
  return v === undefined || v === null ? "" : String(v);
}

/** Parses the PBX query string (or a POST body) into a typed request. */
export function parsePbxRequest(query: Record<string, unknown>): PbxRequest {
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(query)) params[k] = str(v);
  const statusRaw = params.PBXcallStatus?.toUpperCase();
  const callType = params.PBXcallType === "in" || params.PBXcallType === "out" ? params.PBXcallType : "";
  return {
    phone: params.PBXphone ?? "",
    pbxNum: params.PBXnum ?? "",
    did: params.PBXdid ?? "",
    callId: params.PBXcallId ?? "",
    callType,
    status: statusRaw === "HANGUP" ? "HANGUP" : "CALL",
    extensionId: params.PBXextensionId ?? "",
    extensionPath: params.PBXextensionPath ?? "",
    params,
  };
}

/** Reads the `stt` / `record` result family for a given module name. */
export function readSttResult(params: Record<string, string>, name: string): SttResult | null {
  if (!(name in params)) return null;
  const num = (v: string | undefined) => {
    if (v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    text: (params[name] ?? "").trim(),
    file: params[`FILE_${name}`] ?? "",
    path: params[`PATH_${name}`] ?? "",
    sizeMb: num(params[`SIZE_${name}`]),
    durationSec: num(params[`DURATION_${name}`]),
    digit: params[`DIGIT_${name}`] ?? "",
  };
}

/** Finds the highest-numbered `<prefix>_<n>` parameter present, used to recover after a restart. */
export function latestNumberedParam(params: Record<string, string>, prefix: string): { name: string; index: number } | null {
  let best: { name: string; index: number } | null = null;
  const re = new RegExp(`^${prefix}_(\\d+)$`);
  for (const key of Object.keys(params)) {
    const m = re.exec(key);
    if (!m) continue;
    const index = Number(m[1]);
    if (!best || index > best.index) best = { name: key, index };
  }
  return best;
}
