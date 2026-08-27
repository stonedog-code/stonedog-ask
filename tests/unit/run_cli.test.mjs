/**
 * Unit tier — `runCli`, the process-group kill.
 *
 * This exists because of a measured 44-hour, 22 GiB orphan (2026-08-27). The
 * regression it guards against is not a crash and not a wrong answer: it is a
 * timeout that FIRES, REPORTS correctly, and leaves the process holding the
 * memory alive. Everything the caller can see looks right.
 *
 * Two things here are deliberate and easy to "tidy" into uselessness:
 *
 *   1. THE CONTROL. `spawnSync` — what this replaced, and what a future
 *      simplification would reach for — is asserted to leak the grandchild. If
 *      that ever stops being true, every other assertion is proving nothing.
 *
 *   2. NOTHING WAITS ON THE PROMISE TO DECIDE ALIVENESS. A leaking
 *      implementation does not resolve promptly — the orphan holds the
 *      inherited stdout — so an `await` would sit there until the stub's own
 *      sleep expired and then find the grandchild conveniently dead. That is a
 *      false pass, and an earlier draft of this file had it. The stub publishes
 *      its pid to a FILE and the checks run on a deadline instead.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { runCli } from "../../lib/run-cli.mjs";

const dir = mkdtempSync(join(tmpdir(), "ask-runcli-"));
const strays = [];

/**
 * Long enough that no check can outlive it (the longest waits ~8s), short
 * enough that a stub which escapes cleanup — a `kill -9` on the runner, an
 * assertion that throws before the pid is recorded — is gone in a minute
 * rather than ten.
 */
const STUB_LIFETIME_S = 60;

/**
 * A stand-in for the Gemini CLI's shape: the launcher re-execs into a
 * grandchild with a raised heap, and the grandchild owns the memory.
 *
 * The LAUNCHER dies to SIGTERM; only the grandchild ignores it. That is the
 * real failure: the signal lands, the direct child goes away, and the process
 * actually holding the memory is orphaned onto `systemd --user`.
 */
function stubTree(name) {
  const pidFile = join(dir, `${name}.pid`);

  const grandchild = join(dir, `${name}-gc.sh`);
  writeFileSync(grandchild, `#!/bin/bash\ntrap '' TERM\nsleep ${STUB_LIFETIME_S} &\nwait\n`);
  chmodSync(grandchild, 0o755);

  /*
   * THE GRANDCHILD GETS NO INHERITED STDIO, and that is not tidiness.
   *
   * The control deliberately leaves one alive. An orphan holding the runner's
   * stdout keeps every reader of that pipe blocked — `npm test | tail`, and in
   * particular the self-check's own `out=$(node --test ...)`, which waited on
   * a dead command for the stub's full lifetime. That is the very failure this
   * file is about, reproduced by the file itself: it hung the gate for minutes
   * with no test running. Detaching its stdio makes an escaped stub harmless.
   */
  const launcher = join(dir, `${name}.sh`);
  writeFileSync(launcher, `#!/bin/bash\n${grandchild} > /dev/null 2>&1 < /dev/null &\necho $! > ${pidFile}\nwait\n`);
  chmodSync(launcher, 0o755);

  return { launcher, pidFile };
}

/**
 * A grandchild that ESCAPES the process group with `setsid` and keeps stdout.
 *
 * A group kill cannot reach it — that is a real limit of the mechanism, not a
 * bug to assert away. What must never happen is the caller waiting on it: with
 * the pipe still held, `close` never fires, and an earlier draft hung forever
 * on exactly this. The promise this file defends is "the caller always gets its
 * answer back", not "nothing survives".
 */
function escapingStub(name) {
  const pidFile = join(dir, `${name}.pid`);
  const launcher = join(dir, `${name}.sh`);
  writeFileSync(
    launcher,
    `#!/bin/bash\nsetsid bash -c 'trap "" TERM; sleep ${STUB_LIFETIME_S}' &\necho $! > ${pidFile}\nwait\n`,
  );
  chmodSync(launcher, 0o755);
  return { launcher, pidFile };
}

/** Wait for the stub to publish its grandchild pid, without awaiting the call. */
async function grandchildPid(pidFile) {
  for (let i = 0; i < 100; i++) {
    if (existsSync(pidFile)) {
      const raw = readFileSync(pidFile, "utf8").trim();
      if (raw) {
        const pid = Number(raw);
        strays.push(pid);
        return pid;
      }
    }
    await sleep(50);
  }
  assert.fail("the stub never published a grandchild pid");
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

after(() => {
  /* Sweep every pid file, not just the ones a test reached — an assertion that
     throws before `grandchildPid` would otherwise leak a stub silently. */
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".pid")) continue;
    const raw = readFileSync(join(dir, f), "utf8").trim();
    if (raw) strays.push(Number(raw));
  }
  for (const pid of strays) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone: the point */ }
  }
});

