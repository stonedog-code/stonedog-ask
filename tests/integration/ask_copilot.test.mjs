/**
 * Integration tier — `ask-copilot` as a real subprocess.
 *
 * The two modes worth the most here are `--cron` and `--sources`, because both
 * fail SILENTLY in production. A wrong interpreter path in a crontab dies at
 * 06:45 into a log nobody reads; a brief with a source that was never reachable
 * looks exactly like a quiet day. Neither produces an error anyone sees.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { describe, test } from "node:test";

import { fakeBin, recordingBin, run, sandbox } from "../support/sandbox.mjs";

function mcpConfig(box, servers) {
  const dir = join(box.home, ".copilot");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "mcp-config.json");
  writeFileSync(path, JSON.stringify({ mcpServers: servers }), "utf8");
  return path;
}

// --- --cron ----------------------------------------------------------------

describe("ask-copilot --cron", () => {
  test("emits an ABSOLUTE interpreter directory, not a bare `node`", async () => {
    /* THE failure this mode exists to prevent. A scheduler's PATH is not your
       shell's PATH: under nvm, `node` lives in a versioned directory that only
       a profile adds, and neither cron nor launchd sources a profile. */
    const box = sandbox();
    const r = run(box, "ask-copilot", ["--cron", "linux"]);

    assert.equal(r.code, 0, r.all);
    const path = /^PATH=(.+)$/m.exec(r.stdout);
    assert.ok(path, "no PATH line was emitted");
    const first = path[1].split(":")[0];
    assert.ok(isAbsolute(first), `PATH starts with a relative entry: ${first}`);
    assert.equal(existsSync(join(first, "node")), true, "the emitted directory holds no `node`");
  });

  test("silences cron's mail, so the job does not write to the user twice a day", async () => {
    const box = sandbox();
    const r = run(box, "ask-copilot", ["--cron", "linux"]);
    assert.match(r.stdout, /^MAILTO=""$/m);
  });

  test("schedules both runs, and sends their output to a log", async () => {
    const box = sandbox();
    const r = run(box, "ask-copilot", ["--cron", "linux"]);
    assert.match(r.stdout, /--brief/);
    assert.match(r.stdout, /--wrap/);
    assert.match(r.stdout, /cron\.log/);
  });

  test("the systemd form runs a job missed while the machine was off", async () => {
    /* `Persistent=true` is the reason to prefer a timer on a laptop: cron
       simply skips a job whose time passed while the machine was shut. */
    const box = sandbox();
    const r = run(box, "ask-copilot", ["--cron", "systemd"]);
    assert.equal(r.code, 0, r.all);
    assert.match(r.stdout, /Persistent=true/);
    assert.match(r.stdout, /enable-linger/, "the timers-stop-at-logout trap is not mentioned");
  });

  test("the launchd form spells Mon-Fri out, because launchd has no weekday range", async () => {
    /* A single dict with a range quietly runs on Mondays only. Five entries is
       not redundancy, it is the API. */
    const box = sandbox();
    const r = run(box, "ask-copilot", ["--cron", "macos"]);
    assert.equal(r.code, 0, r.all);
    const weekdays = r.stdout.match(/<key>Weekday<\/key>/g) ?? [];
    assert.ok(
      weekdays.length >= 10,
      `expected five weekday entries per job across two jobs, found ${weekdays.length}`,
    );
    assert.match(r.stdout, /StartCalendarInterval/);
  });

  test("an unknown platform is refused rather than silently defaulted", async () => {
    const box = sandbox();
    const r = run(box, "ask-copilot", ["--cron", "solaris"]);
    assert.notEqual(r.code, 0, "an unknown platform produced a schedule anyway");
  });
});

// --- --sources -------------------------------------------------------------

describe("ask-copilot --sources", () => {
  test("lists what is configured", async () => {
    const box = sandbox();
    mcpConfig(box, { mail: { command: "x" }, sharepoint: { command: "y" } });
    const r = run(box, "ask-copilot", ["--sources"]);
    assert.match(r.all, /mail/);
    assert.match(r.all, /sharepoint/);
  });

  test("says so plainly when nothing is configured", async () => {
    /* Not an empty list. "No sources" and "the sources are fine" must not look
       the same, because a brief with no sources is a brief about nothing. */
    const box = sandbox();
    mcpConfig(box, {});
    const r = run(box, "ask-copilot", ["--sources"]);
    assert.match(r.all, /no|none/i);
    assert.equal(/mail/.test(r.all), false);
  });
});

// --- refusing to run without a source --------------------------------------

describe("a required source that is missing", () => {
  test("stops the run instead of producing a brief about nothing", async () => {
    /* The single most likely way this job lies to you: a source silently
       unreachable produces a summary that reads as a quiet day. */
    const box = sandbox();
    mcpConfig(box, { calendar: { command: "x" } });
    const copilot = recordingBin(box, "copilot", { stdout: "should never run" });

    const r = run(box, "ask-copilot", ["--brief", "--source", "mail", "--dry-run"]);

    assert.notEqual(r.code, 0, "a brief was produced with a source that does not exist");
    assert.match(r.all, /mail/);
    assert.equal(copilot.ran(), false, "the vendor CLI was invoked despite the missing source");
  });

  test("proceeds when the required source IS configured", async () => {
    /* The positive control. Without it, a version that refused every run would
       pass the test above. */
    const box = sandbox();
    mcpConfig(box, { mail: { command: "x" } });
    fakeBin(box, "copilot", `printf 'a brief\\n'`);

    const r = run(box, "ask-copilot", ["--brief", "--source", "mail", "--dry-run"]);

    assert.equal(r.code, 0, r.all);
  });
});

// --- --dry-run -------------------------------------------------------------

describe("ask-copilot --dry-run", () => {
  test("prints the prompt and invokes nothing", async () => {
    /* The step that makes "read it before it runs unattended at 06:45"
       possible at all. */
    const box = sandbox();
    mcpConfig(box, { mail: { command: "x" } });
    const copilot = recordingBin(box, "copilot");

    const r = run(box, "ask-copilot", ["--brief", "--dry-run"]);

    assert.equal(r.code, 0, r.all);
    assert.match(r.all, /OPEN ITEMS/, "the prompt was not shown");
    assert.equal(copilot.ran(), false, "--dry-run invoked the vendor CLI");
  });

  test("writes no journal entry", async () => {
    /* A dry run that appended to the journal would put a prompt into the
       record the next brief reads back as yesterday's summary. */
    const box = sandbox();
    mcpConfig(box, { mail: { command: "x" } });
    recordingBin(box, "copilot");

    run(box, "ask-copilot", ["--brief", "--dry-run"]);

    const journal = join(box.home, ".stonedog-ask", "journal");
    const entries = existsSync(journal)
      ? (await import("node:fs")).readdirSync(journal).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      : [];
    assert.deepEqual(entries, [], "--dry-run wrote a journal entry");
  });
});
