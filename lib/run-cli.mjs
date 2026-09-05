/**
 * runCli — spawn a vendor CLI so that a timeout actually ENDS it.
 *
 * `spawnSync`'s own `timeout` option is not enough, and the way it is not
 * enough is silent and expensive. Measured 2026-08-27, after a hung
 * `ask-gemini --repo` call was found holding **22 GiB of RSS for 44 hours**:
 *
 *   1. It signals the DIRECT CHILD ONLY. The Gemini CLI re-execs itself into a
 *      grandchild with a raised heap cap (`--max-old-space-size=31469`), so the
 *      process that owns the memory never receives the signal. It is reparented
 *      to `systemd --user` and runs until the machine is rebooted or somebody
 *      goes looking. Reproduced with a control: the grandchild survives.
 *
 *   2. It sends SIGTERM, which a wedged CLI ignores. The 44-hour process did
 *      not die to SIGTERM when signalled by hand; it needed SIGKILL. A timeout
 *      whose signal the target ignores is not a timeout.
 *
 *   3. It waits for the PIPES to close, not for the child to exit. An orphaned
 *      grandchild inherits stdout, so `spawnSync` stays blocked long past the
 *      child's death — a 2s command took the full 60s outer timeout to return.
 *      So the caller cannot even clean up afterwards; it is not running.
 *
 * GNU `timeout` is not the fix either: this machine ships **uutils coreutils
 * 0.8.0**, whose `timeout` did not group-kill in the same control. Depending on
 * which coreutils a host has is exactly the sort of thing that works here and
 * fails on the next machine.
 *
 * So: put the child in its own process group (`detached`), and on timeout
 * SIGKILL the whole GROUP via the negative pid. All three failures go away
 * together — the grandchild dies, the signal cannot be ignored, and `close`
 * fires immediately because nothing is left holding a pipe.
 *
 * ONE THING A GROUP KILL CANNOT PROMISE, and it is why the grace timer below
 * exists: a process that calls `setsid()` leaves the group and outlives the
 * signal. If such an escapee also holds the inherited stdout, `close` NEVER
 * FIRES — and waiting on it would hang this call forever, which is the very
 * failure the timeout exists to prevent, moved one layer up. Verified by
 * control: with a `setsid` grandchild, an earlier draft never resolved.
 *
 * The guarantee this makes is therefore the honest one: THE CALLER ALWAYS GETS
 * ITS ANSWER BACK. Everything in the child's own process group is killed; an
 * escapee is not, so after the kill we wait a short grace period, tear down the
 * pipes ourselves, and resolve regardless.
 *
 * The result shape mirrors the `spawnSync` fields the callers already read
 * (`stdout`, `stderr`, `status`, `error`), plus `timedOut`, so a call site
 * changes by one `await` and one added field.
 */

import { spawn } from "node:child_process";

/**
 * How long to wait for `close` after the group kill before tearing the pipes
 * down ourselves. A killed group is gone in milliseconds; this only ever
 * elapses when something escaped, which is exactly when waiting is wrong.
 */
const KILL_GRACE_MS = 2000;

/**
 * The interrupts a terminal delivers to its foreground process group. The
 * detached child is no longer in that group, so each of these has to be
 * forwarded by hand — see the handler below.
 */
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ input?: string, env?: NodeJS.ProcessEnv, cwd?: string,
 *           timeoutMs?: number, maxBuffer?: number }} [options]
 * @returns {Promise<{ stdout: string, stderr: string, status: number|null,
 *                     signal: string|null, timedOut: boolean,
 *                     truncated: boolean, truncatedStdout: boolean,
 *                     truncatedStderr: boolean, maxBuffer: number,
 *                     error?: Error }>}
 */
