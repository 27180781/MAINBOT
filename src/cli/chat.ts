/**
 * npm run chat
 *
 * Interactive terminal chat with the very same VoiceAgent that answers the phone: same
 * system prompt, MCP tools, confirmation gate for write actions, usage log and standing
 * rules. Lets the owner test the assistant (and its tools) without placing a call.
 *
 *   /reset   start a new conversation      /prompt  print the system prompt
 *   /exit    quit (Ctrl-C / Ctrl-D work too)
 */
import "./quiet-env.js";
import crypto from "node:crypto";
import readline from "node:readline";
import Anthropic from "@anthropic-ai/sdk";
import { env, SettingsStore } from "../config.js";
import { loadMcpConfig } from "../mcp/config.js";
import { VoiceAgent, type ConversationState } from "../agent/agent.js";
import { RulesStore } from "../agent/rules.js";
import { UsageStore } from "../usage/usage-store.js";
import { buildHub, c, cliLogger, errorText, exitAfterFlush, serverSummary, stopHubQuietly } from "./common.js";

const PROMPT = "אתה> ";
const CHANNEL = "צ'אט טרמינל (טקסט, בדיקה מהמחשב)";
const HELP = "פקודות: /reset שיחה חדשה · /prompt הצגת הנחיות המערכת · /exit יציאה (גם Ctrl-C)";

async function main(): Promise<void> {
  const logger = cliLogger();
  if (!env.anthropicApiKey) console.error(c.yellow("ANTHROPIC_API_KEY לא מוגדר - מסתמך על מקורות האימות האחרים של ה-SDK."));

  const settings = new SettingsStore(env.dataDir);
  const usage = new UsageStore(env.dataDir);
  const rules = new RulesStore(env.dataDir);
  const hub = buildHub(loadMcpConfig(env.mcpConfigPath), logger);
  const anthropic = new Anthropic(env.anthropicApiKey ? { apiKey: env.anthropicApiKey } : {});
  const agent = new VoiceAgent({
    client: anthropic,
    hub,
    settings,
    usage,
    rules,
    logger,
    instructionsPath: env.instructionsPath,
    timeZone: env.timezone,
    agentTimeoutMs: env.agentTimeoutMs,
    toolTimeoutMs: env.toolTimeoutMs,
  });

  const configured = hub.serverConfigs().filter((s) => s.enabled).length;
  console.log(c.dim(`מתחבר ל-${configured} שרתי MCP (${env.mcpConfigPath}) ...`));
  await hub.start();
  const status = hub.status();
  if (status.length === 0) console.log(c.yellow("אין שרתי MCP בקונפיג - העוזר יענה בלי כלים חיצוניים."));
  for (const s of status) console.log(serverSummary(s));

  const s = settings.get();
  const phone = s.allowedPhones.find((p) => p && p !== "*") ?? "cli";
  console.log(`${c.bold("מודל")}: ${s.model}  ${c.bold("מאמץ")}: ${s.effort}  ${c.bold("כלים")}: ${hub.tools().length}  ${c.bold("מזהה מתקשר")}: ${phone}  ${c.bold("אישור פעולות")}: ${s.confirmWrites ? "כן" : "לא"}`);
  console.log(c.dim(HELP));
  console.log("");

  const newConversation = (): ConversationState => agent.newConversation(`cli-${crypto.randomUUID().slice(0, 8)}`, phone);
  let conv = newConversation();
  const isTty = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: PROMPT, terminal: isTty });

  let closing = false;
  const shutdown = async (code: number): Promise<void> => {
    if (closing) return;
    closing = true;
    rl.close();
    console.log(`\n${c.dim("להתראות.")}`);
    await stopHubQuietly(hub, logger);
    exitAfterFlush(code);
  };

  const handleLine = async (raw: string): Promise<void> => {
    const text = raw.trim();
    if (!text) return;
    if (text === "/exit" || text === "/quit") return shutdown(0);
    if (text === "/help" || text === "/?") {
      console.log(c.dim(HELP));
      return;
    }
    if (text === "/reset") {
      conv = newConversation();
      console.log(c.dim(`שיחה חדשה התחילה (${conv.callId}).`));
      return;
    }
    if (text === "/prompt") {
      console.log(c.dim("----- system prompt -----"));
      console.log(agent.getSystemPrompt());
      console.log(c.dim(`----- ${agent.getSystemPrompt().length} chars -----`));
      return;
    }
    if (text.startsWith("/")) {
      console.log(c.yellow(`פקודה לא מוכרת: ${text}. ${HELP}`));
      return;
    }

    if (isTty) process.stdout.write(c.dim("חושב..."));
    try {
      const reply = await agent.respond(conv, text, { phone, channel: CHANNEL });
      if (isTty) process.stdout.write("\r\x1b[2K");
      console.log(`${c.bold("העוזר>")} ${reply.text}`);
      const meta = [`${(reply.durationMs / 1000).toFixed(1)}s`, `${reply.iterations} ${reply.iterations === 1 ? "סבב" : "סבבים"}`, reply.toolCalls.length ? `כלים: ${reply.toolCalls.join(", ")}` : "ללא כלים"];
      if (reply.error) meta.push(`שגיאה: ${reply.error}`);
      console.log(c.dim(`  [${meta.join(" · ")}]`));
      if (reply.endCall) {
        console.log(c.dim("(העוזר סיים את השיחה - ההודעה הבאה תפתח שיחה חדשה)"));
        conv = newConversation();
      }
    } catch (err) {
      if (isTty) process.stdout.write("\r\x1b[2K");
      console.log(c.red(`שגיאה: ${errorText(err)}`));
    }
  };

  // Lines are handled one at a time (pasting several lines queues them) and the prompt
  // is only redrawn once the queue is empty.
  const queue: string[] = [];
  let busy = false;
  const pump = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      while (queue.length && !closing) await handleLine(queue.shift()!);
    } finally {
      busy = false;
    }
    if (!closing && isTty) rl.prompt();
  };

  rl.on("line", (line) => {
    queue.push(line);
    void pump();
  });
  rl.on("SIGINT", () => void shutdown(0));
  rl.on("close", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));
  if (isTty) rl.prompt();
}

main().catch((err) => {
  console.error(c.red(`chat failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`));
  exitAfterFlush(1);
});
