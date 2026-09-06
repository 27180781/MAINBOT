import http from "node:http";
import Fastify from "fastify";
import Anthropic from "@anthropic-ai/sdk";
import { env, SettingsStore } from "./config.js";
import { logger } from "./logger.js";
import { loadMcpConfig } from "./mcp/config.js";
import { McpHub } from "./mcp/hub.js";
import { VoiceAgent } from "./agent/agent.js";
import { UsageStore } from "./usage/usage-store.js";
import { SessionStore } from "./calls/session.js";
import { registerTechnolineRoutes } from "./pbx/technoline/route.js";
import { registerAdminRoutes } from "./admin/routes.js";

/** 3 seconds of 8 kHz 16-bit mono silence, served as a filler when FILLER_MODE=silence. */
export function silenceWav(seconds = 3, sampleRate = 8000): Buffer {
  const dataBytes = seconds * sampleRate * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
}

export async function buildServer() {
  if (!env.webhookSecret) logger.warn("WEBHOOK_SECRET is empty - the PBX endpoint will reject every request until it is set");
  if (!env.anthropicApiKey) logger.warn("ANTHROPIC_API_KEY is not set - relying on the SDK's other credential sources");

  const settings = new SettingsStore(env.dataDir);
  const usage = new UsageStore(env.dataDir);
  const sessions = new SessionStore(env.sessionTtlMs);
  const mcpConfig = loadMcpConfig(env.mcpConfigPath);
  const baseUrl = env.publicBaseUrl || `http://localhost:${env.port}`;
  const hub = new McpHub(mcpConfig, {
    authDir: env.mcpAuthDir,
    redirectUrlFor: (name) => `${baseUrl}/oauth/callback/${name}`,
    logger,
    toolTimeoutMs: env.toolTimeoutMs,
    maxToolResultChars: env.maxToolResultChars,
  });
  const anthropic = new Anthropic(env.anthropicApiKey ? { apiKey: env.anthropicApiKey } : {});
  const agent = new VoiceAgent({
    client: anthropic,
    hub,
    settings,
    usage,
    logger,
    instructionsPath: env.instructionsPath,
    timeZone: env.timezone,
    agentTimeoutMs: env.agentTimeoutMs,
    toolTimeoutMs: env.toolTimeoutMs,
  });

  const app = Fastify({
    logger: false,
    trustProxy: env.trustProxy,
    // The PBX accumulates every module result in the query string; allow long URLs.
    serverFactory: (handler) => http.createServer({ maxHeaderSize: 128 * 1024 }, handler),
  });

  const silence = silenceWav();
  app.get("/audio/silence.wav", async (_req, reply) => reply.type("audio/wav").header("Cache-Control", "public, max-age=86400").send(silence));
  app.get("/health", async () => ({
    ok: true,
    servers: hub.status().map((s) => ({ name: s.name, state: s.state, tools: s.toolCount })),
    activeCalls: sessions.active().length,
    model: settings.get().model,
  }));
  app.get("/", async (_req, reply) => reply.redirect("/admin"));

  const flow = registerTechnolineRoutes(app, {
    agent,
    sessions,
    settings,
    usage,
    logger,
    webhookSecret: env.webhookSecret,
    longPollMs: env.pbxLongPollMs,
    publicBaseUrl: env.publicBaseUrl,
  });
  registerAdminRoutes(app, {
    settings,
    hub,
    agent,
    usage,
    sessions,
    logger,
    adminUser: env.adminUser,
    adminPassword: env.adminPassword,
    publicBaseUrl: env.publicBaseUrl,
    webhookSecret: env.webhookSecret,
    timeZone: env.timezone,
  });

  const sweeper = setInterval(() => {
    const n = sessions.sweep();
    if (n) logger.info({ removed: n }, "swept idle call sessions");
  }, 60_000);
  sweeper.unref();

  app.addHook("onClose", async () => {
    clearInterval(sweeper);
    await hub.stop();
  });

  return { app, hub, agent, settings, usage, sessions, flow };
}

async function main(): Promise<void> {
  const { app, hub } = await buildServer();
  await app.listen({ port: env.port, host: env.host });
  logger.info({ port: env.port, admin: `${env.publicBaseUrl || `http://localhost:${env.port}`}/admin` }, "MAINBOT phone agent listening");
  // Connect to MCP servers in the background so a slow server never delays startup.
  void hub.start().then(() => logger.info({ servers: hub.status().map((s) => `${s.name}:${s.state}(${s.toolCount})`) }, "MCP servers ready"));

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

const isMain = process.argv[1] && /server\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  main().catch((err) => {
    logger.fatal({ err: err instanceof Error ? err.stack : String(err) }, "startup failed");
    process.exit(1);
  });
}
