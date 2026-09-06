/**
 * npm run mcp:tools [-- --json] [-- --server <name>]
 *
 * Connects to the configured remote MCP servers (same hub as the phone agent) and lists
 * every tool the assistant would see, with its read/write classification and whether it
 * is always loaded into Claude's context. Useful after editing config/mcp-servers.json or
 * after an OAuth login.
 */
import "./quiet-env.js";
import { env } from "../config.js";
import { loadMcpConfig } from "../mcp/config.js";
import type { CatalogTool, McpServerStatus } from "../mcp/hub.js";
import { buildHub, c, cliLogger, errorText, exitAfterFlush, parseArgs, stateLabel, stopHubQuietly } from "./common.js";

const USAGE = `Usage: npm run mcp:tools [-- --json] [-- --server <name>]

  --json            print the raw server status + tool catalog as JSON (stdout only)
  --server <name>   connect only to this server (even when it is disabled in the config)
  --help            this text

Config file: ${env.mcpConfigPath} (MCP_CONFIG_PATH)   Credentials: ${env.mcpAuthDir} (MCP_AUTH_DIR)`;

const DESCRIPTION_CHARS = 100;

function shortDescription(t: CatalogTool): string {
  const d = t.description.replace(/\s+/g, " ").trim();
  return d.length > DESCRIPTION_CHARS ? `${d.slice(0, DESCRIPTION_CHARS - 1)}…` : d;
}

function printReport(servers: McpServerStatus[], tools: CatalogTool[]): void {
  if (servers.length === 0) {
    console.log(c.yellow(`אין שרתי MCP בקובץ ${env.mcpConfigPath} (no MCP servers configured).`));
    return;
  }
  for (const s of servers) {
    const own = tools.filter((t) => t.server === s.name);
    console.log(`${c.bold(s.name)}  ${s.label !== s.name ? s.label + "  " : ""}${c.dim(s.url)}`);
    const info = [`state: ${stateLabel(s.state)}`, `tools: ${s.toolCount}`, `auth: ${s.authType}`];
    if (s.serverInfo) info.push(`server: ${s.serverInfo.name} ${s.serverInfo.version}`);
    console.log(`  ${info.join("   ")}`);
    if (s.error) console.log(`  error: ${c.red(s.error)}`);
    if (s.state === "needs_login") console.log(`  ${c.dim(`-> npm run mcp:login -- ${s.name}`)}`);
    if (own.length) {
      const width = Math.min(60, Math.max(...own.map((t) => t.fullName.length)));
      const always = own.filter((t) => t.alwaysLoad).length;
      const writes = own.filter((t) => t.kind === "write").length;
      console.log(`  ${c.dim(`${own.length} tools: ${own.length - writes} read, ${writes} write, ${always} always loaded`)}`);
      for (const t of own) {
        const kind = t.kind === "write" ? c.yellow("[write]") : c.green("[read] ");
        const star = t.alwaysLoad ? c.cyan("*always") : "       ";
        console.log(`  ${t.fullName.padEnd(width)}  ${kind}  ${star}  ${c.dim(shortDescription(t))}`);
      }
    }
    console.log("");
  }
  const enabled = servers.filter((s) => s.enabled);
  const connected = enabled.filter((s) => s.state === "connected");
  const failed = enabled.filter((s) => s.state !== "connected");
  console.log(`${c.bold("סיכום")}: ${connected.length}/${enabled.length} servers connected, ${tools.length} tools total${failed.length ? c.yellow(`, not connected: ${failed.map((s) => `${s.name} (${s.state})`).join(", ")}`) : ""}`);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2), ["server"]);
  if (args.flags.help || args.flags.h) {
    console.log(USAGE);
    return 0;
  }
  const json = args.flags.json === true;
  const only = typeof args.flags.server === "string" ? args.flags.server : undefined;
  if (args.flags.server === true) {
    console.error(c.red("--server needs a server name.\n") + USAGE);
    return 1;
  }
  const logger = cliLogger();

  let config = loadMcpConfig(env.mcpConfigPath);
  if (only) {
    const server = config.servers.find((s) => s.name === only);
    if (!server) {
      const names = config.servers.map((s) => s.name).join(", ") || "(none)";
      console.error(c.red(`Unknown server "${only}". Configured servers: ${names}`));
      return 1;
    }
    if (!server.enabled && !json) console.error(c.yellow(`השרת "${only}" מושבת בקונפיג (enabled=false) - מתחבר אליו רק לצורך הבדיקה.`));
    config = { servers: [{ ...server, enabled: true }] };
  }

  const hub = buildHub(config, logger);
  const enabledCount = config.servers.filter((s) => s.enabled).length;
  if (!json) console.error(c.dim(`מתחבר ל-${enabledCount} שרתי MCP מתוך ${env.mcpConfigPath} ...`));
  await hub.start();

  const servers = hub.status();
  const tools = hub.tools();
  if (json) {
    console.log(JSON.stringify({ servers, tools }, null, 2));
  } else {
    printReport(servers, tools);
  }
  await stopHubQuietly(hub, logger);
  return 0;
}

main()
  .then((code) => exitAfterFlush(code))
  .catch((err) => {
    console.error(c.red(`mcp:tools failed: ${errorText(err)}`));
    exitAfterFlush(1);
  });
