import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

interface StoredAuth {
  /** Redirect URI the stored client registration was made with (the CLI and the admin UI differ). */
  redirectUrl?: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  tokensSavedAt?: string;
  codeVerifier?: string;
  state?: string;
  discoveryState?: OAuthDiscoveryState;
  pendingAuthorizationUrl?: string;
  pendingSince?: string;
}

/** How long a started login (state + PKCE verifier) stays valid before the callback is refused. */
export const LOGIN_PENDING_TTL_MS = 15 * 60_000;
/** Tokens saved this recently are kept by invalidateCredentials("tokens"): a parallel refresh already replaced them. */
export const FRESH_TOKENS_MS = 30_000;

/**
 * File-backed OAuth client provider for one remote MCP server. Tokens, the dynamically
 * registered client and the PKCE verifier live in `<authDir>/<server>.json` (mode 0600),
 * so a login survives restarts and the SDK can refresh tokens on its own.
 *
 * Interactive logins go through {@link prepareLogin} -> SDK auth() with {@link loginView} ->
 * callback checked with {@link loginPending} / {@link stateMatches} -> {@link consumePendingLogin},
 * which keeps the state and verifier single-use and never lets a failed login delete the
 * tokens that are still working.
 */
export class FileOAuthProvider implements OAuthClientProvider {
  private data: StoredAuth;
  private readonly file: string;
  public onRedirect?: (url: URL) => void | Promise<void>;

  /**
   * SEP-991 "URL-based client id": an HTTPS URL where this bot publishes its own client
   * metadata document. Authorization servers that advertise
   * `client_id_metadata_document_supported` (Lovable, for example) accept it instead of
   * dynamic client registration, which some of them restrict to localhost redirects.
   */
  public readonly clientMetadataUrl?: string;

  constructor(
    public readonly serverName: string,
    private readonly redirect: string,
    authDir: string,
    private readonly scope?: string,
    clientMetadataUrl?: string,
  ) {
    if (clientMetadataUrl) this.clientMetadataUrl = clientMetadataUrl;
    fs.mkdirSync(authDir, { recursive: true });
    this.file = path.join(authDir, `${serverName}.json`);
    // A client registered by the CLI (localhost redirect) keeps refreshing tokens from the
    // server: refresh does not involve the redirect URI. Re-registration happens only when a
    // new interactive login starts (prepareLogin), never here.
    this.data = this.read();
  }

  private read(): StoredAuth {
    try {
      return fs.existsSync(this.file) ? (JSON.parse(fs.readFileSync(this.file, "utf8")) as StoredAuth) : {};
    } catch {
      return {};
    }
  }

