/**
 * Integration tier — `ask-gemini` as a real subprocess.
 *
 * Every vendor tool it reaches for is a fake first on PATH: `gemini`, `aws`,
 * `curl`. That is what makes the whole credential path — resolve, validate,
 * scrub, invoke, record — reachable without a network call, an AWS account or
 * an entitlement.
 *
 * And it runs in a sandbox with its own HOME, because the last source in the
 * chain spawns an interactive shell that would otherwise read the developer's
 * real profile. See tests/support/sandbox.mjs.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

import { fakeBin, recordingBin, run, sandbox } from "../support/sandbox.mjs";

const KEY = "AIza-test-key-not-real";

/** A `curl` that reports whatever HTTP status the test wants for a key probe. */
function fakeCurl(box, { accept = KEY } = {}) {
  fakeBin(box, "curl", `case "$*" in *"key=${accept}"*) printf '200';; *) printf '400';; esac`);
}

/** A `gemini` that answers, and records how it was invoked. */
function fakeGemini(box, { reply = "the answer" } = {}) {
  const log = join(box.dir, "gemini.calls");
  fakeBin(
    box,
    "gemini",
    `printf '%s\\n' "$*" >> "${log}"\n` +
      `env > "${log}.env.$$"\n` +
      `cp "${log}.env.$$" "${log}.env"\n` +
      `case "$1" in --version) printf '0.99.0\\n'; exit 0;; esac\n` +
      `printf '%s\\n' '${reply}'`,
  );
  return {
    calls: () => (existsSync(log) ? readFileSync(log, "utf8").trimEnd().split("\n") : []),
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

function withSecret(box, value) {
  const dir = join(box.home, ".stonedog-ask");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ workstationSecret: { id: "a/secret" } }));
  fakeBin(box, "aws", `printf '{"GOOGLE_API_KEY":"${value}"}'`);
}

// --- --check ---------------------------------------------------------------

describe("ask-gemini --check", () => {
  test("finds a key in the secret store, validates it, and reports ready", async () => {
    const box = sandbox();
    fakeGemini(box);
    fakeCurl(box);
    withSecret(box, KEY);

    const r = run(box, "ask-gemini", ["--check"]);

    assert.equal(r.code, 0, r.all);
    assert.match(r.all, /ready/);
    assert.match(r.all, /a\/secret \(Secrets Manager\)/, "it did not say where the key came from");
  });

  test("never prints the key itself, only a fingerprint", async () => {
    /* `--check` output lands in scrollback, in CI logs and in agent
       transcripts. This is the assertion that keeps it safe to paste. */
    const box = sandbox();
    fakeGemini(box);
    fakeCurl(box);
    withSecret(box, KEY);

    const r = run(box, "ask-gemini", ["--check"]);

    assert.equal(r.all.includes(KEY), false, "the live key was printed");
    assert.match(r.all, /sha [0-9a-f]{12}/);
  });

  test("with no credentials anywhere it reports NOT ready and exits non-zero", async () => {
    const box = sandbox();
    fakeGemini(box);
    fakeCurl(box, { accept: "nothing-matches" });

    const r = run(box, "ask-gemini", ["--check"]);

    assert.notEqual(r.code, 0, "a machine with no credentials reported success");
    assert.match(r.all, /NOT ready/);
  });

  test("with no secret configured it names only the sources it really searched", async () => {
    /* An unconfigured store must not appear as a source that was consulted and
       came back empty — that is a claim about where the tool looked. */
    const box = sandbox();
    fakeGemini(box);
    fakeCurl(box, { accept: "nothing-matches" });

    const r = run(box, "ask-gemini", ["--check"]);

    assert.match(r.all, /No API key found in the environment or a login shell/);
    assert.equal(/found in the environment, ,/.test(r.all), false, "a blank source was listed");
    // `(Secrets Manager)` is the resolver's own source LABEL — its presence
    // would mean the store was walked. Prose elsewhere that merely *offers* the
    // store as something to enable is advice, not a claim about where it
    // looked, and the next assertion requires that advice to stay.
    assert.equal(
      /\(Secrets Manager\)/.test(r.all),
      false,
      "an unconfigured store was reported as a source that was consulted",
    );
  });

  test("...but still says how to turn the secret store on", async () => {
    /* The other half. A refusal that names no remedy is where people go and
       paste a key into a dotfile instead, which is the thing this design is
       trying to stop. */
    const box = sandbox();
    fakeGemini(box);
    fakeCurl(box, { accept: "nothing-matches" });

    const r = run(box, "ask-gemini", ["--check"]);

    assert.match(r.all, /set WS_SECRET_ID/);
    assert.match(r.all, /shell profile/, "the reason not to use a dotfile was dropped");
  });

  test("makes no AWS call at all when no secret is configured", async () => {
    const box = sandbox();
    fakeGemini(box);
    fakeCurl(box, { accept: "nothing-matches" });
    const aws = recordingBin(box, "aws", { code: 1 });

    run(box, "ask-gemini", ["--check"]);

    assert.equal(aws.ran(), false, "`aws` was executed with no secret configured");
  });

  test("a key Google rejects is not reported as working", async () => {
    /* The failure this whole tool was built around: a credential that exists is
       not a credential that is accepted. */
    const box = sandbox();
    fakeGemini(box);
    fakeCurl(box, { accept: "some-other-key" });
    withSecret(box, KEY);

    const r = run(box, "ask-gemini", ["--check"]);

    assert.notEqual(r.code, 0);
    assert.equal(/API key accepted/.test(r.all), false, "an unaccepted key was reported as accepted");
  });
});

