import fs from "node:fs";
import path from "node:path";

export interface Rule {
  id: number;
  text: string;
  createdAt: string;
  updatedAt: string;
  /** Who wrote the rule: the caller by phone, the admin UI, or a file import. */
  source: string;
}

interface RulesFile {
  nextId: number;
  rules: Rule[];
}

export const MAX_RULES = 200;
export const MAX_RULE_CHARS = 600;

/**
 * The bot's "standing skill": rules the owner dictates ("from now on, always ...")
 * that are persisted to disk and injected into the cached system prompt, so they
 * cost almost nothing per call and survive restarts. Edited by the phone tools
 * (add_rule / update_rule / remove_rule) and by the admin UI.
 */
export class RulesStore {
  private data: RulesFile;
  private readonly file: string;
  private listeners: Array<() => void> = [];

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "rules.json");
    this.data = this.read();
  }

  private read(): RulesFile {
    try {
      if (fs.existsSync(this.file)) {
        const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<RulesFile>;
        const rules = Array.isArray(parsed.rules) ? parsed.rules.filter((r) => r && typeof r.text === "string" && typeof r.id === "number") : [];
        const maxId = rules.reduce((m, r) => Math.max(m, r.id), 0);
        return { nextId: Math.max(Number(parsed.nextId) || 1, maxId + 1), rules };
      }
    } catch {
      /* corrupt file: start empty but do not overwrite until the next write */
    }
    return { nextId: 1, rules: [] };
  }

  private write(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
    fs.renameSync(tmp, this.file);
    for (const fn of this.listeners) fn();
  }

  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  list(): Rule[] {
    return this.data.rules.map((r) => ({ ...r }));
  }

  get(id: number): Rule | undefined {
    return this.data.rules.find((r) => r.id === id);
  }

  add(text: string, source: string): Rule {
    const clean = normalizeRuleText(text);
    if (!clean) throw new Error("Rule text is empty");
    if (this.data.rules.length >= MAX_RULES) throw new Error(`Rule limit reached (${MAX_RULES}). Remove or merge rules first.`);
    const dup = this.data.rules.find((r) => r.text === clean);
    if (dup) return dup;
    const now = new Date().toISOString();
    const rule: Rule = { id: this.data.nextId++, text: clean, createdAt: now, updatedAt: now, source };
    this.data.rules.push(rule);
    this.write();
    return rule;
  }

  update(id: number, text: string, source: string): Rule {
    const rule = this.data.rules.find((r) => r.id === id);
    if (!rule) throw new Error(`Rule ${id} does not exist`);
    const clean = normalizeRuleText(text);
    if (!clean) throw new Error("Rule text is empty");
    rule.text = clean;
    rule.updatedAt = new Date().toISOString();
    rule.source = source;
    this.write();
    return { ...rule };
  }

  remove(id: number): Rule {
    const idx = this.data.rules.findIndex((r) => r.id === id);
    if (idx < 0) throw new Error(`Rule ${id} does not exist`);
    const [removed] = this.data.rules.splice(idx, 1);
    this.write();
    return removed!;
  }

  /** Replaces every rule (admin UI bulk edit). */
  replaceAll(texts: string[], source: string): Rule[] {
    const now = new Date().toISOString();
    const existing = new Map(this.data.rules.map((r) => [r.text, r]));
    const rules: Rule[] = [];
    for (const raw of texts) {
      const clean = normalizeRuleText(raw);
      if (!clean || rules.some((r) => r.text === clean)) continue;
      const old = existing.get(clean);
      rules.push(old ? { ...old } : { id: this.data.nextId++, text: clean, createdAt: now, updatedAt: now, source });
    }
    this.data.rules = rules.slice(0, MAX_RULES);
    this.write();
    return this.list();
  }

  /** Numbered list for the system prompt (empty string when there are no rules). */
  renderForPrompt(): string {
    if (this.data.rules.length === 0) return "";
    return this.data.rules.map((r) => `${r.id}. ${r.text}`).join("\n");
  }

  /** Numbered list for reading back to the caller / returning from list_rules. */
  renderForTool(): string {
    if (this.data.rules.length === 0) return "אין עדיין כללים קבועים.";
    return this.data.rules.map((r) => `כלל ${r.id}: ${r.text}`).join("\n");
  }
}

export function normalizeRuleText(text: string): string {
  return (text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_RULE_CHARS);
}
