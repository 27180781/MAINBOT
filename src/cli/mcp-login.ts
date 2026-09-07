/**
 * npm run mcp:login -- <serverName> [--logout] [--no-open] [--port <n>]
 *
 * OAuth login for one remote MCP server from the terminal (the admin UI at /admin does the
 * same through the browser). The flow:
 *
 *   1. discover the server's authorization server and register this client (MCP SDK `auth`)
 *   2. print the authorization URL (and try to open it in a browser)
 *   3. receive the authorization code either on http://localhost:<port>/callback or pasted
 *      on stdin (full redirect URL or bare code - for headless servers)
 *   4. exchange the code for tokens, store them in MCP_AUTH_DIR/<server>.json
 *   5. verify by connecting with the hub and counting the tools
 *
 * --logout removes the stored credentials for the server.
 */
import "./quiet-env.js";
import http from "node:http";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { env } from "../config.js";
import { loadMcpConfig, type McpServerConfig } from "../mcp/config.js";
import { FileOAuthProvider } from "../mcp/oauth-provider.js";
import { McpHub } from "../mcp/hub.js";
import { c, cliLogger, errorText, exitAfterFlush, parseArgs, stopHubQuietly } from "./common.js";

const USAGE = `Usage: npm run mcp:login -- <serverName> [--logout] [--no-open] [--port <n>]

  <serverName>   a server with auth.type "oauth" in ${env.mcpConfigPath}
  --logout       delete the stored credentials of the server instead of logging in
  --no-open      do not try to open the browser, only print the URL
  --port <n>     local callback port (default MCP_OAUTH_CALLBACK_PORT=${env.oauthCallbackPort})
  --help         this text

The authorization code can also be pasted on stdin (the full redirect URL or just the code),
which is what you do when this runs on a server without a browser.`;

const LOGIN_TIMEOUT_MS = 10 * 60_000;

interface CodeDelivery {
  code: string;
  state: string | null;
  source: "callback" | "stdin";
  /** Answers the browser once the token exchange finished (callback source only). */
  reply?: (ok: boolean, message: string) => void;
}

/** Single-assignment promise: the first valid code from the callback or from stdin wins. */
class CodeWaiter {
  readonly promise: Promise<CodeDelivery>;
  settled = false;
  private resolveFn!: (d: CodeDelivery) => void;
  private rejectFn!: (e: Error) => void;

  constructor() {
    this.promise = new Promise<CodeDelivery>((resolve, reject) => {
      this.resolveFn = resolve;
      this.rejectFn = reject;
    });
  }

  deliver(d: CodeDelivery): boolean {
    if (this.settled) return false;
    this.settled = true;
    this.resolveFn(d);
    return true;
  }

  fail(err: Error): void {
    if (this.settled) return;
    this.settled = true;
    this.rejectFn(err);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);
}

