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
// The canonical home of this machine's credentials: AWS Secrets Manager, read
// with an AWS profile. Mirrors the defaults and the cache location of
// `~/.zsh-secrets.zsh` so the two cannot disagree about where a key lives, and
// honours the same WS_SECRET_* overrides — which is also how a machine with a
// different account (a work laptop) points this at its own secret, or opts out
// entirely by pointing it at nothing.

export const WS = {
  id: process.env.WS_SECRET_ID || "workstation/nehsa",
  profile: process.env.WS_SECRET_PROFILE || "hopperguard",
  region: process.env.WS_SECRET_REGION || "us-west-2",
  ttl: Number(process.env.WS_SECRET_TTL || 43_200),
};

function wsCachePath() {
  if (process.env.WS_SECRET_CACHE) return process.env.WS_SECRET_CACHE;
  const base = process.env.XDG_CACHE_HOME || join(process.env.HOME ?? "", ".cache");
  // `${WS_SECRET_ID:gs_/_-_}` in the zsh original: slashes become dashes.
  return join(base, "workstation-secrets", `${WS.id.replace(/\//g, "-")}.json`);
}

let wsSecret;

/**
 * The workstation secret as an object, or `{}` if it cannot be read.
 *
 * **Read-only, deliberately.** A fresh cache is reused (that is what makes the
 * common path free); a stale or missing one falls through to AWS, and the
 * result is NOT written back. Writing it would duplicate `load-secrets`'
 * 0600-dir-and-file handling in a second language, and getting file modes wrong
 * on a file holding live credentials is a worse outcome than one extra `aws`
 * call per run.
 *
 * Memoised as `{}` on any failure, so a machine with no AWS access pays the
 * timeout once rather than once per candidate key.
 */
export function workstationSecret() {
  if (wsSecret !== undefined) return wsSecret;
  wsSecret = {};

  const cache = wsCachePath();
  try {
    if (existsSync(cache) && (Date.now() - statSync(cache).mtimeMs) / 1000 <= WS.ttl) {
      const parsed = JSON.parse(readFileSync(cache, "utf8"));
      if (parsed && typeof parsed === "object") return (wsSecret = parsed);
    }
  } catch {
    // A corrupt or unreadable cache is not fatal — go to the source.
  }

  const r = spawnSync(
    "aws",
    [
      "secretsmanager", "get-secret-value",
      "--profile", WS.profile,
      "--region", WS.region,
      "--secret-id", WS.id,
      "--query", "SecretString",
      "--output", "text",
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
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
 * same reason: the current environment is free and is what `load-secrets`
 * populates, so it wins when it works; the workstation secret is the canonical
 * home and is consulted BEFORE any shell probe, because these tools must work
 * in a session that never ran `load-secrets` — which is every agent session and
 * every cron job; the shell probe is last, for a credential exported by hand.
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
