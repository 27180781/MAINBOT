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
  fs.writeFileSync(path.join(dir, "instructions.md"), "הנחיות לבדיקה: המקדמה 200 שקלים.", "utf8");
  // src/config.ts reads the environment at import time, so everything must be stubbed before the dynamic import.
  vi.stubEnv("WEBHOOK_SECRET", SECRET);
  vi.stubEnv("ADMIN_USER", "admin");
  vi.stubEnv("ADMIN_PASSWORD", "pw");
  vi.stubEnv("DATA_DIR", dir);
  vi.stubEnv("MCP_CONFIG_PATH", path.join(dir, "mcp-servers.json"));
  vi.stubEnv("MCP_AUTH_DIR", path.join(dir, "auth"));
  vi.stubEnv("INSTRUCTIONS_PATH", path.join(dir, "instructions.md"));
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

  it("reads and writes the business instructions file through the admin API", async () => {
    const before = await server.app.inject({ method: "GET", url: "/admin/api/instructions", headers: { authorization: AUTH } });
    expect(before.statusCode).toBe(200);
    expect(before.headers["content-type"]).toMatch(/text\/plain/);
    expect(before.body).toBe("הנחיות לבדיקה: המקדמה 200 שקלים.");
    expect(server.agent.getSystemPrompt()).toContain("המקדמה 200 שקלים");

    const put = await server.app.inject({ method: "PUT", url: "/admin/api/instructions", headers: { authorization: AUTH }, payload: { text: "הנחיות חדשות לגמרי." } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ ok: true });
    expect(fs.readFileSync(path.join(dir, "instructions.md"), "utf8")).toBe("הנחיות חדשות לגמרי.");
    expect(server.agent.getSystemPrompt()).toContain("הנחיות חדשות לגמרי."); // the prompt is rebuilt immediately
    expect(server.agent.getSystemPrompt()).not.toContain("המקדמה 200 שקלים");
    expect((await server.app.inject({ method: "GET", url: "/admin/api/instructions", headers: { authorization: AUTH } })).body).toBe("הנחיות חדשות לגמרי.");

    const bad = await server.app.inject({ method: "PUT", url: "/admin/api/instructions", headers: { authorization: AUTH }, payload: { text: 5 } });
    expect(bad.statusCode).toBe(400);
    expect(fs.readFileSync(path.join(dir, "instructions.md"), "utf8")).toBe("הנחיות חדשות לגמרי.");
    // The repository's own instructions file is never touched by the test server.
    expect(fs.readFileSync(path.join(process.cwd(), "config", "instructions.md"), "utf8")).not.toContain("הנחיות חדשות לגמרי.");
  });

  it("manages standing rules through the admin API", async () => {
    const empty = await server.app.inject({ method: "GET", url: "/admin/api/rules", headers: { authorization: AUTH } });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ rules: [] });

    const added = await server.app.inject({ method: "POST", url: "/admin/api/rules", headers: { authorization: AUTH }, payload: { text: "  תמיד   לציין טלפון  " } });
    expect(added.statusCode).toBe(200);
    expect(added.json().rule).toMatchObject({ id: 1, text: "תמיד לציין טלפון", source: "admin" });
    expect(added.json().rules).toHaveLength(1);
    expect(server.agent.getSystemPrompt()).toContain("1. תמיד לציין טלפון");

    const blank = await server.app.inject({ method: "POST", url: "/admin/api/rules", headers: { authorization: AUTH }, payload: { text: "   " } });
    expect(blank.statusCode).toBe(400);
    expect(blank.json().ok).toBe(false);

    const updated = await server.app.inject({ method: "PUT", url: "/admin/api/rules/1", headers: { authorization: AUTH }, payload: { text: "תמיד לציין טלפון ומייל" } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().rule).toMatchObject({ id: 1, text: "תמיד לציין טלפון ומייל" });

    const missing = await server.app.inject({ method: "PUT", url: "/admin/api/rules/99", headers: { authorization: AUTH }, payload: { text: "x" } });
    expect(missing.statusCode).toBe(400);

    const replaced = await server.app.inject({ method: "PUT", url: "/admin/api/rules", headers: { authorization: AUTH }, payload: { texts: ["תמיד לציין טלפון ומייל", "אף פעם לא לשלוח בשבת", "", "אף פעם לא לשלוח בשבת"] } });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json().rules.map((r: { id: number; text: string }) => [r.id, r.text])).toEqual([
      [1, "תמיד לציין טלפון ומייל"],
      [2, "אף פעם לא לשלוח בשבת"],
    ]);

    const badReplace = await server.app.inject({ method: "PUT", url: "/admin/api/rules", headers: { authorization: AUTH }, payload: { texts: "no" } });
    expect(badReplace.statusCode).toBe(400);

    const removed = await server.app.inject({ method: "DELETE", url: "/admin/api/rules/1", headers: { authorization: AUTH } });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({ ok: true, rule: { id: 1 }, rules: [{ id: 2 }] });
    expect((await server.app.inject({ method: "DELETE", url: "/admin/api/rules/1", headers: { authorization: AUTH } })).statusCode).toBe(400);

    expect(server.rules.list().map((r) => r.id)).toEqual([2]);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "rules.json"), "utf8")).rules).toHaveLength(1);
    expect(server.agent.getSystemPrompt()).toContain("2. אף פעם לא לשלוח בשבת");
    expect(server.agent.getSystemPrompt()).not.toContain("1. תמיד לציין טלפון");

    expect((await server.app.inject({ method: "GET", url: "/admin/api/rules" })).statusCode).toBe(401);
  });

  it("manages proactive routines through the admin API", async () => {
    const empty = await server.app.inject({ method: "GET", url: "/admin/api/routines", headers: { authorization: AUTH } });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ enabled: true, routines: [], notifications: [] });

    const created = await server.app.inject({ method: "POST", url: "/admin/api/routines", headers: { authorization: AUTH }, payload: { name: "תדריך בוקר", schedule: { kind: "cron", expression: "0 8 * * 0-4" }, prompt: "סכם את היום", channel: "log" } });
    expect(created.statusCode).toBe(200);
    const routine = created.json().routine;
    expect(routine).toMatchObject({ name: "תדריך בוקר", enabled: true, channel: "log", source: "admin", schedule: { kind: "cron", expression: "0 8 * * 0-4" } });
    expect(created.json().routines[0].nextRunAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(created.json().routines[0].running).toBe(false);

    const bad = await server.app.inject({ method: "POST", url: "/admin/api/routines", headers: { authorization: AUTH }, payload: { name: "x", schedule: { kind: "cron", expression: "nope" }, prompt: "בדוק" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().ok).toBe(false);

    const paused = await server.app.inject({ method: "PUT", url: `/admin/api/routines/${routine.id}`, headers: { authorization: AUTH }, payload: { enabled: false } });
    expect(paused.statusCode).toBe(200);
    expect(paused.json().routine.enabled).toBe(false);
    expect(paused.json().routines[0].nextRunAt).toBeNull();
    expect((await server.app.inject({ method: "PUT", url: "/admin/api/routines/rt_nope", headers: { authorization: AUTH }, payload: { enabled: true } })).statusCode).toBe(400);

    const state = await server.app.inject({ method: "GET", url: "/admin/api/state", headers: { authorization: AUTH } });
    expect(state.json().routines).toHaveLength(1);
    expect(state.json().notifyChannels).toEqual(["log", "whatsapp", "sms", "email"]);

    const runs = await server.app.inject({ method: "GET", url: `/admin/api/routines/${routine.id}/runs`, headers: { authorization: AUTH } });
    expect(runs.json()).toEqual({ id: routine.id, runs: [] });
    expect((await server.app.inject({ method: "POST", url: "/admin/api/routines/rt_nope/run", headers: { authorization: AUTH }, payload: {} })).statusCode).toBe(404);

    const test = await server.app.inject({ method: "POST", url: "/admin/api/notify/test", headers: { authorization: AUTH }, payload: { channel: "log", text: "בדיקה" } });
    expect(test.statusCode).toBe(200);
    expect(test.json()).toEqual({ ok: true, channel: "log", detail: "נרשם ביומן (ערוץ log)" });
    const noPhone = await server.app.inject({ method: "POST", url: "/admin/api/notify/test", headers: { authorization: AUTH }, payload: { channel: "whatsapp" } });
    expect(noPhone.json()).toMatchObject({ ok: false, channel: "whatsapp", detail: expect.stringContaining("ownerPhone") });
    expect((await server.app.inject({ method: "GET", url: "/admin/api/routines", headers: { authorization: AUTH } })).json().notifications).toHaveLength(2);

    expect(JSON.parse(fs.readFileSync(path.join(dir, "routines.json"), "utf8")).routines).toHaveLength(1);
    const removed = await server.app.inject({ method: "DELETE", url: `/admin/api/routines/${routine.id}`, headers: { authorization: AUTH } });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({ ok: true, routine: { id: routine.id }, routines: [] });
    expect((await server.app.inject({ method: "DELETE", url: `/admin/api/routines/${routine.id}`, headers: { authorization: AUTH } })).statusCode).toBe(400);
    expect((await server.app.inject({ method: "GET", url: "/admin/api/routines" })).statusCode).toBe(401);
    expect(server.routines.list()).toEqual([]);
  });

  it("refuses cross-site and form-encoded requests to the admin API (CSRF)", async () => {
    // A cross-site form post replays the browser's Basic credentials but cannot send JSON.
    const form = await server.app.inject({ method: "POST", url: "/admin/api/rules", headers: { authorization: AUTH, "content-type": "application/x-www-form-urlencoded" }, payload: "text=evil" });
    expect(form.statusCode).toBe(415);
    const crossSite = await server.app.inject({ method: "POST", url: "/admin/api/rules", headers: { authorization: AUTH, "content-type": "application/json", "sec-fetch-site": "cross-site" }, payload: { text: "evil" } });
    expect(crossSite.statusCode).toBe(403);
    const login = await server.app.inject({ method: "GET", url: "/admin/mcp/crm/login", headers: { authorization: AUTH, "sec-fetch-site": "cross-site" } });
    expect(login.statusCode).toBeGreaterThanOrEqual(300);
    expect(login.headers.location).toContain("login=error");
    expect(server.rules.list().some((r) => r.text === "evil")).toBe(false);
    // Same-origin JSON keeps working.
    const ok = await server.app.inject({ method: "POST", url: "/admin/api/rules", headers: { authorization: AUTH, "content-type": "application/json", "sec-fetch-site": "same-origin" }, payload: { text: "כלל תקין" } });
    expect(ok.statusCode).toBe(200);
    await server.app.inject({ method: "DELETE", url: `/admin/api/rules/${ok.json().rule.id}`, headers: { authorization: AUTH } });
  });

  it("sends security headers with the admin page and no-store on the API", async () => {
    const page = await server.app.inject({ method: "GET", url: "/admin", headers: { authorization: AUTH } });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(page.headers["x-frame-options"]).toBe("DENY");
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
    expect(page.headers["cache-control"]).toBe("no-store");
    const api = await server.app.inject({ method: "GET", url: "/admin/api/state", headers: { authorization: AUTH } });
    expect(api.headers["cache-control"]).toBe("no-store");
  });

  it("refuses an OAuth callback that does not belong to a login started here", async () => {
    // Built separately with an OAuth server configured (the shared instance has none). The
    // server is disabled so nothing is contacted; the callback route still resolves it.
    const cfg = path.join(dir, "mcp-servers-oauth.json");
    fs.writeFileSync(cfg, JSON.stringify({ servers: [{ name: "crm", label: "CRM", url: "https://crm.example.com/mcp", auth: { type: "oauth" }, enabled: false }] }), "utf8");
    vi.stubEnv("MCP_CONFIG_PATH", cfg);
    vi.resetModules();
    const mod = await import("../src/server.js");
    const other = await mod.buildServer();
    try {
      const res = await other.app.inject({ method: "GET", url: "/oauth/callback/crm?code=abc" });
      expect(res.statusCode).toBeGreaterThanOrEqual(300);
      expect(decodeURIComponent(res.headers.location ?? "")).toContain("No OAuth login is pending");
      const withState = await other.app.inject({ method: "GET", url: "/oauth/callback/crm?code=abc&state=nope" });
      expect(decodeURIComponent(withState.headers.location ?? "")).toContain("No OAuth login is pending");
      expect(fs.existsSync(path.join(dir, "auth", "crm.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "auth", "crm.json"), "utf8")) : {}).toEqual({});
    } finally {
      await other.app.close();
      vi.stubEnv("MCP_CONFIG_PATH", path.join(dir, "mcp-servers.json"));
    }
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
      { type: "stt", name: "utt_1", max: server.settings.get().sttMaxSeconds, confirm: "no" },
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
