import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Small store for secrets the server generates itself (data/secrets.json, mode 0600), so an
 * operator does not have to invent and configure them: today the Chat API key handed to the
 * CRM. An environment variable, when set, always wins over a generated value.
 */
export class SecretsStore {
  private data: Record<string, string> = {};
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "secrets.json");
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as unknown;
        if (raw && typeof raw === "object") {
          for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === "string") this.data[k] = v;
        }
      }
    } catch {
      this.data = {};
    }
  }

  private write(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      /* best effort */
    }
  }

  get(name: string): string | undefined {
    return this.data[name];
  }

  /** Returns the stored secret, generating (and persisting) a random one on first use. */
  getOrCreate(name: string, bytes = 24): string {
    const existing = this.data[name];
    if (existing) return existing;
    return this.rotate(name, bytes);
  }

  rotate(name: string, bytes = 24): string {
    const value = crypto.randomBytes(bytes).toString("hex");
    this.data[name] = value;
    this.write();
    return value;
  }
}
