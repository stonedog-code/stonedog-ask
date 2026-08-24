# stonedog-ask

Command-line front ends for the models this fleet uses as a *second opinion* —
one command per vendor, sharing one credential resolver and one usage ledger.

| command | wraps | used for |
|---|---|---|
| `ask-gemini` | `@google/gemini-cli` | whole-repo digests, PRD/plan/diff review |

These are **wrappers around vendor CLIs**, not API clients. They call the CLI
you are already entitled to, so a subscription is used rather than a per-token
key wherever the vendor allows it.

## Install

```bash
npm link            # or: ln -s "$PWD/bin/ask-gemini" ~/.local/bin/ask-gemini
ask-gemini --check  # verifies credentials with a real call
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