// --- the environment handed to the CLI -------------------------------------

describe("the environment ask-gemini hands to the CLI", () => {
  test("strips the variables that silently redirect the backend", async () => {
    /* `GOOGLE_CLOUD_PROJECT` and `GOOGLE_GENAI_USE_VERTEXAI` route OAuth
       through a different backend and fail as a 403 naming a project nobody
       chose. Inherited from a parent process, they are invisible. */
    const box = sandbox({
      env: {
        GOOGLE_CLOUD_PROJECT: "someone-elses-project",
        GOOGLE_GENAI_USE_VERTEXAI: "true",
      },
    });
    const gemini = fakeGemini(box);
    fakeCurl(box);
    withSecret(box, KEY);

    run(box, "ask-gemini", ["a question"]);

    const env = gemini.env();
    assert.ok(env, "the CLI was never invoked");
    assert.equal("GOOGLE_CLOUD_PROJECT" in env, false);
    assert.equal("GOOGLE_GENAI_USE_VERTEXAI" in env, false);
  });

  test("passes the working key through, and removes the stale one beside it", async () => {
    /* An earlier version stripped every key, which fixed the stale-key failure
       by throwing away the live key next to it. Both halves are asserted. */
    const box = sandbox({ env: { GOOGLE_API_KEY: "stale-key-that-does-not-work" } });
    const gemini = fakeGemini(box);
    fakeCurl(box); // accepts KEY only
    withSecret(box, KEY);

    run(box, "ask-gemini", ["a question"]);

    const env = gemini.env();
    assert.equal(env.GEMINI_API_KEY, KEY, "the working key was not passed to the CLI");
    assert.equal("GOOGLE_API_KEY" in env, false, "a stale key was left to win by precedence");
  });

  test("invokes the CLI with --skip-trust", async () => {
    /* Without it every headless call dies on a trusted-folders prompt, which
       in a cron job is a hang rather than an error. */
    const box = sandbox();
    const gemini = fakeGemini(box);
    fakeCurl(box);
    withSecret(box, KEY);

    run(box, "ask-gemini", ["a question"]);

    const call = gemini.calls().find((c) => c.includes("-p"));
    assert.ok(call, "the CLI was never invoked with a prompt");
    assert.match(call, /--skip-trust/);
  });
});

// --- the ledger ------------------------------------------------------------

describe("the usage ledger", () => {
  test("records the call, and marks the counts as estimated", async () => {
    /* Gemini reports no usage metadata non-interactively, so these numbers are
       a 4-chars-per-token guess. A row that did not say so is a number a
       dashboard will repeat to two decimal places. */
    const box = sandbox();
    fakeGemini(box);
    fakeCurl(box);
    withSecret(box, KEY);

    run(box, "ask-gemini", ["a question"]);

    const ledger = join(box.home, ".claude", "ai-usage", "gemini.jsonl");
    assert.ok(existsSync(ledger), "no ledger row was written");
    const rows = readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].estimated, true, "an estimated count was recorded as measured");
    assert.ok(rows[0].usage.input > 0);
    assert.ok(rows[0].ts);
  });

  test("does not record the prompt or the answer", async () => {
    /* The ledger is a usage record, not a transcript. It sits in a dotfile
       nobody thinks about, and what gets asked is often not shareable. */
    const box = sandbox();
    fakeGemini(box, { reply: "SECRET-ANSWER-TEXT" });
    fakeCurl(box);
    withSecret(box, KEY);

    run(box, "ask-gemini", ["SECRET-QUESTION-TEXT"]);

    const ledger = join(box.home, ".claude", "ai-usage", "gemini.jsonl");
    const text = readFileSync(ledger, "utf8");
    assert.equal(text.includes("SECRET-ANSWER-TEXT"), false, "the answer was written to the ledger");
    assert.equal(text.includes("SECRET-QUESTION-TEXT"), false, "the prompt was written to the ledger");
  });
});
