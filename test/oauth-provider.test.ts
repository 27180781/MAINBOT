import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileOAuthProvider, FRESH_TOKENS_MS, LOGIN_PENDING_TTL_MS } from "../src/mcp/oauth-provider.js";

const SERVER = "https://bot.example.com/oauth/callback/crm";
const CLI = "http://localhost:8765/callback";
const TOKENS = { access_token: "at-1", refresh_token: "rt-1", token_type: "bearer", expires_in: 3600 };

describe("FileOAuthProvider", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mainbot-oauth-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  const file = () => path.join(dir, "crm.json");

  it("keeps a client registered by the CLI so the server can go on refreshing its tokens", () => {
    const cli = new FileOAuthProvider("crm", CLI, dir);
    cli.saveClientInformation({ client_id: "cli-client" });
    cli.saveTokens(TOKENS);
    const server = new FileOAuthProvider("crm", SERVER, dir);
    expect(server.clientInformation()).toEqual({ client_id: "cli-client" });
    expect(server.tokens()).toEqual(TOKENS);
    expect(server.registeredRedirectUrl()).toBe(CLI);
    expect(server.redirectUrl).toBe(SERVER);
    // A new interactive login from the server re-registers for its own redirect, tokens intact.
    server.prepareLogin();
    expect(server.clientInformation()).toBeUndefined();
    expect(server.tokens()).toEqual(TOKENS);
    expect(server.registeredRedirectUrl()).toBe(SERVER);
    server.saveClientInformation({ client_id: "server-client" });
    expect(new FileOAuthProvider("crm", SERVER, dir).clientInformation()).toEqual({ client_id: "server-client" });
  });

  it("tracks a pending login with a single-use state and PKCE verifier", async () => {
    const p = new FileOAuthProvider("crm", SERVER, dir);
    expect(p.loginPending()).toBe(false);
    p.prepareLogin();
    const state = p.state();
    p.saveCodeVerifier("verifier");
    expect(p.loginPending()).toBe(false); // no redirect yet
    await p.redirectToAuthorization(new URL("https://as.example.com/authorize?state=" + state));
    expect(p.loginPending()).toBe(true);
    expect(p.stateMatches(state)).toBe(true);
    expect(p.stateMatches(undefined)).toBe(false);
    expect(p.stateMatches("")).toBe(false);
    expect(p.stateMatches(state.slice(0, -1) + "x")).toBe(false);
    expect(new FileOAuthProvider("crm", SERVER, dir).loginPending()).toBe(true); // persisted
    p.consumePendingLogin();
    expect(p.loginPending()).toBe(false);
    expect(p.stateMatches(state)).toBe(false);
    expect(() => p.codeVerifier()).toThrow(/start the login again/);
  });

  it("expires a pending login after the TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T08:00:00Z"));
    const p = new FileOAuthProvider("crm", SERVER, dir);
    p.state();
    p.saveCodeVerifier("v");
    await p.redirectToAuthorization(new URL("https://as.example.com/authorize"));
    expect(p.loginPending()).toBe(true);
    vi.setSystemTime(new Date(Date.now() + LOGIN_PENDING_TTL_MS + 1000));
    expect(p.loginPending()).toBe(false);
  });

  it("does not delete tokens that a parallel refresh just saved", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T08:00:00Z"));
    const p = new FileOAuthProvider("crm", SERVER, dir);
    p.saveTokens(TOKENS);
    p.invalidateCredentials("tokens"); // fresh: kept
    expect(p.tokens()).toEqual(TOKENS);
    vi.setSystemTime(new Date(Date.now() + FRESH_TOKENS_MS + 1000));
    p.invalidateCredentials("tokens"); // stale: deleted
    expect(p.tokens()).toBeUndefined();
  });

  it("loginView hides the tokens from the SDK and never deletes them", () => {
    const p = new FileOAuthProvider("crm", SERVER, dir, "read", "https://bot.example.com/oauth/client-metadata.json");
    p.saveTokens(TOKENS);
    p.saveClientInformation({ client_id: "c" });
    p.saveDiscoveryState({ authorizationServerUrl: "https://as.example.com" });
    const view = p.loginView();
    expect(view.tokens()).toBeUndefined();
    expect(view.redirectUrl).toBe(SERVER);
    expect(view.clientMetadataUrl).toBe("https://bot.example.com/oauth/client-metadata.json");
    expect(view.clientMetadata.redirect_uris).toEqual([SERVER]);
    expect(view.clientInformation()).toEqual({ client_id: "c" });
    view.invalidateCredentials?.("tokens");
    expect(p.tokens()).toEqual(TOKENS);
    view.invalidateCredentials?.("all");
    expect(p.tokens()).toEqual(TOKENS);
    expect(p.clientInformation()).toBeUndefined();
    expect(p.discoveryState()).toBeUndefined();
    view.saveTokens({ ...TOKENS, access_token: "at-2" });
    expect(p.tokens()?.access_token).toBe("at-2");
  });

  it("stores the file with owner-only permissions and clears everything on logout", () => {
    const p = new FileOAuthProvider("crm", SERVER, dir);
    p.saveTokens(TOKENS);
    if (process.platform !== "win32") expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
    p.clear();
    expect(p.hasTokens()).toBe(false);
    expect(JSON.parse(fs.readFileSync(file(), "utf8"))).toEqual({});
  });
});
