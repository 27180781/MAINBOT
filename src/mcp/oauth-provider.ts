import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

interface StoredAuth {
  redirectUrl?: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  tokensSavedAt?: string;
  codeVerifier?: string;
  state?: string;
  discoveryState?: OAuthDiscoveryState;
  pendingAuthorizationUrl?: string;
}

/**
 * File-backed OAuth client provider for one remote MCP server. Tokens, the dynamically
 * registered client and the PKCE verifier live in `<authDir>/<server>.json` (mode 0600),
 * so a login survives restarts and the SDK can refresh tokens on its own.
 */
export class FileOAuthProvider implements OAuthClientProvider {
  private data: StoredAuth;
  private readonly file: string;
  public onRedirect?: (url: URL) => void | Promise<void>;

  constructor(
    public readonly serverName: string,
    private readonly redirect: string,
    authDir: string,
    private readonly scope?: string,
  ) {
    fs.mkdirSync(authDir, { recursive: true });
    this.file = path.join(authDir, `${serverName}.json`);
    this.data = this.read();
    // A client registered for a different redirect URI (CLI vs. admin UI) must be re-registered.
    if (this.data.redirectUrl && this.data.redirectUrl !== redirect) {
      delete this.data.clientInformation;
      delete this.data.codeVerifier;
      delete this.data.state;
    }
    this.data.redirectUrl = redirect;
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

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.data.clientInformation;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.data.clientInformation = info;
    this.write();
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

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this.data.pendingAuthorizationUrl = authorizationUrl.toString();
    this.write();
    if (this.onRedirect) await this.onRedirect(authorizationUrl);
  }

  pendingAuthorizationUrl(): string | undefined {
    return this.data.pendingAuthorizationUrl;
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
    if (scope === "all" || scope === "tokens") delete this.data.tokens;
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
    this.data = { redirectUrl: this.redirect };
    this.write();
  }
}
