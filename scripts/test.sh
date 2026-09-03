#!/usr/bin/env bash
# test.sh — the gate.
#
#   bash scripts/test.sh              # run it
#   bash scripts/test.sh --self-check # must FAIL — proves the suite can
#
# Two tiers, and no third. This is a CLI with no browser surface, so an E2E
# tier here would be a second name for the integration one.
#
#   unit/        the pure logic: precedence, scrubbing, parsing, carry-forward
#   integration/ the two bins as real subprocesses, with fake vendor CLIs
#                first on PATH and a sandboxed HOME
#
# A MISSING TOOL IS A FAILURE, NOT A SKIP. No node, or no bash, means this
# examined nothing — and a run that reports success over an empty set is the
# failure this fleet keeps finding.

set -uo pipefail
cd "$(dirname "$0")/.."

if ! command -v node > /dev/null 2>&1; then
  printf 'test: node is not installed, so NOTHING was tested.\n' >&2
  exit 1
fi

# `node --test` needs the built-in runner; it landed long before the engines
# floor, but say so rather than failing with a confusing usage error.
major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$major" -lt 20 ]; then
  printf 'test: node %s is below the >=20 this package declares.\n' "$(node -v)" >&2
  exit 1
fi

# The login-shell probe spawns $SHELL -ic, and its tests supply their own HOME
# and their own rc file. Without a real bash they would be skipped, and a
# silently skipped tier is what this whole file is written against.
if [ ! -x /bin/bash ]; then
  printf 'test: /bin/bash is absent, so the login-shell probe was NOT tested.\n' >&2
  exit 1
fi

# THE INPUT SET, PRINTED. "0 failed over 0 files" and "0 failed over 6" are the
# same verdict and different facts, and the count is the only thing that shows
# a glob stopped matching.
files=$(find tests -name '*.test.mjs' | sort)
n_files=$(printf '%s\n' "$files" | grep -c . )
if [ "$n_files" -eq 0 ]; then
  printf 'test: no *.test.mjs files were found — the glob is wrong.\n' >&2
  exit 1
fi

plant() {  # plant <label> <file> <sed-expression> <test-name-that-must-go-red>
  label=$1 file=$2 expr=$3 want=$4
  tmp=$(mktemp -d) || return 1
  # A COPY, so a self-check can never leave the working tree modified — the
  # failure mode of every in-place plant.
  cp -R . "$tmp/repo" 2>/dev/null
  rm -rf "$tmp/repo/.git"
  sed -i.bak "$expr" "$tmp/repo/$file"
  out=$(cd "$tmp/repo" && node --test $(find tests -name '*.test.mjs' | sort) 2>&1)
  rc=$?
  rm -rf "$tmp"
  # No pipes around the match. `printf | grep -q` hands printf an EPIPE the
  # moment grep matches, and with `set -o pipefail` the pipeline then reports
  # failure for a correctly-caught plant.
  case "$out" in *"$want"*) matched=1 ;; *) matched=0 ;; esac
  if [ "$rc" -ne 0 ] && [ "$matched" -eq 1 ]; then
    printf '  [self-check] %-42s caught, and %s went red. Correct.\n' "$label" "$want"
    return 0
  fi
  # Say WHICH of the two ways this went wrong: they need opposite responses.
  if [ "$rc" -eq 0 ]; then
    printf '  [self-check] %-42s the suite PASSED with the defect planted — IT PROVES NOTHING.\n' "$label" >&2
  else
    printf '  [self-check] %-42s suite failed (rc=%s) but %s was not among the failures.\n' "$label" "$rc" "$want" >&2
  fi
  return 1
}