function sendPage(res: http.ServerResponse, status: number, title: string, text: string): void {
  const body = `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:40em;margin:4em auto;padding:0 1em;line-height:1.6}h1{font-size:1.4em}</style></head>
<body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p><p dir="ltr"><small>MAINBOT phone agent</small></p></body></html>`;
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

/** Listens on the IPv4 loopback (required) and the IPv6 loopback (best effort) so `localhost` works either way. */
async function listenLoopback(port: number, handler: http.RequestListener): Promise<{ close: () => Promise<void> }> {
  const servers: http.Server[] = [];
  for (const host of ["127.0.0.1", "::1"]) {
    const srv = http.createServer(handler);
    try {
      await new Promise<void>((resolve, reject) => {
        srv.once("error", reject);
        srv.listen(port, host, () => {
          srv.off("error", reject);
          resolve();
        });
      });
      srv.on("error", () => {});
      servers.push(srv);
    } catch (err) {
      if (host === "127.0.0.1") throw err;
    }
  }
  return {
    close: async () => {
      for (const s of servers) {
        s.closeAllConnections();
        await new Promise<void>((resolve) => s.close(() => resolve()));
      }
    },
  };
}

type Pasted = { kind: "code"; code: string; state: string | null } | { kind: "denied"; message: string } | { kind: "invalid"; message: string };

/** Accepts the full redirect URL, just its query string, or a bare authorization code. */
export function parsePastedInput(line: string): Pasted | null {
  const s = line.trim();
  if (!s) return null;
  let params: URLSearchParams | null = null;
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      params = u.searchParams;
      if (!params.has("code") && !params.has("error") && u.hash.includes("code=")) params = new URLSearchParams(u.hash.replace(/^#/, ""));
    } catch {
      return { kind: "invalid", message: "הכתובת שהודבקה אינה תקינה (invalid URL)" };
    }
  } else if (/(^|[?&])code=/.test(s)) {
    params = new URLSearchParams(s.replace(/^\?/, ""));
  }
  if (params) {
    const error = params.get("error");
    if (error) return { kind: "denied", message: params.get("error_description") ?? error };
    const code = params.get("code");
    if (!code) return { kind: "invalid", message: "לא נמצא פרמטר code בכתובת שהודבקה" };
    return { kind: "code", code, state: params.get("state") };
  }
  if (/^[A-Za-z0-9._~+/=-]+$/.test(s)) return { kind: "code", code: s, state: null };
  return { kind: "invalid", message: "קלט לא מזוהה - הדביקו את כתובת ההפניה המלאה (redirect URL) או את הקוד בלבד" };
}

function openInBrowser(url: string): boolean {
  let cmd: string;
  let args: string[];
  if (process.platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (process.platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url.replace(/&/g, "^&")];
  } else {
    // Without a display xdg-open may start a text browser in this very terminal - do not risk it.
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
    cmd = "xdg-open";
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function listServers(servers: McpServerConfig[]): string {
  if (servers.length === 0) return `  (no servers in ${env.mcpConfigPath})`;
  return servers.map((s) => `  ${s.name.padEnd(10)} auth=${s.auth.type.padEnd(7)} ${s.enabled ? "" : "(disabled) "}${s.label ?? ""}`).join("\n");
}

async function verifyLogin(server: McpServerConfig, redirect: string): Promise<number> {
  console.log(c.dim("מאמת את החיבור לשרת (connecting to verify) ..."));
  const logger = cliLogger();
  const hub = new McpHub(
    { servers: [{ ...server, enabled: true }] },
    { authDir: env.mcpAuthDir, redirectUrlFor: () => redirect, logger, toolTimeoutMs: env.toolTimeoutMs, maxToolResultChars: env.maxToolResultChars },
  );
  await hub.start();
  const status = hub.status()[0];
  await stopHubQuietly(hub, logger);
  if (status?.state === "connected") {
    const info = status.serverInfo ? ` (${status.serverInfo.name} ${status.serverInfo.version})` : "";
    console.log(c.green(`✓ ההתחברות ל-${server.label ?? server.name} הצליחה: ${status.toolCount} כלים זמינים${info}.`));
    console.log(c.dim(`האישורים נשמרו ב-${path.join(env.mcpAuthDir, `${server.name}.json`)}. הפעילו מחדש את השרת (או לחצו "התחבר מחדש" בממשק הניהול) כדי שישתמש בהם.`));
    return 0;
  }
  console.error(c.red(`✗ ההתחברות נשמרה אבל החיבור לשרת נכשל: state=${status?.state ?? "?"}${status?.error ? ` - ${status.error}` : ""}`));
  if (status?.state === "needs_login") console.error(c.dim("השרת דחה את הטוקן שהתקבל. נסו שוב, ואם זה חוזר בדקו את הגדרת scope בקובץ הקונפיג."));
  return 1;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2), ["port"]);
  if (args.flags.help || args.flags.h) {
    console.log(USAGE);
    return 0;
  }
  const config = loadMcpConfig(env.mcpConfigPath);
  const name = args.positional[0];
  if (!name) {
    console.error(c.red("חסר שם שרת (missing server name).\n") + USAGE + "\n\nServers:\n" + listServers(config.servers));
    return 1;
  }
  const server = config.servers.find((s) => s.name === name);
  if (!server) {
    console.error(c.red(`שרת "${name}" לא קיים בקובץ ${env.mcpConfigPath}.`) + "\nServers:\n" + listServers(config.servers));
    return 1;
  }
  if (server.auth.type !== "oauth") {
    console.error(c.red(`השרת "${name}" משתמש באימות מסוג "${server.auth.type}", לא OAuth - אין צורך בהתחברות.`));
    return 1;
  }
  const scope = server.auth.scope;
  const port = typeof args.flags.port === "string" && Number(args.flags.port) > 0 ? Number(args.flags.port) : env.oauthCallbackPort;
  const redirect = `http://localhost:${port}/callback`;
  const provider = new FileOAuthProvider(server.name, redirect, env.mcpAuthDir, scope);
  const label = server.label ?? server.name;

  if (args.flags.logout) {
    provider.clear();
    console.log(c.green(`✓ האישורים של ${label} נמחקו (${path.join(env.mcpAuthDir, `${server.name}.json`)}).`));
    return 0;
  }

  if (!server.enabled) console.error(c.yellow(`שימו לב: השרת "${name}" מושבת בקונפיג (enabled=false); ההתחברות תישמר בכל זאת.`));
  if (provider.hasTokens()) console.log(c.dim("קיימת התחברות שמורה - היא תוחלף כשההתחברות החדשה תצליח."));
  provider.prepareLogin();
  console.log(`${c.bold("התחברות ל-")}${c.bold(label)}  ${c.dim(server.url)}`);

  /* 1. local callback server (the redirect URI registered with the authorization server) */
  const waiter = new CodeWaiter();
  const handler: http.RequestListener = (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/callback") {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    if (waiter.settled) {
      sendPage(res, 200, "הקוד כבר התקבל", "This login was already completed - check the terminal.");
      return;
    }
    const error = url.searchParams.get("error");
    if (error) {
      const message = url.searchParams.get("error_description") ?? error;
      sendPage(res, 400, "ההתחברות נכשלה", message);
      waiter.fail(new Error(`Authorization server returned an error: ${message}`));
      return;
    }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code) {
      sendPage(res, 400, "חסר קוד", "The callback did not include an authorization code.");
      return;
    }
    const expected = provider.expectedState();
    if (expected && state !== expected) {
      console.error(c.yellow("התקבל callback עם state לא תואם - מתעלם (OAuth state mismatch, ignoring)."));
      sendPage(res, 400, "state לא תואם", "This callback does not belong to the login started in the terminal. Open the URL printed there again.");
      return;
    }
    waiter.deliver({ code, state, source: "callback", reply: (ok, message) => sendPage(res, ok ? 200 : 500, ok ? "ההתחברות הצליחה" : "ההתחברות נכשלה", message) });
  };
  let callback: { close: () => Promise<void> } | null = null;
  try {
    callback = await listenLoopback(port, handler);
  } catch (err) {
    console.error(c.yellow(`לא ניתן להאזין על ${redirect} (${errorText(err)}). ממשיכים במצב הדבקה בלבד: אחרי האישור העתיקו את הכתובת משורת הכתובת של הדפדפן והדביקו כאן.`));
    console.error(c.dim("(port busy? set MCP_OAUTH_CALLBACK_PORT or pass --port; the redirect URL must stay identical between login attempts)"));
  }

  /* 2. discovery + client registration + authorization URL */
  let authorizationUrl: URL | undefined;
  provider.onRedirect = (u) => {
    authorizationUrl = u;
  };
  let result: "AUTHORIZED" | "REDIRECT";
  try {
    result = await auth(provider.loginView(), { serverUrl: server.url, scope });
  } catch (err) {
    await callback?.close();
    console.error(c.red(`✗ לא הצלחתי להתחיל את תהליך ההתחברות מול ${server.url}: ${errorText(err)}`));
    console.error(c.dim("בדקו שהכתובת בקובץ הקונפיג נכונה, שהשרת זמין ושהוא תומך ב-OAuth (metadata discovery / dynamic client registration)."));
    return 1;
  } finally {
    provider.onRedirect = undefined;
  }

  const timer = setTimeout(() => waiter.fail(new Error(`no authorization code received within ${LOGIN_TIMEOUT_MS / 60_000} minutes`)), LOGIN_TIMEOUT_MS);
  let stdin: readline.Interface | null = null;
  try {
    if (result === "REDIRECT") {
      if (!authorizationUrl) throw new Error("Authorization server did not provide an authorization URL");
      const urlText = authorizationUrl.toString();
      console.log("");
      console.log(c.bold("פתחו את הקישור הבא בדפדפן ואשרו את הגישה (open this URL in your browser and approve):"));
      console.log("");
      console.log(`  ${c.cyan(urlText)}`);
      console.log("");
      const opened = args.flags["no-open"] ? false : openInBrowser(urlText);
      if (opened) console.log(c.dim("(ניסיתי לפתוח את הדפדפן אוטומטית; אם לא נפתח - העתיקו את הקישור ידנית)"));
      console.log(c.dim(callback ? `ממתין לקוד ב-${redirect} ...` : "ממתין לקוד ..."));
      console.log(c.dim("אם הדפדפן נמצא במחשב אחר: אחרי האישור הדביקו כאן את הכתובת המלאה אליה הופנה הדפדפן (או את הקוד בלבד) ולחצו Enter."));

      /* 3. also accept the code on stdin (headless servers) */
      stdin = readline.createInterface({ input: process.stdin, terminal: false });
      stdin.on("line", (line) => {
        const parsed = parsePastedInput(line);
        if (!parsed || waiter.settled) return;
        if (parsed.kind === "denied") {
          waiter.fail(new Error(`Authorization server returned an error: ${parsed.message}`));
          return;
        }
        if (parsed.kind === "invalid") {
          console.error(c.yellow(parsed.message));
          return;
        }
        const expected = provider.expectedState();
        if (parsed.state !== null && expected && parsed.state !== expected) {
          console.error(c.yellow("ה-state בכתובת שהודבקה לא תואם להתחברות הזאת (OAuth state mismatch). הדביקו את הכתובת מהניסיון הנוכחי."));
          return;
        }
        if (parsed.state === null && expected) console.log(c.dim("(הודבק קוד בלי state - מדלג על בדיקת ה-state; PKCE עדיין מגן על ההחלפה)"));
        waiter.deliver({ code: parsed.code, state: parsed.state, source: "stdin" });
      });

      const delivery = await waiter.promise;
      console.log(c.dim(`התקבל קוד (${delivery.source === "callback" ? "מהדפדפן" : "מההדבקה"}), מחליף אותו בטוקן ...`));

      /* 4. exchange the code for tokens */
      try {
        const exchanged = await auth(provider.loginView(), { serverUrl: server.url, authorizationCode: delivery.code, scope });
        if (exchanged !== "AUTHORIZED") throw new Error(`unexpected auth result "${exchanged}"`);
      } catch (err) {
        delivery.reply?.(false, `Token exchange failed: ${errorText(err)}`);
        throw new Error(`החלפת הקוד בטוקן נכשלה (token exchange failed): ${errorText(err)}`);
      } finally {
        provider.consumePendingLogin();
      }
      delivery.reply?.(true, `ההתחברות ל-${label} הצליחה. אפשר לסגור את החלון ולחזור לטרמינל. (Login succeeded - you can close this window.)`);
    } else {
      console.log(c.dim("השרת אישר את הלקוח בלי צורך בדפדפן (already authorized)."));
    }
  } catch (err) {
    console.error(c.red(`✗ ${errorText(err)}`));
    return 1;
  } finally {
    clearTimeout(timer);
    stdin?.close();
    await callback?.close();
  }

  /* 5. verify */
  return verifyLogin(server, redirect);
}

const isMain = process.argv[1] !== undefined && /mcp-login\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  main()
    .then((code) => exitAfterFlush(code))
    .catch((err) => {
      console.error(c.red(`mcp:login failed: ${errorText(err)}`));
      exitAfterFlush(1);
    });
}
