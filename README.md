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

### Setting up the cron

```bash
ask-copilot --check          # credentials, entitlement, sources
ask-copilot --sources        # confirm mail/sharepoint are actually there
ask-copilot --brief --dry-run  # read the assembled prompt before it runs alone
ask-copilot --cron >> /tmp/lines && crontab -e
```

Cron gets almost no environment, which is precisely why the credential resolver
reads the workstation secret directly: a cron job never ran `load-secrets`.
