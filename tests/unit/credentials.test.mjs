/**
 * Unit tier — the credential resolver.
 *
 * This is the highest-risk file in the repository and the one with the least
 * visible failure mode: every source it walks returns a plausible string, and
 * picking the wrong one produces a working-looking tool that talks to the wrong
 * account. The README's own account of what went wrong here is a *precedence*
 * bug, not a crash.
 *
 * Nothing here touches the network or AWS. `workstationSecret` shells out to
 * `aws`, so `aws` is a fake first on PATH — which also lets the "it must NOT
 * shell out" case be asserted rather than assumed.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { fakeBin, freshImport, sandbox } from "../support/sandbox.mjs";

/** Import `credentials.mjs` as if the process had this environment. */
async function withEnv(env, fn) {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, env);
  try {
    return await fn(await freshImport("credentials.mjs"));
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

function writeConfig(box, workstationSecret) {
  const dir = join(box.home, ".stonedog-ask");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ workstationSecret }), "utf8");
  return path;
}

// --- resolveCredential: the order IS the specification ---------------------

describe("resolveCredential", () => {
  test("returns the first candidate the validator accepts, and names its source", async () => {
    const { resolveCredential } = await freshImport("credentials.mjs");
    const got = resolveCredential(
      [
        ["environment", () => ["good-env"]],
        ["secret store", () => ["good-secret"]],
      ],
      () => true,
    );
    assert.deepEqual(got, { secret: "good-env", source: "environment" });
  });

  test("a rejected earlier source falls through to a later one", async () => {
    /* The documented failure: a stale value in an earlier source. It must not
       end the walk — that is the entire reason `validate` exists rather than
       "first non-empty wins". */
    const { resolveCredential } = await freshImport("credentials.mjs");
    const got = resolveCredential(
      [
        ["environment", () => ["stale"]],
        ["secret store", () => ["fresh"]],
      ],
      (s) => s === "fresh",
    );
    assert.deepEqual(got, { secret: "fresh", source: "secret store" });
  });

  test("a later source never overtakes an accepted earlier one", async () => {
    /* The other direction, and the one a reordering would break silently: with
       both valid, the EARLIER source must win. Without this, a resolver that
       walked the list backwards passes the test above. */
    const { resolveCredential } = await freshImport("credentials.mjs");
    const got = resolveCredential(
      [
        ["environment", () => ["a"]],
        ["secret store", () => ["b"]],
      ],
      () => true,
    );
    assert.equal(got.source, "environment");
  });

  test("empty and whitespace candidates are skipped, not returned", async () => {
    const { resolveCredential } = await freshImport("credentials.mjs");
    const got = resolveCredential([["s", () => ["", null, undefined, "real"]]], () => true);
    assert.equal(got.secret, "real");
  });

  test("nothing anywhere is reported as nothing, not as an empty string", async () => {
    /* `{secret: "", source: "environment"}` would read downstream as "a
       credential was found", which is how a tool reports ready with no key. */
    const { resolveCredential } = await freshImport("credentials.mjs");
    assert.deepEqual(resolveCredential([["s", () => [""]]], () => true), {
      secret: null,
      source: null,
    });
  });

  test("each source is consulted lazily, so a cheap hit costs no subprocess", async () => {
    /* The order is by COST as well as by trust. If every thunk ran, the free
       environment hit would still pay for the `aws` call and the shell probe. */
    const { resolveCredential } = await freshImport("credentials.mjs");
    let expensiveRan = false;
    resolveCredential(
      [
        ["environment", () => ["cheap"]],
        ["expensive", () => { expensiveRan = true; return ["x"]; }],
      ],
      () => true,
    );
    assert.equal(expensiveRan, false, "a later source was evaluated after an earlier hit");
  });
});

// --- strippedEnv -----------------------------------------------------------

describe("strippedEnv", () => {
  test("removes exactly the named variables and keeps the rest", async () => {
    await withEnv(
      { GEMINI_API_KEY: "k", GOOGLE_API_KEY: "k2", KEEP_ME: "yes", PATH: "/bin" },
      async ({ strippedEnv }) => {
        const env = strippedEnv(["GEMINI_API_KEY", "GOOGLE_API_KEY"]);
        assert.equal("GEMINI_API_KEY" in env, false);
        assert.equal("GOOGLE_API_KEY" in env, false);
        assert.equal(env.KEEP_ME, "yes", "an unrelated variable was stripped too");
        assert.equal(env.PATH, "/bin", "PATH must survive — the CLI has to be findable");
      },
    );
  });

  test("does not mutate process.env", async () => {
    /* It returns a COPY. Mutating the real environment would strip the variable
       from everything else this process later does, including the next call. */
    await withEnv({ GEMINI_API_KEY: "k" }, async ({ strippedEnv }) => {
      strippedEnv(["GEMINI_API_KEY"]);
      assert.equal(process.env.GEMINI_API_KEY, "k");
    });
  });
});

// --- fingerprint -----------------------------------------------------------

describe("fingerprint", () => {
  test("is stable, short, and shares no prefix with the secret", async () => {
    const { fingerprint } = await freshImport("credentials.mjs");
    const secret = "AIzaSyEXAMPLE-not-a-real-key-000000000000";
    const fp = fingerprint(secret);
    assert.equal(fp, fingerprint(secret), "not stable across calls");
    assert.match(fp, /^[0-9a-f]{12}$/);
    // The whole point: `--check` output lands in logs and transcripts, so no
    // live byte may appear in it.
    assert.equal(secret.startsWith(fp), false);
    assert.equal(secret.includes(fp), false);
  });

  test("different secrets fingerprint differently", async () => {
    const { fingerprint } = await freshImport("credentials.mjs");
    assert.notEqual(fingerprint("a"), fingerprint("b"));
  });
});

