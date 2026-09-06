/**
 * Helpers shared by the CLI entry points (mcp-login, mcp-tools, chat). They reuse the
 * server's modules as-is; the only CLI-specific pieces are a synchronous stderr logger
 * (so stdout stays clean for --json output and nothing is lost on process.exit), a tiny
 * argument parser and terminal colours.
 */
import "./quiet-env.js";
import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import pretty from "pino-pretty";
import { env } from "../config.js";
import type { Logger } from "../logger.js";
import type { McpConfig } from "../mcp/config.js";
import { McpHub, type McpServerStatus } from "../mcp/hub.js";

/* ------------------------------- colours ------------------------------- */

const noColor = "NO_COLOR" in process.env || process.env.TERM === "dumb";

export function useColor(stream: NodeJS.WriteStream = process.stdout): boolean {
  return !noColor && stream.isTTY === true;
}

const paint = (open: number, close: number) => (s: string) => (useColor() ? `\x1b[${open}m${s}\x1b[${close}m` : s);

export const c = {
  dim: paint(2, 22),
  bold: paint(1, 22),
  red: paint(31, 39),
  green: paint(32, 39),
  yellow: paint(33, 39),
  cyan: paint(36, 39),
};

/* -------------------------------- logger ------------------------------- */

/** Pretty, synchronous logger on stderr. Default level "warn" so the CLI output itself stays readable. */
export function cliLogger(level: string = process.env.LOG_LEVEL ?? "warn"): Logger {
  const stream = pretty({ sync: true, destination: 2, colorize: useColor(process.stderr), translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname" });
  return pino({ level }, stream);
}

/* --------------------------------- args -------------------------------- */

export interface CliArgs {
  positional: string[];
  /** `--flag` -> true, `--flag=value` / `--flag value` (for names in valueFlags) -> value. */
  flags: Record<string, string | true>;
}

export function parseArgs(argv: string[], valueFlags: string[] = []): CliArgs {
  const out: CliArgs = { positional: [], flags: {} };
  const takesValue = new Set(valueFlags);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") continue;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        out.flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const name = a.slice(2);
      const next = argv[i + 1];
      if (takesValue.has(name) && next !== undefined && !next.startsWith("-")) {
        out.flags[name] = next;
        i++;
      } else {
        out.flags[name] = true;
      }
    } else if (a.startsWith("-") && a.length > 1) {
      out.flags[a.slice(1)] = true;
    } else {
      out.positional.push(a);
    }
  }
  return out;
}

/* ---------------------------------- hub -------------------------------- */

/**
 * Builds the MCP hub exactly like src/server.ts does (same auth dir, redirect URL scheme,
 * timeouts). One refinement for CLI runs: when a server already has stored credentials,
 * the redirect URL they were registered with is reused, so listing tools or chatting from
 * the terminal never invalidates a login that was made from the admin UI or from mcp-login.
 */
export function buildHub(config: McpConfig, logger: Logger): McpHub {
  const baseUrl = env.publicBaseUrl || `http://localhost:${env.port}`;
  return new McpHub(config, {
    authDir: env.mcpAuthDir,
    redirectUrlFor: (name) => storedRedirectUrl(name) ?? `${baseUrl}/oauth/callback/${name}`,
    logger,
    toolTimeoutMs: env.toolTimeoutMs,
    maxToolResultChars: env.maxToolResultChars,
  });
}

function storedRedirectUrl(serverName: string): string | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(env.mcpAuthDir, `${serverName}.json`), "utf8")) as { redirectUrl?: unknown };
    return typeof raw.redirectUrl === "string" && raw.redirectUrl ? raw.redirectUrl : undefined;
  } catch {
    return undefined;
  }
}

/* ------------------------------- formatting ---------------------------- */

export function stateLabel(state: McpServerStatus["state"]): string {
  switch (state) {
    case "connected":
      return c.green("connected");
    case "needs_login":
      return c.yellow("needs_login");
    case "error":
      return c.red("error");
    case "disabled":
      return c.dim("disabled");
    default:
      return state;
  }
}

/** One-line summary of a server, e.g. `crm  CRM חוויה בקליק  connected (112 tools)`. */
export function serverSummary(s: McpServerStatus): string {
  const parts = [c.bold(s.name.padEnd(8)), s.label !== s.name ? s.label : "", stateLabel(s.state)];
  if (s.state === "connected") parts.push(`(${s.toolCount} tools)`);
  if (s.error) parts.push(c.red(`- ${s.error}`));
  if (s.state === "needs_login") parts.push(c.dim(`-> npm run mcp:login -- ${s.name}`));
  return parts.filter(Boolean).join("  ");
}

/**
 * Closes the hub without the "MCP transport closed" warnings the hub emits for its own
 * shutdown (they are meaningful while the server runs, only noise at the end of a CLI run).
 */
export async function stopHubQuietly(hub: McpHub, logger: Logger): Promise<void> {
  const level = logger.level;
  logger.level = "error";
  try {
    await hub.stop();
  } catch {
    /* ignore */
  } finally {
    logger.level = level;
  }
}

/** Exits once stdout has been flushed (pipes can be asynchronous on some platforms). */
export function exitAfterFlush(code: number): void {
  process.exitCode = code;
  const done = () => process.exit(code);
  if (process.stdout.writableNeedDrain) process.stdout.once("drain", done);
  else done();
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
