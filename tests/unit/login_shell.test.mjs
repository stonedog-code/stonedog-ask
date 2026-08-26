/**
 * Unit tier — the login-shell probe, and the sandbox that makes testing it safe.
 *
 * `fromLoginShell` spawns `$SHELL -ic`, and an INTERACTIVE shell sources the
 * rc file of whoever's HOME it is handed. That is the point of the probe — it
 * gets what a new terminal would see — and it is also why a test of it is
 * dangerous by default: run under the developer's own HOME it reads their real
 * credentials, asserts on a machine-specific value, and prints the result into
 * scrollback.
 *
 * So every case here supplies its own HOME with its own `.bashrc`, and the last
 * test asserts that the sandbox actually holds: a value exported by the HOST is
 * NOT visible to the probe. Without that one, a sandbox that silently stopped
 * working would leave every other test here passing.
 */

import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

import { fakeBin, freshImport, sandbox } from "../support/sandbox.mjs";

const HAVE_BASH = existsSync("/bin/bash");

async function probe(env, name) {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, env);
  try {
    const { fromLoginShell } = await freshImport("credentials.mjs");
    return fromLoginShell(name);
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

describe("fromLoginShell", { skip: HAVE_BASH ? false : "no /bin/bash on this machine" }, () => {
  test("reads a variable exported by the shell's own rc file", async () => {
    const box = sandbox({ rc: `export PROBE_TARGET="value-from-rc"\n` });
    assert.equal(await probe(box.env, "PROBE_TARGET"), "value-from-rc");
  });

  test("returns empty for a variable nothing exports", async () => {
    const box = sandbox({ rc: "" });
    assert.equal(await probe(box.env, "PROBE_TARGET"), "");
  });

  test("an rc file that prints a banner does not end up in the value", async () => {
    /* The bug this marker exists for: `-i` means the profile's banner lands on
       stdout, and an open-ended match once returned a 3,800-character "key"
       that was mostly banner. */
    const box = sandbox({
      rc: `echo "Welcome to the machine"\necho "MOTD: remember to stretch"\nexport PROBE_TARGET="clean-value"\n`,
    });
    assert.equal(await probe(box.env, "PROBE_TARGET"), "clean-value");
  });

  test("a value is trimmed, not returned with the shell's whitespace", async () => {
    const box = sandbox({ rc: `export PROBE_TARGET="  padded  "\n` });
    assert.equal(await probe(box.env, "PROBE_TARGET"), "padded");
  });

  test("reads the INTERACTIVE section of the rc file, not just the top", async () => {
    /* `-ic`, not `-lc`, and this is why: the standard bashrc preamble returns
       early for a non-interactive shell, so everything below that guard is
       invisible to `bash -lc`, to scripts, to CI and to any agent. */
    const box = sandbox({
      rc: `case $- in *i*) ;; *) return;; esac\nexport PROBE_TARGET="below-the-guard"\n`,
    });
    assert.equal(await probe(box.env, "PROBE_TARGET"), "below-the-guard");
  });

  test("THE SANDBOX HOLDS: a value exported by the host is not visible", async () => {
    /* The guard on every test above. If HOME stopped being honoured, the probe
       would read the developer's real profile — their real keys — and each of
       those tests would still pass, because they assert on a value the rc file
       sets rather than on the absence of anything else. */
    const box = sandbox({ rc: "" });
    const saved = process.env.PROBE_HOST_ONLY;
    process.env.PROBE_HOST_ONLY = "host-value-that-must-not-leak";
    try {
      assert.equal(
        await probe(box.env, "PROBE_HOST_ONLY"),
        "",
        "the probe escaped the sandbox and read the host environment",
      );
    } finally {
      if (saved === undefined) delete process.env.PROBE_HOST_ONLY;
      else process.env.PROBE_HOST_ONLY = saved;
    }
  });

  test("an rc file that resets PATH cannot reach the host's real tools", async () => {
    /* An rc that overwrites PATH is completely ordinary, and it is how a
       sandboxed probe silently starts running the machine's real `aws` or
       `gh`. The probe itself must still answer from the shell it was given. */
    const box = sandbox({ rc: `export PATH=/usr/bin:/bin\nexport PROBE_TARGET="still-ours"\n` });
    fakeBin(box, "aws", `touch "${box.dir}/aws-ran"`);
    assert.equal(await probe(box.env, "PROBE_TARGET"), "still-ours");
    assert.equal(existsSync(join(box.dir, "aws-ran")), false);
  });
});
