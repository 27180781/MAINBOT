import crypto from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { auth, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "../logger.js";
import { FileOAuthProvider } from "./oauth-provider.js";
import { staticHeaders, type McpConfig, type McpServerConfig } from "./config.js";
import { classifyTool } from "./tool-policy.js";

export const CLIENT_INFO = { name: "mainbot-phone-agent", version: "0.1.0" };

export type ServerState = "disabled" | "connecting" | "connected" | "needs_login" | "error" | "disconnected";

export interface McpServerStatus {
  name: string;
  label: string;
  url: string;
  enabled: boolean;
  authType: string;
  state: ServerState;
  toolCount: number;
  error?: string;
  connectedAt?: string;
  serverInfo?: { name: string; version: string };
}

export interface CatalogTool {
  /** Name exposed to Claude: `<server>__<tool>` (<= 64 chars, [A-Za-z0-9_-]). */
  fullName: string;
  server: string;
  name: string;
  description: string;
  inputSchema: McpTool["inputSchema"];
  annotations: McpTool["annotations"];
  kind: "read" | "write";
  alwaysLoad: boolean;
  serverReadOnly: boolean;
}

export interface ToolCallOutcome {
  text: string;
  isError: boolean;
  durationMs: number;
}

interface Connection {
  config: McpServerConfig;
  client: Client | null;
  transport: Transport | null;
  provider: FileOAuthProvider | null;
  state: ServerState;
  tools: CatalogTool[];
  error?: string;
  connectedAt?: string;
  serverInfo?: { name: string; version: string };
  connecting?: Promise<void>;
}

export interface McpHubOptions {
  authDir: string;
  /** Redirect URL used for OAuth logins started from this process (admin UI or CLI). */
  redirectUrlFor: (serverName: string) => string;
  /** HTTPS URL of our client metadata document (served by the server) for SEP-991 logins. */
  clientMetadataUrl?: string;
  logger: Logger;
  toolTimeoutMs?: number;
  maxToolResultChars?: number;
}

export function toolFullName(server: string, tool: string): string {
  const raw = `${server}__${tool}`.replace(/[^A-Za-z0-9_-]/g, "_");
  if (raw.length <= 64) return raw;
  const hash = crypto.createHash("sha1").update(raw).digest("hex").slice(0, 6);
  return `${raw.slice(0, 57)}_${hash}`;
}

/**
 * Keeps one MCP client per configured remote server, aggregates their tools under
 * server-prefixed names and routes tool calls back to the right server. Servers that
 * fail to connect never block the others; a server that needs an OAuth login is
 * reported as `needs_login` so the admin UI can offer the login button.
 */
export class McpHub {
  private readonly conns = new Map<string, Connection>();
  private catalog: CatalogTool[] = [];
  private byFullName = new Map<string, CatalogTool>();
  private listeners: Array<() => void> = [];
  private readonly log: Logger;

  constructor(
    private config: McpConfig,
    private readonly opts: McpHubOptions,
  ) {
    this.log = opts.logger;
    for (const s of config.servers) this.conns.set(s.name, { config: s, client: null, transport: null, provider: null, state: s.enabled ? "disconnected" : "disabled", tools: [] });
  }

  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  private emit(): void {
    this.rebuildCatalog();
    for (const fn of this.listeners) fn();
  }

  serverConfigs(): McpServerConfig[] {
    return this.config.servers;
  }

  async start(): Promise<void> {
    await Promise.allSettled(this.config.servers.filter((s) => s.enabled).map((s) => this.connectServer(s.name)));
    this.emit();
  }

  async stop(): Promise<void> {
    for (const c of this.conns.values()) await this.closeConnection(c);
  }

  private async closeConnection(c: Connection): Promise<void> {
    // Detach before closing: the transport's onclose handler only reports drops while
    // `c.client === client`, so our own shutdown/reconnect is not logged as a lost transport.
    const client = c.client;
    c.client = null;
    c.transport = null;
    if (c.state === "connected") c.state = "disconnected";
    try {
      await client?.close();
    } catch {
      /* ignore */
    }
  }

  private providerFor(c: Connection): FileOAuthProvider | null {
    if (c.config.auth.type !== "oauth") return null;
    if (!c.provider) c.provider = new FileOAuthProvider(c.config.name, this.opts.redirectUrlFor(c.config.name), this.opts.authDir, oauthScope(c.config), this.opts.clientMetadataUrl);
    return c.provider;
  }

  private makeTransport(c: Connection, kind: "http" | "sse"): Transport {
    const url = new URL(c.config.url);
    const headers = staticHeaders(c.config);
    const provider = this.providerFor(c) ?? undefined;
    const requestInit: RequestInit | undefined = Object.keys(headers).length ? { headers } : undefined;
    if (kind === "http") return new StreamableHTTPClientTransport(url, { authProvider: provider, requestInit });
    return new SSEClientTransport(url, { authProvider: provider, requestInit, eventSourceInit: requestInit ? { fetch: (input, init) => fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string>), ...headers } }) } : undefined });
  }

  async connectServer(name: string): Promise<void> {
    const c = this.conns.get(name);
    if (!c) throw new Error(`Unknown MCP server "${name}"`);
    if (!c.config.enabled) {
      c.state = "disabled";
      return;
    }
    if (c.connecting) return c.connecting;
    c.connecting = this.doConnect(c).finally(() => {
      c.connecting = undefined;
    });
    return c.connecting;
  }

  private async doConnect(c: Connection): Promise<void> {
    await this.closeConnection(c);
    c.state = "connecting";
    c.error = undefined;
    // An OAuth server is still tried without tokens: some servers accept anonymous
    // clients, and the SDK raises UnauthorizedError (-> needs_login) when they don't.
    const provider = this.providerFor(c);
    if (provider && !provider.hasTokens()) this.log.info({ server: c.config.name }, "no OAuth tokens stored yet - trying to connect anyway");
    const kinds: Array<"http" | "sse"> = c.config.transport === "auto" ? ["http", "sse"] : [c.config.transport];
    let lastError: unknown;
    for (const kind of kinds) {
      const client = new Client(CLIENT_INFO, { capabilities: {} });
      const transport = this.makeTransport(c, kind);
      try {
        await client.connect(transport);
        c.client = client;
        c.transport = transport;
        transport.onclose = () => {
          if (c.client === client) {
            c.client = null;
            c.transport = null;
            if (c.state === "connected") c.state = "disconnected";
            this.log.warn({ server: c.config.name }, "MCP transport closed");
          }
        };
        transport.onerror = (err) => this.log.warn({ server: c.config.name, err: err.message }, "MCP transport error");
        c.tools = await this.fetchTools(c, client);
        const info = client.getServerVersion();
        c.serverInfo = info ? { name: info.name, version: info.version } : undefined;
        c.state = "connected";
        c.connectedAt = new Date().toISOString();
        this.log.info({ server: c.config.name, transport: kind, tools: c.tools.length }, "MCP server connected");
        return;
      } catch (err) {
        lastError = err;
        try {
          await client.close();
        } catch {
          /* ignore */
        }
        if (err instanceof UnauthorizedError) {
          c.state = "needs_login";
          c.error = "נדרשת התחברות מחדש (OAuth)";
          this.log.warn({ server: c.config.name }, "MCP server unauthorized - login required");
          return;
        }
        this.log.warn({ server: c.config.name, transport: kind, err: errorMessage(err) }, "MCP connect attempt failed");
      }
    }
    c.state = "error";
    c.error = errorMessage(lastError);
  }

  private async fetchTools(c: Connection, client: Client): Promise<CatalogTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    const excluded = new Set(c.config.excludeTools);
    const always = new Set(c.config.alwaysLoad);
    return tools
      .filter((t) => !excluded.has(t.name))
      .map((t) => ({
        fullName: toolFullName(c.config.name, t.name),
        server: c.config.name,
        name: t.name,
        description: t.description ?? "",
        inputSchema: t.inputSchema,
        annotations: t.annotations,
        kind: classifyTool({ name: t.name, annotations: t.annotations, inputSchema: t.inputSchema as { properties?: Record<string, unknown> } }),
        alwaysLoad: always.has(t.name),
        serverReadOnly: c.config.readOnly,
      }));
  }

  private rebuildCatalog(): void {
    const all: CatalogTool[] = [];
    for (const c of this.conns.values()) if (c.state === "connected") all.push(...c.tools);
    all.sort((a, b) => a.fullName.localeCompare(b.fullName));
    this.catalog = all;
    this.byFullName = new Map(all.map((t) => [t.fullName, t]));
  }

  tools(): CatalogTool[] {
    return this.catalog;
  }

  tool(fullName: string): CatalogTool | undefined {
    return this.byFullName.get(fullName);
  }

  status(): McpServerStatus[] {
    return [...this.conns.values()].map((c) => ({
      name: c.config.name,
      label: c.config.label ?? c.config.name,
      url: c.config.url,
      enabled: c.config.enabled,
      authType: c.config.auth.type,
      state: c.state,
      toolCount: c.tools.length,
      error: c.error,
      connectedAt: c.connectedAt,
      serverInfo: c.serverInfo,
    }));
  }

  /** Executes a tool by its prefixed name; reconnects once if the transport dropped. */
  async callTool(fullName: string, args: Record<string, unknown>, timeoutMs = this.opts.toolTimeoutMs ?? 60_000): Promise<ToolCallOutcome> {
    const started = Date.now();
    const tool = this.byFullName.get(fullName);
    if (!tool) return { text: `Unknown tool "${fullName}". Use tool search to find the right tool name.`, isError: true, durationMs: 0 };
    const c = this.conns.get(tool.server)!;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!c.client) {
        await this.connectServer(c.config.name);
        this.emit();
        if (!c.client) return { text: `Service "${c.config.label ?? c.config.name}" is not connected (${c.error ?? c.state}).`, isError: true, durationMs: Date.now() - started };
      }
      try {
        const result = await c.client.callTool({ name: tool.name, arguments: args }, undefined, { timeout: timeoutMs });
        return { text: this.renderResult(result), isError: result.isError === true, durationMs: Date.now() - started };
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          c.state = "needs_login";
          c.error = "נדרשת התחברות מחדש (OAuth)";
          await this.closeConnection(c);
          this.emit();
          return { text: `Service "${c.config.name}" requires a new login by the administrator.`, isError: true, durationMs: Date.now() - started };
        }
        const msg = errorMessage(err);
        const transportGone = !c.client || /closed|ECONNRESET|socket|fetch failed|Not connected/i.test(msg);
        this.log.warn({ server: c.config.name, tool: tool.name, attempt, err: msg }, "MCP tool call failed");
        if (transportGone && attempt === 0) {
          await this.closeConnection(c);
          continue;
        }
        return { text: `Tool error: ${msg}`, isError: true, durationMs: Date.now() - started };
      }
    }
    return { text: "Tool error: service unavailable", isError: true, durationMs: Date.now() - started };
  }

  private renderResult(result: Awaited<ReturnType<Client["callTool"]>>): string {
    const max = this.opts.maxToolResultChars ?? 20_000;
    const parts: string[] = [];
    const content = Array.isArray(result.content) ? result.content : [];
    for (const block of content as Array<Record<string, unknown>>) {
      switch (block.type) {
        case "text":
          parts.push(String(block.text ?? ""));
          break;
        case "image":
          parts.push("[image omitted]");
          break;
        case "audio":
          parts.push("[audio omitted]");
          break;
        case "resource": {
          const res = block.resource as { text?: string; uri?: string } | undefined;
          parts.push(res?.text ?? `[resource ${res?.uri ?? ""}]`);
          break;
        }
        case "resource_link":
          parts.push(`[link ${String(block.uri ?? "")}]`);
          break;
        default:
          parts.push(JSON.stringify(block));
      }
    }
    if (parts.length === 0 && result.structuredContent) parts.push(JSON.stringify(result.structuredContent));
    let text = parts.join("\n").trim();
    if (!text) text = result.isError ? "Tool returned an error without details." : "(empty result)";
    if (text.length > max) text = `${text.slice(0, max)}\n...[truncated ${text.length - max} chars - ask for a narrower query if you need more]`;
    return text;
  }

  /* ------------------------------ OAuth ------------------------------ */

  /** Starts an OAuth login and returns the URL the user must open. */
  async beginLogin(name: string): Promise<string> {
    const c = this.conns.get(name);
    if (!c) throw new Error(`Unknown MCP server "${name}"`);
    if (c.config.auth.type !== "oauth") throw new Error(`Server "${name}" does not use OAuth`);
    const provider = this.providerFor(c)!;
    provider.invalidateCredentials("tokens");
    let redirectUrl: string | undefined;
    provider.onRedirect = (url) => {
      redirectUrl = url.toString();
    };
    const result = await auth(provider, { serverUrl: c.config.url, scope: oauthScope(c.config) });
    provider.onRedirect = undefined;
    if (result === "AUTHORIZED") {
      await this.connectServer(name);
      this.emit();
      throw new Error("already-authorized");
    }
    if (!redirectUrl) throw new Error("Authorization server did not provide a redirect URL");
    return redirectUrl;
  }

  /** Completes an OAuth login with the authorization code from the callback. */
  async finishLogin(name: string, code: string, state?: string): Promise<void> {
    const c = this.conns.get(name);
    if (!c) throw new Error(`Unknown MCP server "${name}"`);
    const provider = this.providerFor(c);
    if (!provider) throw new Error(`Server "${name}" does not use OAuth`);
    const expected = provider.expectedState();
    if (expected && state && expected !== state) throw new Error("OAuth state mismatch - start the login again");
    const result = await auth(provider, { serverUrl: c.config.url, authorizationCode: code, scope: oauthScope(c.config) });
    if (result !== "AUTHORIZED") throw new Error("OAuth flow did not complete");
    await this.connectServer(name);
    this.emit();
  }

  /**
   * Connection details another process (the realtime voice agent) can use to talk to the
   * same MCP servers with the same credentials: static headers plus a fresh OAuth access
   * token. Tokens close to expiry are refreshed first through the SDK.
   */
  async credentials(): Promise<Array<{ name: string; label: string; url: string; state: ServerState; headers: Record<string, string>; expiresInSeconds: number | null }>> {
    const out: Array<{ name: string; label: string; url: string; state: ServerState; headers: Record<string, string>; expiresInSeconds: number | null }> = [];
    for (const c of this.conns.values()) {
      if (!c.config.enabled) continue;
      const headers = staticHeaders(c.config);
      let expiresInSeconds: number | null = null;
      const provider = this.providerFor(c);
      if (provider) {
        const left = provider.secondsUntilExpiry();
        if (provider.hasTokens() && provider.tokens()?.refresh_token && left !== null && left < 120) {
          try {
            await auth(provider, { serverUrl: c.config.url, scope: oauthScope(c.config) });
          } catch (err) {
            this.log.warn({ server: c.config.name, err: errorMessage(err) }, "token refresh for shared credentials failed");
          }
        }
        const token = provider.tokens()?.access_token;
        if (token) headers.Authorization = `Bearer ${token}`;
        expiresInSeconds = provider.secondsUntilExpiry();
      }
      out.push({ name: c.config.name, label: c.config.label ?? c.config.name, url: c.config.url, state: c.state, headers, expiresInSeconds });
    }
    return out;
  }

  logout(name: string): void {
    const c = this.conns.get(name);
    if (!c) return;
    this.providerFor(c)?.clear();
    void this.closeConnection(c).then(() => {
      c.state = c.config.auth.type === "oauth" ? "needs_login" : "disconnected";
      c.tools = [];
      this.emit();
    });
  }

  async reconnect(name: string): Promise<void> {
    await this.connectServer(name);
    this.emit();
  }
}

function oauthScope(cfg: McpServerConfig): string | undefined {
  return cfg.auth.type === "oauth" ? cfg.auth.scope : undefined;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
