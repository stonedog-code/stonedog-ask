# stonedog-ask

`ask-gemini` and `ask-copilot` — thin wrappers around the vendor CLIs, sharing
one credential resolver (`lib/credentials.mjs`) and one usage ledger. They call
the CLI you are already entitled to; they are not API clients.

Three things here are load-bearing, and each was learned by being burned —
`README.md` has the full account:

- **`--check` makes a real one-token call.** A valid credential is not an
  entitled one, and a green check the first real call disproves is worse than no
  check: it sends you to debug the prompt instead of the account.
- **The environment is scrubbed before every call.** Several variables silently
  redirect which backend the CLI talks to, and each fails as something else.
- **Nothing about this machine is in the repository.** The secret store is off
  unless `~/.stonedog-ask/config.json` (or `WS_SECRET_ID`) names one. A baked-in
  default would name one machine's AWS account in everybody's checkout.

**No test tier exists yet, and that is the gap to close before this is treated
as finished** — see the open issue. Until then, `node --check` on each bin and a
real `--check` run are the only gate.
