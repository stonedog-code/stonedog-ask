/**
 * Credential resolution shared by every `ask-*` front end.
 *
 * What is generic lives here; what is vendor-specific stays in the bin script.
 * The split is deliberate and the line is "does this know what a Gemini key
 * looks like?" — reading a workstation secret, probing a login shell and
 * fingerprinting a credential do not, so they are here; validating a key
 * against generativelanguage.googleapis.com does, so it is not.
 *
 * The reason this is worth a module rather than a copy-paste: the two tools
 * must fail the same way. A credential path that behaves differently in
 * ask-gemini and ask-copilot produces two different wrong diagnoses for one
 * broken machine, and the whole point of `--check` is that it is trustworthy.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// ── The workstation secret ────────────────────────────────────────────────
//
// An OPTIONAL place to keep a key: an AWS Secrets Manager secret holding a JSON
// object of `NAME: value` pairs. It exists because the alternative people reach
// for is a plaintext `export` in a shell profile, and a long-lived process — an
// editor, an agent session, a cron job — never sees a profile at all.
//
// **Off unless you name a secret.** `WS_SECRET_ID` has no default, deliberately:
// a baked-in secret name would make every machine that does not have it pay an
// `aws` timeout on every run, to look up something that was never theirs. Set
// the three variables together, or none of them.
//
//     WS_SECRET_ID=my-workstation-secret   # required to enable this at all
//     WS_SECRET_PROFILE=default            # AWS profile
//     WS_SECRET_REGION=us-east-1           # AWS region
//     WS_SECRET_TTL=43200                  # seconds a cached copy stays fresh
//
// With none of them set, resolution simply falls through to the environment and
// then to a login-shell probe, which is the ordinary path.

/**
 * The machine's own settings, if it has any.
 *
 * `~/.stonedog-ask/config.json`, the same directory `ask-copilot` already keeps
 * `copilot.json` and its journal in. A FILE rather than a shell export, for the
 * reason this module exists at all: a variable set in a profile is invisible to
 * a cron job and to any process that started before the profile was edited.
 *
 *     { "workstationSecret": { "id": "...", "profile": "...", "region": "..." } }
 *
 * It holds a secret NAME, never a secret value — which is why it can be an
 * ordinary file and why this repository does not ship one. A default baked into
 * the source would name one machine's AWS account in everybody's checkout, and
 * make every other machine pay an `aws` timeout looking up something that was
 * never theirs.
 */
const CONFIG_PATH =
  process.env.ASK_CONFIG || join(process.env.HOME ?? "", ".stonedog-ask", "config.json");

function fileConfig() {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    const ws = parsed && typeof parsed === "object" ? parsed.workstationSecret : null;
    return ws && typeof ws === "object" ? ws : {};
  } catch {
    // Absent is the normal case, and unreadable is not worth failing a whole
    // run for — the sources below still work. `--check` reports what it found.
    return {};
  }
}

const _cfg = fileConfig();

// Environment first, then the config file, then nothing. The environment wins
// so a single run can be pointed elsewhere without editing a file.
export const WS = {
  id: process.env.WS_SECRET_ID || _cfg.id || "",
  profile: process.env.WS_SECRET_PROFILE || _cfg.profile || "",
  region: process.env.WS_SECRET_REGION || _cfg.region || "",
  ttl: Number(process.env.WS_SECRET_TTL || _cfg.ttl || 43_200),
};

/** Where `WS` came from — for `--check`, which has to say what it consulted. */
export const WS_SOURCE = process.env.WS_SECRET_ID
  ? "WS_SECRET_ID"
  : _cfg.id
    ? CONFIG_PATH
    : "";

/** Is the workstation secret configured at all? */
export function wsConfigured() {
  return Boolean(WS.id);
}

export { CONFIG_PATH as ASK_CONFIG_PATH };

function wsCachePath() {
  if (process.env.WS_SECRET_CACHE) return process.env.WS_SECRET_CACHE;
  const base = process.env.XDG_CACHE_HOME || join(process.env.HOME ?? "", ".cache");
  // A secret id may contain slashes; a filename may not.
  return join(base, "workstation-secrets", `${WS.id.replace(/\//g, "-")}.json`);
}

let wsSecret;

/**
 * The workstation secret as an object, or `{}` if it cannot be read.
 *
 * **Read-only, deliberately.** A fresh cache is reused (that is what makes the
 * common path free); a stale or missing one falls through to AWS, and the
 * result is NOT written back. Writing it would mean getting file modes right on
 * a file holding live credentials, in a second place, and getting that wrong is
 * a worse outcome than one extra `aws` call per run. Whatever populates the
 * cache owns its permissions.
 *
 * Memoised as `{}` on any failure, so a machine with no AWS access pays the
 * timeout once rather than once per candidate key.
 */
