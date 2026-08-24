# stonedog-ask

Command-line front ends for the models this fleet uses as a *second opinion* —
one command per vendor, sharing one credential resolver and one usage ledger.

| command | wraps | used for |
|---|---|---|
| `ask-gemini` | `@google/gemini-cli` | whole-repo digests, PRD/plan/diff review |
| `ask-copilot` | `@github/copilot` | the twice-daily brief/wrap cron, one-off questions |

These are **wrappers around vendor CLIs**, not API clients. They call the CLI
you are already entitled to, so a subscription is used rather than a per-token
key wherever the vendor allows it.

## Install

```bash
npm link             # puts ask-gemini and ask-copilot on PATH
ask-gemini --check   # verifies credentials with a real call
ask-copilot --check  # same, plus Copilot entitlement and MCP sources
```

## ask-gemini

```bash
ask-gemini "does a UNION read beat storing both directions?"
ask-gemini --review-prd docs/prd/related-content.md
ask-gemini --review-plan docs/plan.md
ask-gemini --review-diff origin/main
ask-gemini --repo . "where does auth actually get enforced?"
ask-gemini --file a.ts --file b.ts "do these two agree about null?"
ask-gemini --check
```

**Scope is the lever, not patience.** Long, open-ended prompts hang silently for
8+ minutes and return nothing; a short single question answers in 15–20 seconds.
Ask one question, name the file, cap the answer length, and give every call a
timeout.

## Three things these wrappers exist to do

The vendor CLIs do the model call. These wrappers exist for the parts the CLIs
get wrong, all of which were learned by being burned:

1. **`--check` makes a real one-token call.** A valid credential is not an
   entitled one. An earlier version reported *ready* on the strength of an
   unexpired token while every call failed on a discontinued tier — a green
   check that the first real call disproves is worse than no check, because it
   sends you to debug the prompt instead of the account.
2. **The environment is scrubbed before every call.** Several variables silently
   redirect which backend the CLI talks to, and each fails as something else
   entirely (a stale key reports "API key not valid"; an inherited project
   reports a 403 IAM error naming a project nobody chose). A long-lived process
   captured its environment at start, which is why one command works in your
   terminal and fails in an editor or an agent session.
3. **Every call is logged, and the ledger says how it was counted.** Rows land
   in `~/.claude/ai-usage/<vendor>.jsonl`. Gemini reports no usage metadata
   non-interactively, so those counts are a 4-chars-per-token estimate and every
   row carries `estimated: true`. Read them back with `get-gemini-usage`.

## Credentials

`ask-gemini` resolves an API key in this order, stopping at the first Google
actually accepts:

1. the current environment (`GEMINI_API_KEY`, `GOOGLE_API_KEY`)
2. **AWS Secrets Manager** — `workstation/nehsa`, overridable with
   `WS_SECRET_ID` / `WS_SECRET_PROFILE` / `WS_SECRET_REGION`
3. a login-shell probe, for a key someone exported by hand

The secret is consulted *before* any shell probe, deliberately: the tool has to
work in a session that never ran `load-secrets`, which is every agent session
and every cron job. With no key at all the CLI falls back to OAuth, which is the
correct path for an account whose entitlement is intact.

**Never fix a credential failure by putting a key back in a dotfile.**

## ask-copilot

Built for two cron runs rather than for interactive use.

```bash
ask-copilot --brief     # start of day: what is due, what needs me
ask-copilot --wrap      # end of day:   what moved, what slipped
ask-copilot "question"  # one-off
ask-copilot --check     # credentials AND entitlement, one real call
ask-copilot --sources   # which MCP sources are configured
ask-copilot --cron      # print crontab lines for the pair
```

### Why Copilot for this and not Gemini

Copilot CLI is **agentic**. With MCP servers configured it goes and reads mail,
a SharePoint site or an issue tracker *itself*, rather than being handed a blob
something else had to assemble. For a "what does today need" job that is the
whole difference — the alternative is writing and maintaining a connector per
source before any summarising can start.