describe("runCli", () => {
  test("CONTROL: spawnSync's own timeout leaks the grandchild", async () => {
    /* Not a test of our code — a test of the SUITE. A broken implementation
       would pass the assertions below too if this stopped holding. */
    const { launcher, pidFile } = stubTree("control");
    const r = spawnSync("bash", ["-c", launcher], { encoding: "utf8", timeout: 1500 });
    assert.equal(r.error?.code, "ETIMEDOUT", "the control never reached its timeout");
    const pid = await grandchildPid(pidFile);
    assert.equal(alive(pid), true, "spawnSync killed the grandchild — the control is void");
  });

  test("kills the whole process group on timeout", async () => {
    const { launcher, pidFile } = stubTree("kill");
    const call = runCli("bash", ["-c", launcher], { timeoutMs: 1500 });
    const pid = await grandchildPid(pidFile);

    /* Deliberately NOT `await call` — a leaking implementation would not
       resolve here, and waiting for it is what produced a false pass. */
    await sleep(4000);
    assert.equal(alive(pid), false, "the grandchild survived the timeout — the orphan bug is back");

    const r = await call;
    assert.equal(r.timedOut, true);
    assert.equal(r.error?.code, "ETIMEDOUT");
  });

  test("returns AT the timeout, not when the pipes happen to close", async () => {
    /* spawnSync blocks until every holder of the inherited stdout closes it, so
       an orphan kept it waiting far past the child's death — a 2s command took
       the full 60s outer timeout. A caller that is not running cannot clean up
       after itself. */
    const { launcher } = stubTree("prompt");
    const started = Date.now();
    const settled = await Promise.race([
      runCli("bash", ["-c", launcher], { timeoutMs: 1500 }).then(() => "settled"),
      sleep(8000).then(() => "still waiting"),
    ]);
    assert.equal(settled, "settled", `did not return within 8s (${Date.now() - started}ms): it is waiting on pipes, not on the clock`);
  });

  test("an escapee cannot hang the call — it resolves anyway", async () => {
    /* The failure this replaced was a 44-hour wait. Reintroducing an unbounded
       wait one layer up, for a process the kill cannot reach, would be the same
       bug wearing a different hat. */
    const { launcher, pidFile } = escapingStub("escape");
    const started = Date.now();
    const settled = await Promise.race([
      runCli("bash", ["-c", launcher], { timeoutMs: 1500 }).then(() => "settled"),
      sleep(12_000).then(() => "still waiting"),
    ]);
    assert.equal(settled, "settled", `never resolved (${Date.now() - started}ms): an escapee is holding the pipe`);
    await grandchildPid(pidFile); // record it so cleanup gets it
  });

  test("a healthy call still returns its output and status", async () => {
    /* The other direction. A kill-everything implementation would pass every
       assertion above and be useless. */
    const r = await runCli("bash", ["-c", "printf 'hello'; printf 'oops' >&2; exit 0"], { timeoutMs: 30_000 });
    assert.equal(r.stdout, "hello");
    assert.equal(r.stderr, "oops");
    assert.equal(r.status, 0);
    assert.equal(r.timedOut, false);
    assert.equal(r.error, undefined);
  });

  test("passes stdin through, which is how the whole prompt travels", async () => {
    /* The prompt is tens of megabytes in --repo mode and goes in on stdin
       precisely because it would exceed ARG_MAX as argv. */
    const r = await runCli("cat", [], { input: "the prompt", timeoutMs: 30_000 });
    assert.equal(r.stdout, "the prompt");
    assert.equal(r.status, 0);
  });

  test("reports a non-zero exit rather than swallowing it", async () => {
    const r = await runCli("bash", ["-c", "exit 3"], { timeoutMs: 30_000 });
    assert.equal(r.status, 3);
    assert.equal(r.timedOut, false);
  });

  test("a missing binary is an error, not a silent empty answer", async () => {
    /* Empty output is the shape a hang has too, and the callers key on the
       payload — so this must not read as a quiet success. */
    const r = await runCli(join(dir, "no-such-binary"), [], { timeoutMs: 30_000 });
    assert.ok(r.error, "a missing binary produced no error");
    /* ENOENT specifically: both bins branch on this exact code to tell "the CLI
       is not installed" apart from "the CLI failed", and that is the message
       that sends someone to `npm i -g` instead of to their credentials. */
    assert.equal(r.error.code, "ENOENT");
    assert.equal(r.stdout, "");
  });

  test("truncates at maxBuffer instead of failing with no output at all", async () => {
    const r = await runCli("bash", ["-c", "printf 'abcdefghij'"], { timeoutMs: 30_000, maxBuffer: 4 });
    assert.equal(r.stdout, "abcd");
    assert.equal(r.truncated, true);
    assert.equal(r.status, 0);
  });
});