// --- the workstation secret: off by default --------------------------------

describe("the workstation secret", () => {
  test("is off when nothing names one, and runs no `aws` at all", async () => {
    /* Not merely "returns {}". A machine that does not use this must not pay a
       failed subprocess on every invocation, and the fake proves whether one
       happened rather than leaving it to inspection. */
    const box = sandbox();
    fakeBin(box, "aws", `touch "${box.dir}/aws-ran"; exit 1`);

    await withEnv({ HOME: box.home, PATH: box.env.PATH }, async (m) => {
      assert.equal(m.wsConfigured(), false);
      assert.deepEqual(m.workstationSecret(), {});
      assert.equal(m.WS_SOURCE, "");
      assert.equal(m.fromWorkstationSecret("GOOGLE_API_KEY"), "");
    });

    assert.equal(existsSync(join(box.dir, "aws-ran")), false, "`aws` was executed with no secret configured");
  });

  test("is configured by ~/.stonedog-ask/config.json, and says so", async () => {
    const box = sandbox();
    const path = writeConfig(box, { id: "some/secret", profile: "p", region: "r" });
    await withEnv({ HOME: box.home, PATH: box.env.PATH }, async (m) => {
      assert.equal(m.wsConfigured(), true);
      assert.equal(m.WS.id, "some/secret");
      assert.equal(m.WS.profile, "p");
      assert.equal(m.WS.region, "r");
      assert.equal(m.WS_SOURCE, path, "--check could not say where the setting came from");
    });
  });

  test("WS_SECRET_ID overrides the file, for one run", async () => {
    const box = sandbox();
    writeConfig(box, { id: "from/file", profile: "p", region: "r" });
    await withEnv(
      { HOME: box.home, PATH: box.env.PATH, WS_SECRET_ID: "from/env" },
      async (m) => {
        assert.equal(m.WS.id, "from/env");
        assert.equal(m.WS_SOURCE, "WS_SECRET_ID");
      },
    );
  });

  test("an unreadable or malformed config is ignored, not fatal", async () => {
    /* A broken config must degrade to "no secret store", because the other
       sources still work and failing the whole run helps nobody. */
    const box = sandbox();
    const dir = join(box.home, ".stonedog-ask");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), "{ not json", "utf8");
    await withEnv({ HOME: box.home, PATH: box.env.PATH }, async (m) => {
      assert.equal(m.wsConfigured(), false);
    });
  });

  test("reads the secret through `aws`, passing the configured profile and region", async () => {
    const box = sandbox();
    writeConfig(box, { id: "some/secret", profile: "prof", region: "reg" });
    fakeBin(
      box,
      "aws",
      `printf '%s\\n' "$*" > "${box.dir}/aws.argv"\n` +
        `printf '{"GOOGLE_API_KEY":"key-from-secret"}'`,
    );
    await withEnv({ HOME: box.home, PATH: box.env.PATH }, async (m) => {
      assert.equal(m.fromWorkstationSecret("GOOGLE_API_KEY"), "key-from-secret");
    });
    const argv = (await import("node:fs")).readFileSync(join(box.dir, "aws.argv"), "utf8");
    assert.match(argv, /--profile prof/);
    assert.match(argv, /--region reg/);
    assert.match(argv, /--secret-id some\/secret/);
  });

  test("omits --profile and --region when they were not set", async () => {
    /* Passing an empty string is not the same as omitting: `aws` rejects it,
       with an error about the wrong thing, on a machine whose ordinary AWS
       configuration would have worked. */
    const box = sandbox();
    writeConfig(box, { id: "some/secret" });
    fakeBin(box, "aws", `printf '%s\\n' "$*" > "${box.dir}/aws.argv"; printf '{}'`);
    await withEnv({ HOME: box.home, PATH: box.env.PATH }, async (m) => {
      m.workstationSecret();
    });
    const argv = (await import("node:fs")).readFileSync(join(box.dir, "aws.argv"), "utf8");
    assert.equal(/--profile/.test(argv), false, "an empty --profile was passed to aws");
    assert.equal(/--region/.test(argv), false, "an empty --region was passed to aws");
  });

  test("a fresh cache is used instead of calling `aws`", async () => {
    const box = sandbox();
    writeConfig(box, { id: "some/secret" });
    const cache = join(box.dir, "cache.json");
    writeFileSync(cache, JSON.stringify({ GOOGLE_API_KEY: "from-cache" }), "utf8");
    fakeBin(box, "aws", `touch "${box.dir}/aws-ran"; printf '{}'`);

    await withEnv(
      { HOME: box.home, PATH: box.env.PATH, WS_SECRET_CACHE: cache },
      async (m) => {
        assert.equal(m.fromWorkstationSecret("GOOGLE_API_KEY"), "from-cache");
      },
    );
    assert.equal(existsSync(join(box.dir, "aws-ran")), false, "the cache was fresh and `aws` ran anyway");
  });

  test("a stale cache falls through to `aws`", async () => {
    /* The other direction. Without it, a cache that is never refreshed passes
       the test above forever. */
    const box = sandbox();
    writeConfig(box, { id: "some/secret" });
    const cache = join(box.dir, "cache.json");
    writeFileSync(cache, JSON.stringify({ GOOGLE_API_KEY: "from-cache" }), "utf8");
    fakeBin(box, "aws", `printf '{"GOOGLE_API_KEY":"from-aws"}'`);

    await withEnv(
      { HOME: box.home, PATH: box.env.PATH, WS_SECRET_CACHE: cache, WS_SECRET_TTL: "0" },
      async (m) => {
        assert.equal(m.fromWorkstationSecret("GOOGLE_API_KEY"), "from-aws");
      },
    );
  });
});
