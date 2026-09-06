import fs from "node:fs";
import { z } from "zod";

const AuthSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({
    type: z.literal("bearer"),
    /** Literal token or `${ENV_VAR}` reference. */
    token: z.string().optional(),
    /** Name of an environment variable holding the token. */
    tokenEnv: z.string().optional(),
  }),
  z.object({ type: z.literal("headers"), headers: z.record(z.string(), z.string()) }),
  z.object({ type: z.literal("oauth"), scope: z.string().optional() }),
]);

export const McpServerSchema = z.object({
  /** Short id used as the tool prefix (`crm__search_contacts`). */
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,19}$/, "name: lowercase letters, digits, _ or -, max 20 chars"),
  label: z.string().optional(),
  description: z.string().optional(),
  url: z.url(),
  transport: z.enum(["auto", "http", "sse"]).default("auto"),
  enabled: z.boolean().default(true),
  auth: AuthSchema.default({ type: "none" }),
  /** Extra headers sent on every request (values may reference `${ENV_VAR}`). */
  headers: z.record(z.string(), z.string()).default({}),
  /** Tools loaded into context on every request (no tool search needed). 3-5 per server is plenty. */
  alwaysLoad: z.array(z.string()).default([]),
  /** Never execute write tools from this server. */
  readOnly: z.boolean().default(false),
  /** Tools from this server that are hidden from the agent entirely. */
  excludeTools: z.array(z.string()).default([]),
});

export const McpConfigSchema = z.object({
  servers: z.array(McpServerSchema).default([]),
});

export type McpServerConfig = z.infer<typeof McpServerSchema>;
export type McpConfig = z.infer<typeof McpConfigSchema>;

/** Replaces `${VAR}` with process.env.VAR (empty string when unset). */
export function interpolateEnv(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name: string) => process.env[name] ?? "");
}

export function loadMcpConfig(file: string): McpConfig {
  if (!fs.existsSync(file)) return { servers: [] };
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  const cfg = McpConfigSchema.parse(raw);
  const names = new Set<string>();
  for (const s of cfg.servers) {
    if (names.has(s.name)) throw new Error(`Duplicate MCP server name "${s.name}" in ${file}`);
    names.add(s.name);
  }
  return cfg;
}

/** Resolves static auth + custom headers into request headers (OAuth is handled by the provider). */
export function staticHeaders(server: McpServerConfig): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(server.headers)) headers[k] = interpolateEnv(v);
  const a = server.auth;
  if (a.type === "bearer") {
    const token = a.tokenEnv ? process.env[a.tokenEnv] ?? "" : interpolateEnv(a.token ?? "");
    if (token) headers.Authorization = `Bearer ${token}`;
  } else if (a.type === "headers") {
    for (const [k, v] of Object.entries(a.headers)) headers[k] = interpolateEnv(v);
  }
  return headers;
}