It is also the reason for the conservative defaults. An agent with tools,
running unattended at 06:45 against a work account, reading mail that other
people wrote, is a different risk from one you are watching. Prompt content is
untrusted input here. `--allow-all-tools` includes shell execution and is off
unless you ask for it.

### The journal is the point

The two runs are the same job seen from both ends, and each appends a dated
Markdown entry to `~/.stonedog-ask/journal/`. Each run is then given the recent
entries back as context.

That loop is what the pair exists for. Nothing in an inbox says *"you have been
ignoring me for four days"* — that fact lives only in the gap between two
summaries, so something has to hold it. Both prompts end with an `## OPEN ITEMS`
block carrying each item's original **first seen** date, and both are told to
carry every still-open item forward with that date intact. Deadlines survive
because they are restated every day until they close, not because a parser
understood them.

Plain Markdown, one file per day, mode 0600 in a 0700 directory — it has to be
readable and fixable by hand at 7am when a cron job has written something wrong.

### Sources

`ask-copilot` does **not** create MCP servers. A mail or SharePoint connector is
an authenticated integration with a consent flow behind it, and a wrapper that
silently wrote one into place would be claiming an authorisation nobody granted.
Configure them with `copilot mcp add` (they land in `~/.copilot/mcp-config.json`).

What this tool does instead is refuse to run without one you named:

```bash
ask-copilot --brief --source mail --source sharepoint
```

A brief with a silently missing source looks exactly like a quiet day. That is
the single most likely way this job lies to you, so it fails loudly instead.

### Credentials

Resolved in the same order as `ask-gemini`, through the same shared module:

1. the environment — `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`
2. the workstation secret (`WS_SECRET_ID`, default `workstation/nehsa`)
3. `gh auth token`
4. a login-shell probe

All three variables are then **stripped** and only the winner is set. They are a
precedence chain, so a stale value in an earlier one silently beats a good value
in a later one — the symptom is "Copilot says I am not entitled" and the cause
is a variable some other tool exported.

For unattended use the token must be a **fine-grained PAT with the "Copilot
Requests" permission**, on an account with a Copilot seat. A token that
authenticates is not a token with Copilot access, which is exactly what
`--check`'s live probe is for.

### Config

`~/.stonedog-ask/copilot.json` — see `copilot.example.json`. The important key is
`copilotArgs`, which replaces the base arguments wholesale.

> **Verify the flag names at install time.** This was written against Copilot
> CLI's documented flags on a machine where the binary is not installed. `-p`,
> `-s`, `--no-ask-user` and `--allow-all-tools` are documented; the per-tool
> grant flag is not verified. Run `copilot --help` on the target machine and put
> corrections in `copilotArgs` rather than patching the script.

## Running it on a schedule

`ask-copilot --cron` prints a ready-to-use schedule for this machine. Pass a
platform to get another one:

```bash
ask-copilot --cron            # linux on Linux, launchd on macOS
ask-copilot --cron linux      # crontab lines
ask-copilot --cron systemd    # systemd user timer (better on a laptop)
ask-copilot --cron macos      # launchd agents
```

### Before you schedule anything

In this order. Each one fails differently, and finding out at 06:45 tomorrow is
the expensive way.

```bash
ask-copilot --check             # credentials AND Copilot entitlement, real call
ask-copilot --sources           # are mail/sharepoint actually configured?
ask-copilot --brief --dry-run   # read the prompt before it runs unattended
ask-copilot --brief             # one real run, watched, before it runs alone
```

### The gotcha that eats an evening: the interpreter

**A scheduler's `PATH` is not your shell's `PATH`.** The shebang is
`#!/usr/bin/env node`, and neither cron nor launchd sources a shell profile — so
under nvm, where `node` lives in a versioned directory only your profile adds,
the job dies with `env: node: No such file or directory` into a log nobody is
watching. That is indistinguishable from a quiet day with nothing to report,
which is the exact failure this whole tool is built to avoid.

`--cron` therefore emits the **absolute** directory of the interpreter currently
running, rather than hoping the scheduler finds one. Check what a scheduler would
actually get before trusting it:

