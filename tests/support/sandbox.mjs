/**
 * A throwaway machine: its own HOME, its own PATH, its own login shell.
 *
 * EVERY test that runs a bin, or anything that reaches `fromLoginShell`, must
 * go through here. The login-shell probe spawns `$SHELL -ic`, and an
 * interactive shell sources the HOST's rc file — so without a sandboxed HOME a
 * test would:
 *
 *   1. read the developer's REAL credentials and assert on them, which is both
 *      a leak into scrollback and a test that passes only on one machine;
 *   2. escape the fake-CLI directory entirely, because an rc file that resets
 *      or prepends to PATH is completely ordinary; and
 *   3. hang for up to 60s per call on a profile that expects a terminal.
 *
 * Putting fake binaries first on PATH is not enough on its own. That was the
 * hole in the first version of this plan, and it is the reason `home` and
 * `SHELL` are set here rather than left to whatever ran the suite.
 *
 * `homedir()` reads $HOME on POSIX, so one override also redirects the config
 * file, the journal and the usage ledger — the three things these tools write.
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BIN = (name) => join(REPO, "bin", name);

/**
 * A fake executable, first on the sandbox PATH.
 *
 * `sh`, not `node`: these stand in for `aws`, `gh`, `curl` and the vendor CLIs,
 * and a shell script is the shortest thing that can record its argv and its
 * environment for the test to read back.
 */
export function fakeBin(box, name, body) {
  const path = join(box.bin, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

/** A fake that records how it was called, then prints `stdout` and exits `code`. */
export function recordingBin(box, name, { stdout = "", code = 0 } = {}) {
  const log = join(box.dir, `${name}.calls`);
  fakeBin(
    box,
    name,
    `printf '%s\\n' "$*" >> "${log}"\n` +
      `env > "${log}.env"\n` +
      (stdout ? `printf '%s' '${stdout.replace(/'/g, "'\\''")}'\n` : "") +
      `exit ${code}`,
  );
  return {
    /** Argv of each call, in order. Empty when it was never run. */
    calls: () => (existsSync(log) ? readFileSync(log, "utf8").trimEnd().split("\n") : []),
    ran: () => existsSync(log),
    /** The environment the fake was handed — how env scrubbing is measured. */
    env: () => {
      if (!existsSync(`${log}.env`)) return null;
      const out = {};
      for (const line of readFileSync(`${log}.env`, "utf8").split("\n")) {
        const i = line.indexOf("=");
        if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
      }
      return out;
    },
  };
}

/**
 * A sandbox. `env` is a COMPLETE environment, not an overlay: the point is that
 * nothing of the host's leaks in, so it is built from nothing rather than from
 * `process.env`.
 */
export function sandbox({ rc = "", env: extra = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ask-test-"));
  const home = join(dir, "home");
  const bin = join(dir, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });

  // The login shell's rc. `bash -ic` sources ~/.bashrc for an interactive
  // shell, and this HOME is ours, so this file is the only profile it sees.
  writeFileSync(join(home, ".bashrc"), rc, { mode: 0o600 });

  const box = {
    dir,
    home,
    bin,
    env: {
      HOME: home,
      // Fakes first, then a minimal real PATH so `sh`, `printf` and `env` work.
      PATH: `${bin}:/usr/bin:/bin`,
      SHELL: "/bin/bash",
      // Deliberately absent: every WS_*, every vendor key, and anything else
      // the host exports. An inherited one is exactly what these tools strip.
      LANG: "C",
      NODE_OPTIONS: "",
      ...extra,
    },
  };
  return box;
}

/** Run a bin inside the sandbox. Never inherits the caller's environment. */
export function run(box, binName, args = [], { timeout = 60_000, input = "" } = {}) {
  const r = spawnSync(process.execPath, [BIN(binName), ...args], {
    env: box.env,
    encoding: "utf8",
    timeout,
    input,
  });
  return {
    code: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    all: `${r.stdout ?? ""}${r.stderr ?? ""}`,
  };
}

/**
 * Import a lib module with a fresh module registry entry.
 *
 * `credentials.mjs` and `journal.mjs` read their configuration at MODULE SCOPE,
 * so a second import under the same specifier returns the first one's answers
 * however the environment has changed since. The query string makes it a
 * different specifier and therefore a genuine re-evaluation.
 */
let seq = 0;
export async function freshImport(rel) {
  return import(`${new URL(`../../lib/${rel}`, import.meta.url).href}?v=${++seq}`);
}
