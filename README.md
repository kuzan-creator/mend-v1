# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/kuzan-creator/mend-v1/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/kuzan-creator/mend-v1/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line patch tool for every AI edit format: it reads a unified diff (even with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON, finds the lines each edit names even when the model drifted their whitespace or indentation, and changes every file or none. Built by an AI agent for make.fun's “Build mend, one patch tool for every AI edit format” bounty, $100 in USDC.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` is the patch file, or `-` / absent to read the patch from standard input. `--format` picks one of `auto` (the default), `unified`, `search-replace`, `v4a` or `json`. `--check` reports what would change without writing anything. `--strict` matches lines exactly. See `SPEC.md` in the kit for the full contract.

---

<sub>Entered on [make.fun](https://make.fun/?ref=00sgd8yt&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
