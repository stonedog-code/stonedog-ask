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
- **A timeout must end the process GROUP, not the direct child.** A hung call
  held 22 GiB for 44 hours after its timeout fired and reported correctly:
  `spawnSync` signals only the child, the vendor CLI re-execs into a
  raised-heap grandchild, and that grandchild is orphaned onto `systemd --user`.
  Every vendor-CLI call goes through `lib/run-cli.mjs`. Do not "simplify" it
  back to `spawnSync` — the seventh self-check plant exists to catch exactly
  that.

**The gate is `npm test`** — 85 assertions over two tiers (unit + the bins as
real subprocesses), no network, no AWS, no entitlement. `npm run test:self-check`
plants eight real defects and requires each to be caught by name; it runs a control
first, because a harness that is itself broken reports every guard as broken.

**Every test needs a sandboxed `HOME`, not just a faked `PATH`.** `fromLoginShell`
spawns `$SHELL -ic`, which sources the rc file of whatever `HOME` it is given —
so an unsandboxed test reads the developer's real credentials and an rc file that
resets `PATH` escapes the fake binaries. `tests/support/sandbox.mjs` is the only
correct way to run anything that can reach the credential chain.