export function workstationSecret() {
  if (wsSecret !== undefined) return wsSecret;
  wsSecret = {};

  // Nothing named, nothing to read. Returning early rather than calling `aws`
  // with an empty `--secret-id` is what keeps this free for everyone who does
  // not use it — the alternative is a failed subprocess on every invocation.
  if (!wsConfigured()) return wsSecret;

  const cache = wsCachePath();
  try {
    if (existsSync(cache) && (Date.now() - statSync(cache).mtimeMs) / 1000 <= WS.ttl) {
      const parsed = JSON.parse(readFileSync(cache, "utf8"));
      if (parsed && typeof parsed === "object") return (wsSecret = parsed);
    }
  } catch {
    // A corrupt or unreadable cache is not fatal — go to the source.
  }

  // `--profile` and `--region` are passed only when set, so an unset one falls
  // back to the caller's ordinary AWS configuration rather than being sent as
  // an empty string — which `aws` rejects with an error about the wrong thing.
  const argv = ["secretsmanager", "get-secret-value"];
  if (WS.profile) argv.push("--profile", WS.profile);
  if (WS.region) argv.push("--region", WS.region);
  argv.push("--secret-id", WS.id, "--query", "SecretString", "--output", "text");

  const r = spawnSync("aws", argv, { encoding: "utf8", timeout: 30_000 });
  if (r.status === 0 && r.stdout) {
    try {
      const parsed = JSON.parse(r.stdout);
      if (parsed && typeof parsed === "object") wsSecret = parsed;
    } catch {
      // Not JSON. `--check` reports the absence; there is nothing to salvage.
    }
  }
  return wsSecret;
}

export function fromWorkstationSecret(name) {
  const v = workstationSecret()[name];
  return typeof v === "string" ? v.trim() : "";
}

// ── The login-shell probe ─────────────────────────────────────────────────

/**
 * Read a variable from a fresh LOGIN shell.
 *
 * This is the escape from the stale-process trap: a long-lived process captured
 * its environment at start, so a key the user has since added to their profile
 * is invisible to it — and a key they have since REMOVED is still present and
 * still overriding. Asking a fresh shell gets what a new terminal would see.
 *
 * `-ic`, INTERACTIVE, not `-lc`. The standard `~/.bashrc` preamble returns
 * early for non-interactive shells, so anything exported below that guard is
 * invisible to `bash -lc`, to scripts, to CI, and to any agent.
 *
 * The marker matters, and is bounded at BOTH ends. `-i` means the profile's
 * banner lands on stdout; an open-ended match swallows it, and an earlier
 * version of this returned a 3,800-character "key" that was mostly banner.
 */
export function fromLoginShell(name) {
  const shell = /(^|\/)(zsh|bash)$/.test(process.env.SHELL ?? "")
    ? process.env.SHELL
    : "bash";
  const r = spawnSync(shell, ["-ic", `printf '<<<K>>>%s<<<E>>>' "$${name}"`], {
    encoding: "utf8",
    timeout: 60_000,
  });
  const m = /<<<K>>>([\s\S]*?)<<<E>>>/.exec(r.stdout ?? "");
  return m ? m[1].trim() : "";
}

// ── Identity ──────────────────────────────────────────────────────────────

/**
 * A credential's identity, printable. Never a prefix of the credential itself.
 *
 * `--check` output lands in scrollback, in CI logs and in agent transcripts. A
 * fingerprint still answers the only question asked of it — is this the same
 * credential as before — without putting live bytes anywhere they can be read.
 */
export const fingerprint = (secret) =>
  createHash("sha256").update(secret).digest("hex").slice(0, 12);

// ── The resolver ──────────────────────────────────────────────────────────

/**
 * Walk labelled sources in order, returning the first candidate that `validate`
 * accepts.
 *
 * Ordered by cost and by trust, and every caller uses the same order for the
 * same reason: the current environment is free, so it wins when it works; a
 * configured secret store is consulted BEFORE any shell probe, because these
 * tools must work in a session that never sourced a profile — which is every
 * agent session and every cron job; the shell probe is last, for a credential
 * exported by hand.
 *
 * `validate` is the vendor's business. Passing `() => true` is legitimate when
 * the only way to validate is the real call — but then say so in `--check`
 * rather than implying a credential was verified.
 *
 * @param {Array<[string, () => string[]]>} sources  [label, () => candidates]
 * @param {(secret: string) => boolean} validate
 * @returns {{secret: string|null, source: string|null}}
 */
export function resolveCredential(sources, validate) {
  for (const [label, candidates] of sources) {
    const hit = candidates().filter(Boolean).find(validate);
    if (hit) return { secret: hit, source: label };
  }
  return { secret: null, source: null };
}

/**
 * A copy of `process.env` with the named variables removed.
 *
 * Vendor CLIs are routinely redirected by inherited variables, and each failure
 * describes something other than itself — a stale key reports "API key not
 * valid" on an account whose OAuth login is fine; an inherited cloud project
 * reports a 403 IAM error naming a project the user never chose. Stripping them
 * makes the tool behave the same in a terminal, an editor and a cron job.
 */
export function strippedEnv(names) {
  const env = { ...process.env };
  for (const n of names) delete env[n];
  return env;
}
