/**
 * Shared plumbing for the AI-usage tooling.
 *
 * Three scripts read this: `ask-gemini` (which writes the Gemini ledger),
 * `get-gemini-usage` and `get-claude-usage` (which read the two sources). It
 * lives here rather than being copied three times because the one thing that
 * must not drift between them is what a "day" is and how a token is counted —
 * two scripts disagreeing about that produce two dashboards that disagree, and
 * neither is obviously wrong.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOME = homedir();
export const USAGE_DIR = join(HOME, ".claude", "ai-usage");
export const GEMINI_LEDGER = join(USAGE_DIR, "gemini.jsonl");
export const COPILOT_LEDGER = join(USAGE_DIR, "copilot.jsonl");
export const RATES_FILE = join(USAGE_DIR, "rates.json");
export const CLAUDE_PROJECTS = join(HOME, ".claude", "projects");

export function ensureUsageDir() {
  if (!existsSync(USAGE_DIR)) mkdirSync(USAGE_DIR, { recursive: true });
}

/**
 * The local calendar day of an ISO timestamp.
 *
 * Local, deliberately, not UTC. These numbers are read by the person who spent
 * them, against a memory of what they were doing that afternoon — and in this
 * timezone a UTC day boundary falls mid-afternoon, so a UTC bucket splits one
 * working session across two rows and reports neither correctly.
 */
export function localDay(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Every file under `dir` matching `ext`, recursively. Missing dir → []. */
export function walk(dir, ext) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full, ext));
    else if (entry.name.endsWith(ext)) found.push(full);
  }
  return found;
}

/**
 * Rates, if the operator has supplied them.
 *
 * Deliberately NOT shipped with defaults. A hard-coded price table is wrong the
 * week after it is written and gives no sign of it — the dashboard keeps
 * reporting a confident dollar figure computed from last year's rates. Tokens
 * are measured; money is quoted only from a file somebody chose to write, and
 * is labelled an estimate wherever it appears.
 *
 * Shape, USD per MILLION tokens:
 *   { "asOf": "2026-08-17",
 *     "claude": { "claude-opus-5": { "input": 5, "output": 25,
 *                                    "cacheWrite": 6.25, "cacheRead": 0.5 } },
 *     "gemini": { "gemini-2.5-pro": { "input": 1.25, "output": 10 } } }
 */
export function loadRates() {
  if (!existsSync(RATES_FILE)) return null;
  try {
    return JSON.parse(readFileSync(RATES_FILE, "utf8"));
  } catch (err) {
    process.stderr.write(`warning: ${RATES_FILE} is not valid JSON (${err.message}); costs omitted\n`);
    return null;
  }
}

/** Cost in USD for one usage record, or null when no rate covers that model. */
export function costOf(rates, vendor, model, usage) {
  const table = rates?.[vendor];
  if (!table) return null;
  // Exact match first, then longest declared prefix — so a rates file can name
  // `claude-opus-5` once and still price `claude-opus-5[1m]` and dated variants,
  // without listing every id that will ever exist.
  const key =
    table[model] !== undefined
      ? model
      : Object.keys(table)
          .filter((k) => model.startsWith(k))
          .sort((a, b) => b.length - a.length)[0];
  if (!key) return null;
  const r = table[key];
  const per = (tokens, rate) => ((tokens ?? 0) / 1_000_000) * (rate ?? 0);
  return (
    per(usage.input, r.input) +
    per(usage.output, r.output) +
    per(usage.cacheWrite, r.cacheWrite ?? r.input) +
    per(usage.cacheRead, r.cacheRead ?? r.input)
  );
}

export function emptyUsage() {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, calls: 0 };
}

export function addUsage(into, from) {
  into.input += from.input ?? 0;
  into.output += from.output ?? 0;
  into.cacheWrite += from.cacheWrite ?? 0;
  into.cacheRead += from.cacheRead ?? 0;
  into.calls += from.calls ?? 0;
  return into;
}

/** Every token that was paid for, however it was billed. */
export function totalTokens(u) {
  return (u.input ?? 0) + (u.output ?? 0) + (u.cacheWrite ?? 0) + (u.cacheRead ?? 0);
}

export function appendLedger(file, record) {
  ensureUsageDir();
  appendFileSync(file, JSON.stringify(record) + "\n", "utf8");
}

/** Read a JSONL ledger, skipping malformed lines rather than dying on one. */
export function readLedger(file) {
  if (!existsSync(file)) return [];
  const rows = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      rows.push(JSON.parse(t));
    } catch {
      // A half-written final line is normal if a process died mid-append.
      // Losing one record is better than reporting nothing.
    }
  }
  return rows;
}

// ── Formatting ────────────────────────────────────────────────────────────

export function fmtInt(n) {
  return Math.round(n).toLocaleString("en-US");
}

export function fmtUsd(n) {
  if (n === null || n === undefined) return "—";
  return n < 0.01 && n > 0 ? "<$0.01" : `$${n.toFixed(2)}`;
}

/** Fixed-width table. Numeric columns right-aligned so digits line up. */
export function table(headers, rows, align = []) {
  const all = [headers, ...rows];
  const widths = headers.map((_, i) =>
    Math.max(...all.map((r) => String(r[i] ?? "").length)),
  );
  const line = (r) =>
    r
      .map((cell, i) =>
        align[i] === "r"
          ? String(cell ?? "").padStart(widths[i])
          : String(cell ?? "").padEnd(widths[i]),
      )
      .join("  ")
      .trimEnd();
  return [line(headers), widths.map((w) => "─".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}

/** `--since 7d`, `--since 2026-08-01`, `--since all`. Returns a YYYY-MM-DD floor. */
export function parseSince(value) {
  if (!value || value === "all") return null;
  const days = /^(\d+)d$/.exec(value);
  if (days) {
    const d = new Date();
    d.setDate(d.getDate() - Number(days[1]) + 1);
    return localDay(d.toISOString());
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  throw new Error(`--since expects Nd, YYYY-MM-DD, or all — got "${value}"`);
}
