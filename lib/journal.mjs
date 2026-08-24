/**
 * The day journal — what makes two cron runs a continuous record rather than
 * two unrelated summaries.
 *
 * The morning brief and the evening wrap are the same job seen from both ends.
 * A wrap that only describes today, and a brief that only reads today's inbox,
 * between them lose the one thing the pair exists to capture: an item that was
 * open yesterday, is still open, and has a date on it. Nothing in an inbox says
 * "you have been ignoring me for four days" — that fact lives only in the gap
 * between two summaries, so something has to hold it.
 *
 * So each run appends a dated entry here, and each run is given the recent
 * entries as context. Deadlines survive because they are re-stated every day
 * until they are closed out, not because a parser understood them.
 *
 * Plain Markdown files, one per day, deliberately. This has to be readable and
 * fixable by hand at 7am when a cron job has written something wrong, and it
 * has to survive this tool being rewritten. A database would be better at
 * everything except the two things that actually matter here.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const JOURNAL_DIR =
  process.env.ASK_JOURNAL_DIR || join(homedir(), ".stonedog-ask", "journal");

/** Local calendar day, not UTC — a UTC boundary falls mid-afternoon here and
 *  would split one working day across two files. */
export function today(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const entryPath = (day) => join(JOURNAL_DIR, `${day}.md`);

/**
 * The marker the prompts ask the model to emit, and the only structure this
 * module knows about.
 *
 * One heading, matched case-insensitively at the start of a line. Anything more
 * elaborate is a parser that will silently return nothing the first time the
 * model reformats its answer — and a carryover that silently returns nothing is
 * exactly the failure this whole file exists to prevent, reported as success.
 */
const OPEN_ITEMS = /^#{1,6}\s*open items\b.*$/im;

/**
 * The trailing OPEN ITEMS section of an entry, or the whole entry if it has
 * none.
 *
 * Degrading to the whole entry is the deliberate choice. The alternative —
 * returning empty when the marker is missing — hands the next brief no
 * carryover at all and looks identical to a day with nothing open. Feeding it
 * too much context costs tokens; feeding it none costs a deadline.
 */
export function openItemsOf(text) {
  const m = OPEN_ITEMS.exec(text);
  return m ? text.slice(m.index).trim() : text.trim();
}

/**
 * Tighten the directory to 0700 on EVERY write, not only on the one that
 * created it.
 *
 * `mkdirSync`'s `mode` applies only when the directory is actually created, and
 * it is masked by umask even then — so a default 022 umask yields 0755 on the
 * first run, and every run after that skips the mkdir entirely and never
 * revisits it. These files hold whatever was in the mail this morning, so
 * "world-readable, silently, from the first run onwards" is not an acceptable
 * default on a shared or work machine.
 */
function ensureDir() {
  if (!existsSync(JOURNAL_DIR)) mkdirSync(JOURNAL_DIR, { recursive: true, mode: 0o700 });
  try {
    chmodSync(JOURNAL_DIR, 0o700);
  } catch {
    // A directory somebody else owns is their business — the 0600 on each file
    // below is the protection that actually matters, and it is applied per write.
  }
}

export function writeEntry(day, kind, body) {
  ensureDir();
  const stamp = new Date().toISOString();
  appendFileSync(
    entryPath(day),
    `\n<!-- ${kind} ${stamp} -->\n\n# ${kind === "wrap" ? "End of day" : "Start of day"} — ${day}\n\n${body.trim()}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return entryPath(day);
}

/**
 * The `n` most recent entries before `day`, newest first.
 *
 * Bounded, and it reads back what is on disk rather than assuming yesterday
 * exists — a laptop that was shut on Friday has no Saturday or Sunday entry,
 * and a brief that asked for "yesterday" by date arithmetic would find nothing
 * on a Monday morning. That is the exact morning the carryover matters most.
 */
export function recentEntries(day, n = 3) {
  if (!existsSync(JOURNAL_DIR)) return [];
  return readdirSync(JOURNAL_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f) && f.slice(0, 10) < day)
    .sort()
    .reverse()
    .slice(0, n)
    .map((f) => ({ day: f.slice(0, 10), text: readFileSync(join(JOURNAL_DIR, f), "utf8") }));
}

/** Today's entries so far — so an evening wrap can see the morning's brief. */
export function entryFor(day) {
  const p = entryPath(day);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}
