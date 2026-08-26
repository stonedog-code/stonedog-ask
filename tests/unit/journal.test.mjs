/**
 * Unit tier — the day journal.
 *
 * The carry-forward is the whole reason the brief/wrap pair exists: nothing in
 * an inbox says "you have been ignoring me for four days", so that fact lives
 * only in the gap between two entries. A regression here does not crash — it
 * produces a brief that looks like a quiet day, which is the single most
 * dangerous thing this tool can do.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { freshImport } from "../support/sandbox.mjs";

/** `journal.mjs` reads ASK_JOURNAL_DIR at module scope, so set it then import. */
async function withJournal(fn) {
  const dir = join(mkdtempSync(join(tmpdir(), "ask-journal-")), "journal");
  const saved = process.env.ASK_JOURNAL_DIR;
  process.env.ASK_JOURNAL_DIR = dir;
  try {
    return await fn(await freshImport("journal.mjs"), dir);
  } finally {
    if (saved === undefined) delete process.env.ASK_JOURNAL_DIR;
    else process.env.ASK_JOURNAL_DIR = saved;
  }
}

describe("today", () => {
  test("is the LOCAL calendar day", async () => {
    /* Local, not UTC, deliberately: a UTC boundary falls mid-afternoon in some
       timezones and would split one working day across two files. */
    const { today } = await freshImport("journal.mjs");
    const d = new Date(2026, 0, 5, 23, 30);
    assert.equal(today(d), "2026-01-05");
  });

  test("pads a single-digit month and day", async () => {
    const { today } = await freshImport("journal.mjs");
    assert.equal(today(new Date(2026, 8, 9, 12)), "2026-09-09");
  });
});

describe("openItemsOf", () => {
  test("returns the OPEN ITEMS section and everything after it", async () => {
    const { openItemsOf } = await freshImport("journal.mjs");
    const entry = "# Start of day\n\n## Due\nnothing\n\n## OPEN ITEMS\n\n- [2026-01-02] a thing — first seen 2026-01-01\n";
    const got = openItemsOf(entry);
    assert.match(got, /^## OPEN ITEMS/);
    assert.match(got, /first seen 2026-01-01/);
    assert.equal(got.includes("## Due"), false, "content above the marker was carried forward too");
  });

  test("matches the heading at any level and in any case", async () => {
    const { openItemsOf } = await freshImport("journal.mjs");
    for (const heading of ["# Open Items", "### open items", "###### OPEN ITEMS today"]) {
      assert.match(openItemsOf(`before\n${heading}\n- x\n`), /^#+ /i, heading);
      assert.equal(openItemsOf(`before\n${heading}\n- x\n`).includes("before"), false, heading);
    }
  });

  test("with NO marker it returns the whole entry rather than nothing", async () => {
    /* The deliberate degradation. Returning empty would hand the next brief no
       carryover at all — indistinguishable from a day with nothing open, which
       is the exact failure this module exists to prevent. Too much context
       costs tokens; none costs a deadline. */
    const { openItemsOf } = await freshImport("journal.mjs");
    const entry = "# Start of day\n\nno marker anywhere here\n";
    assert.equal(openItemsOf(entry), entry.trim());
  });

  test("a mid-line mention is not mistaken for the heading", async () => {
    const { openItemsOf } = await freshImport("journal.mjs");
    const entry = "we should discuss ## OPEN ITEMS at standup\n";
    assert.equal(openItemsOf(entry), entry.trim());
  });
});

describe("writeEntry", () => {
  test("writes the entry and locks the permissions down", async () => {
    /* These files hold whatever was in the mail this morning. World-readable,
       silently, from the first run onwards is not an acceptable default. */
    await withJournal(async ({ writeEntry }, dir) => {
      const path = writeEntry("2026-01-05", "brief", "body text");
      assert.equal(readFileSync(path, "utf8").includes("body text"), true);
      assert.equal(statSync(dir).mode & 0o777, 0o700, "journal directory is not 0700");
      assert.equal(statSync(path).mode & 0o777, 0o600, "journal entry is not 0600");
    });
  });

  test("tightens an EXISTING loose directory, not only one it created", async () => {
    /* `mkdirSync`'s mode applies only when the directory is actually created,
       and is masked by umask even then — so every run after the first would
       skip it. */
    await withJournal(async ({ writeEntry }, dir) => {
      mkdirSync(dir, { recursive: true, mode: 0o755 });
      const { chmodSync } = await import("node:fs");
      chmodSync(dir, 0o755);
      writeEntry("2026-01-05", "brief", "body");
      assert.equal(statSync(dir).mode & 0o777, 0o700);
    });
  });

  test("appends rather than replacing, so a wrap cannot erase the morning", async () => {
    await withJournal(async ({ writeEntry, entryFor }) => {
      writeEntry("2026-01-05", "brief", "the morning");
      writeEntry("2026-01-05", "wrap", "the evening");
      const text = entryFor("2026-01-05");
      assert.match(text, /the morning/);
      assert.match(text, /the evening/);
      assert.ok(text.indexOf("the morning") < text.indexOf("the evening"));
    });
  });

  test("labels a brief and a wrap differently", async () => {
    await withJournal(async ({ writeEntry, entryFor }) => {
      writeEntry("2026-01-05", "brief", "b");
      writeEntry("2026-01-05", "wrap", "w");
      const text = entryFor("2026-01-05");
      assert.match(text, /# Start of day — 2026-01-05/);
      assert.match(text, /# End of day — 2026-01-05/);
    });
  });
});

describe("recentEntries", () => {
  test("returns earlier days newest first, bounded", async () => {
    await withJournal(async ({ recentEntries }, dir) => {
      mkdirSync(dir, { recursive: true });
      for (const day of ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"]) {
        writeFileSync(join(dir, `${day}.md`), `entry for ${day}`, "utf8");
      }
      const got = recentEntries("2026-01-05", 2);
      assert.deepEqual(got.map((e) => e.day), ["2026-01-04", "2026-01-03"]);
    });
  });

  test("reads what is ON DISK rather than assuming yesterday exists", async () => {
    /* A laptop shut on Friday has no weekend entry, and a brief that asked for
       "yesterday" by date arithmetic would find nothing on Monday — the exact
       morning the carryover matters most. */
    await withJournal(async ({ recentEntries }, dir) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "2026-01-02.md"), "friday", "utf8"); // Friday
      const got = recentEntries("2026-01-05", 3); // Monday
      assert.deepEqual(got.map((e) => e.day), ["2026-01-02"]);
    });
  });

  test("excludes today and anything later", async () => {
    await withJournal(async ({ recentEntries }, dir) => {
      mkdirSync(dir, { recursive: true });
      for (const day of ["2026-01-04", "2026-01-05", "2026-01-06"]) {
        writeFileSync(join(dir, `${day}.md`), day, "utf8");
      }
      assert.deepEqual(recentEntries("2026-01-05", 5).map((e) => e.day), ["2026-01-04"]);
    });
  });

  test("ignores files that are not dated entries", async () => {
    await withJournal(async ({ recentEntries }, dir) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "cron.log"), "noise", "utf8");
      writeFileSync(join(dir, "notes.md"), "noise", "utf8");
      writeFileSync(join(dir, "2026-01-04.md"), "real", "utf8");
      assert.deepEqual(recentEntries("2026-01-05", 5).map((e) => e.day), ["2026-01-04"]);
    });
  });

  test("a missing journal directory is empty, not an exception", async () => {
    await withJournal(async ({ recentEntries }) => {
      assert.deepEqual(recentEntries("2026-01-05"), []);
    });
  });
});
