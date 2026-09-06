import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type Built = Awaited<ReturnType<(typeof import("../src/server.js"))["buildServer"]>>;

const SECRET = "test-webhook-secret";
const AUTH = "Basic " + Buffer.from("admin:pw").toString("base64");
const PHONE = "0501234567";

let dir: string;
let server: Built;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mainbot-server-"));
  fs.writeFileSync(path.join(dir, "mcp-servers.json"), JSON.stringify({ servers: [] }), "utf8");
  // src/config.ts reads the environment at import time, so everything must be stubbed before the dynamic import.
  vi.stubEnv("WEBHOOK_SECRET", SECRET);
  vi.stubEnv("ADMIN_USER", "admin");
  vi.stubEnv("ADMIN_PASSWORD", "pw");
  vi.stubEnv("DATA_DIR", dir);
  vi.stubEnv("MCP_CONFIG_PATH", path.join(dir, "mcp-servers.json"));
  vi.stubEnv("MCP_AUTH_DIR", path.join(dir, "auth"));
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test-not-real");
  vi.stubEnv("ALLOWED_CALLER_PHONES", `${PHONE}, 0529999999`);
  vi.stubEnv("PUBLIC_BASE_URL", "https://bot.example.com/");
  vi.stubEnv("PBX_LONG_POLL_MS", "100");
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("LOG_LEVEL", "silent");
  const mod = await import("../src/server.js");
  server = await mod.buildServer();
  await server.app.ready();
});

