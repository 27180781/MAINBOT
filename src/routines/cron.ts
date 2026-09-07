/**
 * Minimal 5-field cron (minute hour day-of-month month day-of-week) evaluated in a
 * time zone, without a dependency. Supports `*`, lists `1,2`, ranges `9-18`, steps
 * `*\/15` and `1-30/5`. Day-of-week: 0 = Sunday ... 6 = Saturday (7 also = Sunday).
 */

export interface CronSpec {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  /** True when both day fields are restricted: then either may match (standard cron semantics). */
  domAndDow: boolean;
  expression: string;
}

function parseField(field: string, min: number, max: number, name: string): { values: Set<number>; wildcard: boolean } {
  const values = new Set<number>();
  let wildcard = false;
  for (const part of field.split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`Invalid cron ${name} field "${field}"`);
    const [, base, stepStr] = m;
    const step = stepStr ? Number(stepStr) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid cron step in "${field}"`);
    let lo: number;
    let hi: number;
    if (base === "*") {
      lo = min;
      hi = max;
      if (!stepStr) wildcard = true;
    } else if (base!.includes("-")) {
      const [a, b] = base!.split("-").map(Number);
      lo = a!;
      hi = b!;
    } else {
      lo = Number(base);
      hi = stepStr ? max : lo;
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`Cron ${name} value out of range in "${field}" (${min}-${max})`);
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return { values, wildcard };
}

export function parseCron(expression: string): CronSpec {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("Cron expression must have 5 fields: minute hour day month weekday");
  const minute = parseField(fields[0]!, 0, 59, "minute");
  const hour = parseField(fields[1]!, 0, 23, "hour");
  const dom = parseField(fields[2]!, 1, 31, "day");
  const month = parseField(fields[3]!, 1, 12, "month");
  const dow = parseField(fields[4]!, 0, 7, "weekday");
  if (dow.values.has(7)) {
    dow.values.delete(7);
    dow.values.add(0);
  }
  return {
    minute: minute.values,
    hour: hour.values,
    dom: dom.values,
    month: month.values,
    dow: dow.values,
    domAndDow: !dom.wildcard && !dow.wildcard,
    expression: expression.trim(),
  };
}

export interface ZonedParts {
  minute: number;
  hour: number;
  dom: number;
  month: number;
  dow: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map<string, Intl.DateTimeFormat>();

export function zonedParts(date: Date, timeZone: string): ZonedParts {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone, hour12: false, minute: "2-digit", hour: "2-digit", day: "2-digit", month: "2-digit", weekday: "short" });
    formatters.set(timeZone, fmt);
  }
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour) % 24,
    dom: Number(parts.day),
    month: Number(parts.month),
    dow: WEEKDAYS[parts.weekday ?? "Sun"] ?? 0,
  };
}

export function cronMatches(spec: CronSpec, date: Date, timeZone: string): boolean {
  const p = zonedParts(date, timeZone);
  if (!spec.minute.has(p.minute) || !spec.hour.has(p.hour) || !spec.month.has(p.month)) return false;
  const domOk = spec.dom.has(p.dom);
  const dowOk = spec.dow.has(p.dow);
  return spec.domAndDow ? domOk || dowOk : domOk && dowOk;
}

const MINUTE = 60_000;

/** Next matching minute strictly after `from` (null when none within ~13 months). */
export function nextCronRun(spec: CronSpec, from: Date, timeZone: string): Date | null {
  let t = new Date(Math.floor(from.getTime() / MINUTE) * MINUTE + MINUTE);
  const limit = t.getTime() + 400 * 24 * 60 * MINUTE;
  let guard = 0;
  while (t.getTime() < limit && guard++ < 200_000) {
    const p = zonedParts(t, timeZone);
    const dayOk = spec.month.has(p.month) && (spec.domAndDow ? spec.dom.has(p.dom) || spec.dow.has(p.dow) : spec.dom.has(p.dom) && spec.dow.has(p.dow));
    if (!dayOk) {
      // jump to (roughly) the next local midnight
      t = new Date(t.getTime() + (24 * 60 - (p.hour * 60 + p.minute)) * MINUTE);
      continue;
    }
    if (!spec.hour.has(p.hour)) {
      t = new Date(t.getTime() + (60 - p.minute) * MINUTE);
      continue;
    }
    if (!spec.minute.has(p.minute)) {
      t = new Date(t.getTime() + MINUTE);
      continue;
    }
    return t;
  }
  return null;
}

/** "HH:MM" -> minutes since midnight, or null when malformed. */
export function parseHHMM(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** True when the local time is inside the quiet window (which may cross midnight). */
export function inQuietHours(date: Date, timeZone: string, from: string, to: string): boolean {
  const a = parseHHMM(from);
  const b = parseHHMM(to);
  if (a === null || b === null || a === b) return false;
  const p = zonedParts(date, timeZone);
  const now = p.hour * 60 + p.minute;
  return a < b ? now >= a && now < b : now >= a || now < b;
}