export function runCli(cmd, args, options = {}) {
  const {
    input,
    env,
    cwd,
    timeoutMs = 20 * 60 * 1000,
    maxBuffer = 128 * 1024 * 1024,
  } = options;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        env,
        cwd,
        detached: true, // its own process group, so the whole tree is killable
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({
        stdout: "", stderr: "", status: null, signal: null, timedOut: false,
        truncated: false, truncatedStdout: false, truncatedStderr: false, maxBuffer,
        error,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    /*
     * TRACKED PER STREAM, because the caller acts on them differently.
     *
     * One shared flag cannot answer "was the ANSWER cut off?" — a chatty
     * stderr would set it just as readily, and appending "[truncated]" to a
     * complete answer because the vendor logged too much is its own lie.
     */
    let truncatedStdout = false;
    let truncatedStderr = false;
    let timedOut = false;
    let spawnError;

    /*
     * DECODE ACROSS CHUNKS, NOT PER CHUNK.
     *
     * A pipe emits Buffers that break at arbitrary byte offsets, so any
     * multibyte character straddling a boundary is decoded as two half
     * sequences and silently becomes replacement characters. `spawnSync`
     * decoded the whole buffer at once and had no boundary to split on, so
     * this is a regression introduced by the move to `spawn`, not an old bug.
     *
     * Measured with a U+2014 em-dash at byte 65535 — the first boundary a
     * 64KiB pipe read produces:
     *
     *   per-chunk toString("utf8"):  replacements=3  hasEmDash=false
     *   setEncoding("utf8"):         replacements=0  hasEmDash=true
     *
     * `setEncoding` puts a StringDecoder on the stream, which holds a partial
     * sequence back until the bytes completing it arrive. Anything over ~64KiB
     * is exposed, and a long review is exactly that shape — so the failure is
     * silent corruption of the answer, which is worse than a loud error.
     *
     * `collect` then measures in characters, as it already did: `into` was
     * always a string, so the truncation semantics are unchanged.
     */
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    // Cap what we retain rather than what the child may send. Killing on
    // overflow the way spawnSync does turns a merely chatty answer into a
    // failure with no output at all, which is the worse of the two.
    const collect = (chunk, into, markTruncated) => {
      const room = maxBuffer - into.length;
      if (room <= 0) {
        markTruncated();
        return into;
      }
      const text = chunk;
      if (text.length > room) {
        markTruncated();
        return into + text.slice(0, room);
      }
      return into + text;
    };

    child.stdout.on("data", (c) => { stdout = collect(c, stdout, () => { truncatedStdout = true; }); });
    child.stderr.on("data", (c) => { stderr = collect(c, stderr, () => { truncatedStderr = true; }); });

    // A CLI that dies early closes stdin under us; that is the child's failure
    // to report, not an ask-* crash.
    child.stdin.on("error", () => {});
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();

    child.on("error", (error) => { spawnError = error; });

    let settled = false;
    let timer = null;
    let graceTimer = null;

    const finish = (status, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      for (const s of SIGNALS) process.removeListener(s, onSignal);
      resolve({
        stdout,
        stderr,
        status,
        signal,
        timedOut,
        truncated: truncatedStdout || truncatedStderr,
        truncatedStdout,
        truncatedStderr,
        maxBuffer,
        error: spawnError ?? (timedOut ? Object.assign(new Error(`timed out after ${timeoutMs}ms`), { code: "ETIMEDOUT" }) : undefined),
      });
    };

    /** SIGKILL the group; fall back to the single child if the group is gone. */
    const killTree = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try { child.kill("SIGKILL"); } catch {}
      }
      // Do NOT simply wait for 'close' here — see the header. An escapee
      // holding stdout would mean it never arrives.
      graceTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.stdin?.destroy();
        finish(null, "SIGKILL");
      }, KILL_GRACE_MS);
    };

    /*
     * CTRL-C MUST STILL TAKE THE WHOLE TREE DOWN.
     *
     * `detached: true` above is what makes the group kill possible. It is also
     * what breaks the interrupt path: the vendor tree is no longer in the
     * terminal's FOREGROUND PROCESS GROUP, so a Ctrl-C reaches this wrapper and
     * nothing else. The wrapper dies; the grandchild holding the memory is
     * orphaned onto `systemd --user`. That is this file's own bug through a
     * different door, and it is the door people actually use — interrupting a
     * slow call at minute two, rather than waiting out a 20-minute timeout.
     *
     * Measured with the same stub tree the tests use, SIGINT to the wrapper's
     * group:
     *
     *   spawnSync:                    wrapper pgid 943703, gc pgid 943703 -> SURVIVED
     *   detached, no handler:         wrapper pgid 927007, gc pgid 927016 -> SURVIVED
     *   detached, with this handler:  wrapper pgid 928723, gc pgid 928736 -> DIED
     *
     * Two things live in those numbers, and the second decides the shape of the
     * fix. The pgids confirm the mechanism: `detached` really does move the tree
     * out of the wrapper's group (927016 != 927007) where `spawnSync` kept it in
     * (943703 == 943703). But sharing the group is NOT sufficient — the
     * spawnSync row leaks too, because a non-interactive shell sets SIGINT to
     * SIG_IGN for a background job, so the stub ignores the interrupt whatever
     * group it is in. (An earlier review reported this control as dying. With
     * this stub shape it does not — measured twice.)
     *
     * So the fix cannot be "undo `detached`": that would restore the timeout bug
     * AND still leak here. It has to be an explicit forward, and it has to be
     * the SIGKILL `killTree` already sends, which no disposition can ignore —
     * which makes this path strictly better than the spawnSync it replaced
     * rather than merely equal to it.
     *
     * So take the group down with us, then RE-RAISE. Removing the listeners
     * first restores the default disposition, so the process dies OF the signal
     * rather than exiting 0 and misreporting how it ended. `finish` unhooks too,
     * so a completed call leaves no handler behind to stack on the next one.
     */
    const onSignal = (sig) => {
      killTree();
      for (const s of SIGNALS) process.removeListener(s, onSignal);
      process.kill(process.pid, sig);
    };
    for (const s of SIGNALS) process.once(s, onSignal);

    timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; killTree(); }, timeoutMs) : null;

    // 'close' rather than 'exit': it fires once the streams are done as well as
    // the process, which is what makes the collected output complete.
    child.on("close", (status, signal) => finish(status, signal));
  });
}