  private write(): void {
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), { encoding: "utf8", mode: 0o600 });
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      /* best effort (Windows, unusual mounts) */
    }
  }

  get redirectUrl(): string {
    return this.redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "MAINBOT Phone Agent",
      redirect_uris: [this.redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(this.scope ? { scope: this.scope } : {}),
    };
  }

  state(): string {
    const s = crypto.randomBytes(16).toString("hex");
    this.data.state = s;
    this.write();
    return s;
  }

  expectedState(): string | undefined {
    return this.data.state;
  }

  /** Constant-time comparison of a callback's `state` with the pending login's state. */
  stateMatches(state: string | undefined): boolean {
    const expected = this.data.state;
    if (!expected || typeof state !== "string" || state.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(state), Buffer.from(expected));
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.data.clientInformation;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.data.clientInformation = info;
    this.data.redirectUrl = this.redirect;
    this.write();
  }

  /** The redirect URI the stored client registration belongs to (undefined when nothing is stored). */
  registeredRedirectUrl(): string | undefined {
    return this.data.redirectUrl;
  }

  tokens(): OAuthTokens | undefined {
    return this.data.tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.data.tokens = tokens;
    this.data.tokensSavedAt = new Date().toISOString();
    delete this.data.pendingAuthorizationUrl;
    this.write();
  }

  hasTokens(): boolean {
    return !!this.data.tokens?.access_token;
  }

  /** Seconds until the stored access token expires (null when unknown or no token). */
  secondsUntilExpiry(): number | null {
    const t = this.data.tokens;
    if (!t?.access_token) return null;
    if (!t.expires_in || !this.data.tokensSavedAt) return null;
    const savedAt = Date.parse(this.data.tokensSavedAt);
    if (!Number.isFinite(savedAt)) return null;
    return Math.round((savedAt + Number(t.expires_in) * 1000 - Date.now()) / 1000);
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this.data.pendingAuthorizationUrl = authorizationUrl.toString();
    this.data.pendingSince = new Date().toISOString();
    this.write();
    if (this.onRedirect) await this.onRedirect(authorizationUrl);
  }

  pendingAuthorizationUrl(): string | undefined {
    return this.data.pendingAuthorizationUrl;
  }

  /** True while a login started from this provider is waiting for its callback (and has not expired). */
  loginPending(): boolean {
    if (!this.data.state || !this.data.codeVerifier || !this.data.pendingAuthorizationUrl) return false;
    const since = Date.parse(this.data.pendingSince ?? "");
    return Number.isFinite(since) && Date.now() - since < LOGIN_PENDING_TTL_MS;
  }

  /**
   * Starts a new interactive login: clears any stale pending state and drops a client that
   * was registered for a different redirect URI (the SDK registers a fresh one). Tokens are
   * kept, so the server keeps working until the new login succeeds.
   */
  prepareLogin(): void {
    delete this.data.state;
    delete this.data.codeVerifier;
    delete this.data.pendingAuthorizationUrl;
    delete this.data.pendingSince;
    if (this.data.redirectUrl && this.data.redirectUrl !== this.redirect) delete this.data.clientInformation;
    this.data.redirectUrl = this.redirect;
    this.write();
  }

  /** Makes the state and PKCE verifier single-use: called once a callback was processed, success or not. */
  consumePendingLogin(): void {
    delete this.data.state;
    delete this.data.codeVerifier;
    delete this.data.pendingAuthorizationUrl;
    delete this.data.pendingSince;
    this.write();
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.data.codeVerifier = codeVerifier;
    this.write();
  }

  codeVerifier(): string {
    if (!this.data.codeVerifier) throw new Error(`No PKCE code verifier stored for MCP server "${this.serverName}" - start the login again`);
    return this.data.codeVerifier;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all" || scope === "client") delete this.data.clientInformation;
    if (scope === "all" || scope === "tokens") {
      // Two refreshes can race (a tool call's 401 handler and the shared-credentials refresh).
      // With refresh-token rotation the loser gets invalid_grant; it must not delete the
      // winner's fresh tokens, so very recent tokens survive.
      const savedAt = Date.parse(this.data.tokensSavedAt ?? "");
      if (!(Number.isFinite(savedAt) && Date.now() - savedAt < FRESH_TOKENS_MS)) delete this.data.tokens;
    }
    if (scope === "all" || scope === "verifier") delete this.data.codeVerifier;
    if (scope === "all" || scope === "discovery") delete this.data.discoveryState;
    this.write();
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.data.discoveryState = state;
    this.write();
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.data.discoveryState;
  }

  /** Removes everything (logout). */
  clear(): void {
    this.data = {};
    this.write();
  }

  /**
   * The provider as seen by an interactive login (start + code exchange): the SDK's auth()
   * finds no tokens, so it starts the authorization redirect instead of refreshing, and a
   * failed exchange cannot delete the tokens that still work. Client registration, PKCE
   * state and discovery are shared with the real provider.
   */
  loginView(): OAuthClientProvider {
    const self = this;
    return {
      get redirectUrl() {
        return self.redirectUrl;
      },
      get clientMetadata() {
        return self.clientMetadata;
      },
      get clientMetadataUrl() {
        return self.clientMetadataUrl;
      },
      state: () => self.state(),
      clientInformation: () => self.clientInformation(),
      saveClientInformation: (info) => self.saveClientInformation(info),
      tokens: () => undefined,
      saveTokens: (tokens) => self.saveTokens(tokens),
      redirectToAuthorization: (url) => self.redirectToAuthorization(url),
      saveCodeVerifier: (v) => self.saveCodeVerifier(v),
      codeVerifier: () => self.codeVerifier(),
      invalidateCredentials: (scope) => {
        if (scope === "tokens") return;
        if (scope === "all") {
          self.invalidateCredentials("client");
          self.invalidateCredentials("verifier");
          self.invalidateCredentials("discovery");
        } else self.invalidateCredentials(scope);
      },
      saveDiscoveryState: (state) => self.saveDiscoveryState(state),
      discoveryState: () => self.discoveryState(),
    };
  }
}