```bash
env -i PATH=/usr/bin:/bin sh -c 'command -v node && node -v'
```

If that prints nothing, the emitted `PATH` is doing essential work. If it prints
a *different version* from `node -v` in your shell — which is the case on the
machine this was written on — you now know your cron job and your terminal are
not running the same Node, and you should pin it deliberately.

### Linux — cron

```bash
ask-copilot --cron linux
crontab -e     # paste
crontab -l     # confirm
```

The emitted block sets `PATH` explicitly, sets `MAILTO=""` so cron does not mail
you twice a day, and appends both streams to `~/.stonedog-ask/journal/cron.log`.

### Linux — systemd user timer (preferred on a laptop)

```bash
ask-copilot --cron systemd     # writes two .service + two .timer files' contents
# split them into ~/.config/systemd/user/ per the header comments, then:
systemctl --user daemon-reload
systemctl --user enable --now ask-copilot-brief.timer ask-copilot-wrap.timer
systemctl --user list-timers 'ask-copilot-*'
```

Two reasons to prefer this to cron:

- **`Persistent=true` runs a missed job once after boot.** Cron simply skips a
  job whose time passed while the machine was off. On a laptop that is the
  difference between a brief most mornings and a brief on the mornings you
  happened to be booted before 06:45.
- **`loginctl enable-linger $USER`** — run this once, or user timers stop the
  moment you log out. It is the single most common reason a user timer "just
  never runs".

### macOS — launchd (preferred)

macOS still has cron, but launchd is the supported mechanism and handles sleep
properly.

```bash
ask-copilot --cron macos       # prints two plists and the commands
# save them to ~/Library/LaunchAgents/com.stonedog.ask-copilot.{brief,wrap}.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.stonedog.ask-copilot.brief.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.stonedog.ask-copilot.wrap.plist
launchctl list | grep ask-copilot
```

To change one, **bootout first** — `bootstrap` on an already-loaded label fails:

```bash
launchctl bootout gui/$(id -u)/com.stonedog.ask-copilot.brief
```

Four things specific to launchd, each of which fails silently:

- **`StartCalendarInterval` takes an ARRAY of dicts, and launchd has no weekday
  range.** Mon–Fri is five separate entries. A single dict with `Weekday` set to
  a range is a common guess that quietly runs on Mondays only.
- **`Weekday` is 0–6 with 0 = Sunday** (7 also works as Sunday). So 1–5 is
  Mon–Fri.
- **launchd runs a missed calendar job once the machine wakes**, where cron skips
  it. This is the main reason to prefer it here.
- **Full Disk Access.** If the job reads Mail, Calendar, or anything else macOS
  protects, grant Full Disk Access to the binary named in `ProgramArguments`
  (System Settings → Privacy & Security). Without it the job runs, exits 0, and
  reads nothing.

### macOS — cron, if you insist

`crontab -e` still works and `ask-copilot --cron linux` emits usable lines. But
`/usr/sbin/cron` needs **Full Disk Access** granted to it specifically, or jobs
fail to read protected locations with no useful error, and Apple has deprecated
the whole mechanism. Use launchd.

### Confirming it actually ran

A scheduler exiting 0 is not evidence that a brief was produced. Check the
artifact, not the exit code:

```bash
ls -l ~/.stonedog-ask/journal/          # did today's file appear and grow?
tail -40 ~/.stonedog-ask/journal/cron.log
grep -c 'OPEN ITEMS' ~/.stonedog-ask/journal/$(date +%F).md
```

An empty or missing journal entry with a clean exit is the signature of the
interpreter problem above, or of a source that was never reachable. `ask-copilot`
exits non-zero on empty output for exactly this reason — but only the file proves
the content is real.

### Timezone

Both schedulers use the machine's local time, and neither re-reads it mid-run.
Cron applies `TZ` from the crontab if set; launchd uses the system timezone.
The journal's day boundary is **local**, deliberately — a UTC boundary falls
mid-afternoon in this timezone and would split one working day across two files.