if [ "${1:-}" = "--self-check" ]; then
  # THE CONTROL, FIRST. Does the UNMODIFIED copy pass?
  #
  # Not ceremony. The first version of this harness invoked the runner wrongly,
  # so every plant "failed" for a reason that had nothing to do with the planted
  # defect — six confusing results that read as six broken guards. A control run
  # says "the harness is wrong" in one line instead.
  control=$(mktemp -d) || exit 1
  cp -R . "$control/repo" 2>/dev/null
  rm -rf "$control/repo/.git"
  control_out=$(cd "$control/repo" && node --test $(find tests -name '*.test.mjs' | sort) 2>&1)
  control_rc=$?
  rm -rf "$control"
  if [ "$control_rc" -ne 0 ]; then
    printf '  [self-check] the CONTROL failed: an unmodified copy does not pass.\n' >&2
    printf '               Nothing below would mean anything. Last lines:\n' >&2
    printf '%s\n' "$control_out" | tail -15 >&2
    exit 1
  fi
  printf '  [self-check] control: an unmodified copy passes.\n\n'

  # One plant per thing this suite exists to catch, and each must be caught BY
  # NAME. A plant caught by some other test proves the suite is noisy, not that
  # the guard works.
  fails=0

  plant "resolver walked in the wrong order" lib/credentials.mjs \
    's/for (const \[label, candidates\] of sources)/for (const [label, candidates] of [...sources].reverse())/' \
    'a later source never overtakes an accepted earlier one' || fails=$((fails + 1))

  plant "backend-hijacking vars no longer stripped" bin/ask-gemini \
    's/"GOOGLE_CLOUD_PROJECT",/ /' \
    'strips the variables that silently redirect the backend' || fails=$((fails + 1))

  plant "the live key is printed, not fingerprinted" lib/credentials.mjs \
    's/createHash("sha256").update(secret).digest("hex").slice(0, 12)/secret/' \
    'never prints the key itself, only a fingerprint' || fails=$((fails + 1))

  plant "carry-forward returns nothing without a marker" lib/journal.mjs \
    's/return m ? text.slice(m.index).trim() : text.trim();/return m ? text.slice(m.index).trim() : "";/' \
    'it returns the whole entry rather than nothing' || fails=$((fails + 1))

  plant "cron emits a bare node instead of a path" bin/ask-copilot \
    's|const cronPath = `${nodeDir}:/usr/local/bin:/usr/bin:/bin`;|const cronPath = "/usr/local/bin:/usr/bin:/bin";|' \
    'emits the directory of the interpreter that ran it' || fails=$((fails + 1))

  plant "a missing source no longer stops the run" bin/ask-copilot \
    's/^function requireSources(names) {/function requireSources(names) { return;/' \
    'stops the run instead of producing a brief about nothing' || fails=$((fails + 1))

  # The 44-hour orphan (2026-08-27). Signalling the direct child only, with an
  # ignorable signal, is both the original defect and the shape any "simplify
  # this back to spawnSync" change would restore.
  plant "timeout signals the child, not the group" lib/run-cli.mjs \
    's/process.kill(-child.pid, "SIGKILL");/child.kill("SIGTERM");/' \
    'the grandchild survived the timeout' || fails=$((fails + 1))

  # The same bug one layer up: a process that escapes the group with setsid()
  # keeps the inherited stdout, so `close` never fires. Without the grace
  # teardown the call waits forever — which is what the timeout exists to stop.
  plant "no grace teardown after the group kill" lib/run-cli.mjs \
    's/      graceTimer = setTimeout(() => {/      graceTimer = setTimeout(() => { if (true) return;/' \
    'an escapee cannot hang the call' || fails=$((fails + 1))

  # The same orphan through the interrupt door. `detached` takes the vendor
  # tree out of the terminal's foreground group, so without the forwarding
  # handler a Ctrl-C kills the wrapper and leaks the grandchild — which is the
  # path people actually use on a slow call.
  plant "an interrupt no longer reaches the group" lib/run-cli.mjs \
    's/    for (const s of SIGNALS) process.once(s, onSignal);/ /' \
    'the grandchild survived the interrupt' || fails=$((fails + 1))

  # Per-chunk decoding of a pipe's Buffers. Silent corruption of the answer,
  # which is worse than a loud failure and invisible below ~64KiB.
  plant "multibyte decoded per chunk, not per stream" lib/run-cli.mjs \
    's/    child.stdout.setEncoding("utf8");/ /' \
    'a multibyte character was corrupted at a chunk boundary' || fails=$((fails + 1))

  if [ "$fails" -eq 0 ]; then
    printf '\n  [self-check] 10 of 10 plants were caught by name. Correct.\n'
    exit 0
  fi
  printf '\n  [self-check] %s of 10 plants went UNCAUGHT.\n' "$fails" >&2
  exit 1
fi

printf 'test: %s test file(s), node %s\n' "$n_files" "$(node -v)"

# The files are passed EXPLICITLY, not as a directory. `node --test tests/`
# resolves the path as a module on this runtime and dies with MODULE_NOT_FOUND,
# which reads as a broken test rather than a broken invocation. Passing the
# list also makes the count printed above and the set actually run the same
# thing, which is the point of printing it.
log=$(mktemp) || exit 1
# shellcheck disable=SC2086
node --test $files "$@" 2>&1 | tee "$log"
rc=${PIPESTATUS[0]}

# HOW MANY ASSERTIONS ACTUALLY RAN.
#
# `fail 0` is not the interesting number. Measured on this runtime: skipping a
# whole `describe` does NOT report `skipped 7` — the seven tests disappear from
# the total and the summary reads `tests 69 · pass 69 · fail 0 · skipped 0`,
# which is indistinguishable from a healthy run. A count that only ever moves up
# is therefore the one signal that a tier stopped existing.
#
# Raise MIN_TESTS when you add tests. It is a floor, not an equality: it exists
# to catch assertions VANISHING, and a floor nobody updates still does that.
MIN_TESTS=87

# awk on FIELDS, not a regex with a character class. The runner prefixes each
# summary line with a multibyte glyph (`ℹ tests 76`), and `[^0-9a-zA-Z]*` does
# not match it under a UTF-8 locale on this sed — the extraction came back empty
# and the guard "passed" by never having a number to compare. Field position is
# the same on both the `ℹ` output and node 20's TAP-ish `# tests 76`.
ran=$(awk 'NF >= 2 && $(NF-1) == "tests" { v = $NF } END { print v }' "$log")
skipped=$(awk 'NF >= 2 && $(NF-1) == "skipped" { v = $NF } END { print v }' "$log")
rm -f "$log"

if [ -z "${ran:-}" ]; then
  printf '\ntest: could not read the test count from the runner output.\n' >&2
  printf '      Refusing to report a pass over a number nobody read.\n' >&2
  exit 1
fi

if [ "$ran" -lt "$MIN_TESTS" ]; then
  printf '\ntest: %s assertion(s) ran, but at least %s were expected.\n' "$ran" "$MIN_TESTS" >&2
  printf '      Tests did not fail — they stopped existing. A skipped describe\n' >&2
  printf '      removes its tests from the total and still prints `fail 0`.\n' >&2
  printf '      If you deliberately removed tests, lower MIN_TESTS in this file.\n' >&2
  exit 1
fi

if [ -n "${skipped:-}" ] && [ "$skipped" -gt 0 ]; then
  printf '\ntest: %s test(s) were SKIPPED. Inside the gate that is a failure —\n' "$skipped" >&2
  printf '      every conditional skip here has a precondition this script already\n' >&2
  printf '      enforces, so a skip means a tier stopped running silently.\n' >&2
  exit 1
fi

printf 'test: %s assertion(s) ran (floor %s), %s skipped.\n' "$ran" "$MIN_TESTS" "${skipped:-0}"
exit "$rc"