afterAll(async () => {
  await server?.app.close();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("buildServer", () => {
  it("serves /health", async () => {
    const res = await server.app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, servers: [], activeCalls: 0, model: server.settings.get().model });
  });

  it("redirects / to the admin UI", async () => {
    const res = await server.app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBeGreaterThanOrEqual(300);
    expect(res.statusCode).toBeLessThan(400);
    expect(res.headers.location).toBe("/admin");
  });

  it("protects the admin API with basic auth", async () => {
    const anon = await server.app.inject({ method: "GET", url: "/admin/api/state" });
    expect(anon.statusCode).toBe(401);
    expect(anon.headers["www-authenticate"]).toMatch(/^Basic/);

    const wrong = await server.app.inject({ method: "GET", url: "/admin/api/state", headers: { authorization: "Basic " + Buffer.from("admin:nope").toString("base64") } });
    expect(wrong.statusCode).toBe(401);

    const ok = await server.app.inject({ method: "GET", url: "/admin/api/state", headers: { authorization: AUTH } });
    expect(ok.statusCode).toBe(200);
    const body = ok.json();
    expect(body.settings.hasPin).toBe(false);
    expect(body.settings).not.toHaveProperty("pinHash");
    expect(body.settings.allowedPhones).toEqual([PHONE, "0529999999"]);
    expect(body.webhookUrl).toBe(`https://bot.example.com/pbx/technoline/${SECRET}`);
    expect(body.publicBaseUrl).toBe("https://bot.example.com");
    expect(body.servers).toEqual([]);
    expect(body.toolCount).toBe(0);
    expect(Array.isArray(body.models)).toBe(true);
    expect(body.effortLevels).toContain("medium");
    expect(body.systemPromptChars).toBeGreaterThan(100);
  });

  it("updates settings through the admin API and rejects bad values", async () => {
    const ok = await server.app.inject({ method: "PUT", url: "/admin/api/settings", headers: { authorization: AUTH }, payload: { greeting: "היי מהבדיקה", pin: "4321" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().settings.greeting).toBe("היי מהבדיקה");
    expect(ok.json().settings.hasPin).toBe(true);
    expect(ok.json().settings).not.toHaveProperty("pinHash");

    const bad = await server.app.inject({ method: "PUT", url: "/admin/api/settings", headers: { authorization: AUTH }, payload: { effort: "ultra" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().ok).toBe(false);

    // restore for the PBX tests below
    server.settings.update({ pin: "", greeting: "שלום, כאן העוזר החכם." });
  });

  it("serves usage and the system prompt to the admin", async () => {
    const usage = await server.app.inject({ method: "GET", url: "/admin/api/usage?range=7d", headers: { authorization: AUTH } });
    expect(usage.statusCode).toBe(200);
    expect(usage.json()).toMatchObject({ range: "7d", aggregate: expect.objectContaining({ calls: expect.any(Number) }), calls: expect.any(Array) });

    const prompt = await server.app.inject({ method: "GET", url: "/admin/api/prompt", headers: { authorization: AUTH } });
    expect(prompt.statusCode).toBe(200);
    expect(prompt.headers["content-type"]).toMatch(/text\/plain/);
    expect(prompt.body).toContain("העוזר החכם");
  });

  it("rejects PBX requests with the wrong secret", async () => {
    const res = await server.app.inject({ method: "GET", url: `/pbx/technoline/wrong?PBXcallId=c1&PBXphone=${PHONE}&PBXcallStatus=CALL` });
    expect(res.statusCode).toBe(403);
    expect(server.sessions.size()).toBe(0);
  });

  it("rejects PBX requests without a call id", async () => {
    const res = await server.app.inject({ method: "GET", url: `/pbx/technoline/${SECRET}?PBXphone=${PHONE}` });
    expect(res.statusCode).toBe(400);
  });

  it("serves the silence WAV used as a quiet filler", async () => {
    const res = await server.app.inject({ method: "GET", url: "/audio/silence.wav" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/audio\/wav/);
    expect(res.headers["cache-control"]).toContain("max-age");
    const buf = res.rawPayload;
    expect(buf.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(buf.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(buf.subarray(12, 16).toString("ascii")).toBe("fmt ");
    expect(buf.subarray(36, 40).toString("ascii")).toBe("data");
    expect(buf.readUInt16LE(22)).toBe(1); // mono
    expect(buf.readUInt32LE(24)).toBe(8000); // sample rate
    expect(buf.readUInt16LE(34)).toBe(16); // bits per sample
    expect(buf.readUInt32LE(40)).toBe(3 * 8000 * 2); // 3 seconds of 16-bit samples
    expect(buf.length).toBe(44 + 3 * 8000 * 2);
    expect(buf.readUInt32LE(4)).toBe(buf.length - 8);
  });

  it("answers the first PBX request with the greeting and an stt module", async () => {
    const res = await server.app.inject({ method: "GET", url: `/pbx/technoline/${SECRET}?PBXcallId=call-1&PBXphone=${PHONE}&PBXcallStatus=CALL&PBXcallType=in` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json; charset=utf-8/i);
    const body = res.json();
    expect(body).toEqual([
      { type: "simpleMessage", files: [{ text: server.settings.get().greeting }] },
      { type: "stt", name: "utt_1", max: server.settings.get().sttMaxSeconds },
    ]);
    expect(server.sessions.get("call-1")).toMatchObject({ authorized: true, expectedParam: "utt_1", phone: PHONE });
    expect((await server.app.inject({ method: "GET", url: "/health" })).json().activeCalls).toBe(1);

    const hang = await server.app.inject({ method: "GET", url: `/pbx/technoline/${SECRET}?PBXcallId=call-1&PBXphone=${PHONE}&PBXcallStatus=HANGUP` });
    expect(hang.statusCode).toBe(200);
    expect(hang.json()).toEqual({});
    expect(server.sessions.get("call-1")?.endedBy).toBe("caller_hangup");
    expect(server.usage.callEvents("call-1").find((e) => e.kind === "call")).toMatchObject({ endedBy: "caller_hangup" });
  });

  it("also accepts the PBX request as a POST body", async () => {
    const res = await server.app.inject({ method: "POST", url: `/pbx/technoline/${SECRET}`, payload: { PBXcallId: "call-post", PBXphone: PHONE, PBXcallStatus: "CALL" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()[1]).toMatchObject({ type: "stt", name: "utt_1" });
    await server.app.inject({ method: "GET", url: `/pbx/technoline/${SECRET}?PBXcallId=call-post&PBXphone=${PHONE}&PBXcallStatus=HANGUP` });
  });

  it("turns away callers that are not on the allow-list", async () => {
    const res = await server.app.inject({ method: "GET", url: `/pbx/technoline/${SECRET}?PBXcallId=call-x&PBXphone=0500000000&PBXcallStatus=CALL` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body[0]).toMatchObject({ type: "simpleMessage" });
    expect(body[1]).toEqual({ type: "hangup" });
    expect(server.usage.callEvents("call-x").find((e) => e.kind === "call")).toMatchObject({ endedBy: "unauthorized" });
  });

  it("returns 503 from the admin API when admin credentials are missing", async () => {
    // Built separately with empty credentials: the admin UI must be disabled, not open.
    vi.stubEnv("ADMIN_USER", "");
    vi.stubEnv("ADMIN_PASSWORD", "");
    vi.resetModules();
    const mod = await import("../src/server.js");
    const other = await mod.buildServer();
    try {
      const res = await other.app.inject({ method: "GET", url: "/admin/api/state", headers: { authorization: AUTH } });
      expect(res.statusCode).toBe(503);
    } finally {
      await other.app.close();
      vi.stubEnv("ADMIN_USER", "admin");
      vi.stubEnv("ADMIN_PASSWORD", "pw");
    }
  });
});
