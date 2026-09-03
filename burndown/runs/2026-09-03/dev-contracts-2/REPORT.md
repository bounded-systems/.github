# dev-contracts-2 — Rework dev-contracts + dismiss false-positive Trunk test-fixture SSH-key leaks

Repo: https://github.com/bounded-systems/dev-contracts — issue #2
Branch: none. After the fix round there is **no patch**: the branch is identical to `main` @ 3f1d3e2.
Clone: `/tmp/fix/dev-contracts-2/dev-contracts`
Patch: none (see "Fix round" below for why the earlier commit was withdrawn).

## What changed

Nothing in the repo. The original round's commit (`chore(trunk): ignore the plugin cache in lint and git`) was withdrawn in full after review:

| Withdrawn change | Why |
|---|---|
| `.trunk/.gitignore` (new file) | Byte-identical resurrection of the file the maintainer deliberately deleted in `fe6d335` ("ignore pattern is working"), the commit that centralised all ignores in `contracts.toml` (`ignores = ["git"]`) and the generated root `.gitignore`. The root `.gitignore` on `main` already ignores `.trunk/plugins/` and `templates/trunk/.trunk/plugins/` (`git check-ignore -v` -> `.gitignore:10` / `.gitignore:16`). Re-adding it silently reversed a design decision and added nothing. |
| `contracts.toml` `[structure.".trunk/.gitignore"]` | Only existed to declare the file above. |
| `.trunk/trunk.yaml` `lint.ignore` block | Addresses a problem the issue never reports. The alerts came from GitHub push scanning of blobs committed in `41f47c4` / `cd4c69b`, not from `trunk check`. The cache paths are gitignored (Trunk honours `.gitignore`) and `.trunk/plugins/trunk` is declared a symlink in `contracts.toml`, so the block is a no-op, and `trunk check` cannot be run in the sandbox to show otherwise. An unverifiable no-op is not mergeable. |

## Re-checked scout claims (still true at `main` @ 3f1d3e2)

- HEAD is clean: `git grep -l "PRIVATE KEY" HEAD` -> nothing (rc=1). Fixture files exist only in history (`cd4c69b`: `.trunk/plugins/trunk/linters/{gitleaks,trivy,trufflehog}/test_data/*.py`); `git ls-files .trunk` lists only `configs/*` and `trunk.yaml`.
- `.trunk/plugins/` and `templates/trunk/.trunk/plugins/` are already gitignored via the generated root `.gitignore` (confirmed with `git check-ignore -v`).
- `contracts.toml` parses (`tomllib`).
- `mise.toml` references `tools/**`, `templates/trunk/**`, `runtimes/**` that do not exist at HEAD — the "broader rework" is real drift, but the issue gives no spec for it; not attempted.

## Verify output (trimmed)

```
$ git log --oneline -1
3f1d3e2 ci: adopt the repaired pr-claim caller (#22)
$ git status --short
(clean)
$ git grep -l "PRIVATE KEY" HEAD ; echo rc=$?
rc=1
$ git check-ignore -v .trunk/plugins/trunk/linters/gitleaks/test_data/basic.py templates/trunk/.trunk/plugins/x.py
.gitignore:10:.trunk/plugins/            .trunk/plugins/trunk/linters/gitleaks/test_data/basic.py
.gitignore:16:templates/trunk/.trunk/plugins/  templates/trunk/.trunk/plugins/x.py
$ git ls-files .trunk
.trunk/configs/.jsonlintrc .trunk/configs/.prettierrc .trunk/configs/.rubocop.yml
.trunk/configs/.standard.yml .trunk/configs/.yamllint.yml .trunk/configs/schema.json
.trunk/trunk.yaml
```

Not runnable here: `trunk check` (get.trunk.io / static.trunk.io blocked) and the repo's deno CI (`registry.npmjs.org` blocked; fails identically on `main`). Neither matters for an empty diff.

## Unresolved

All three acceptance criteria of issue #2 remain open; none can be closed from this sandbox:

1. **Dismiss the 2 secret-scanning alerts as "Used in tests"** — needs GitHub `security_events` credentials (Security -> Secret scanning, or `PATCH /repos/bounded-systems/dev-contracts/secret-scanning/alerts/{n}` with `{"state":"resolved","resolution":"used_in_tests"}`).
2. **History scrub decision** — the issue already says "declined currently"; a maintainer should record the final decision on the issue. Not performed (force-pushing public `main` breaks forks/clones; keys are scanner dummies).
3. **"Broader rework"** — unspecified. `mise.toml` still points at `tools/`, `templates/trunk/`, `runtimes/` trees that no longer exist and `trunk.yaml` still enables Ruby/Python runtimes with `$DEVCONTRACTS_DIR/runtimes/ruby/Gemfile`; needs its own scoped issue before any `.trunk` hygiene can be "integrated" into it.

## Before merging (owner)

There is nothing to merge. If the owner wants to act on this issue:

- [ ] Dismiss the 2 open OpenSSH private key alerts as "Used in tests" under Security -> Secret scanning (requires `security_events` scope).
- [ ] Record the history-scrub decision (currently "declined") as a comment on #2.
- [ ] Open a scoped issue for the `mise.toml` / `tools/` / `templates/trunk/` / `runtimes/` drift and move the "remaining `.trunk` hygiene" checkbox there.
- [ ] Only if a code PR is ever opened for #2: claim the issue via `claim-ticket.yml` first (CLAUDE.md step 2), and reference it with `Claim-issue: bounded-systems/dev-contracts#2` on its own line (not `Closes #2`, since no PR can satisfy the acceptance criteria), otherwise the required `pr-claim` check fails.

## Ready-to-paste GitHub comment

```
Looked at the in-repo side of this from a sandbox (no security_events credentials, no trunk CLI available). Findings, no PR:

- `main` (3f1d3e2) contains no key material: `git grep -l "PRIVATE KEY" HEAD` is empty and `git ls-files .trunk` lists only `configs/*` and `trunk.yaml`. The three fixture files exist only in history (cd4c69b).
- `.trunk/plugins/` and `templates/trunk/.trunk/plugins/` are already ignored by the generated root `.gitignore` (from `contracts.toml`, `ignores = ["git"]`, since fe6d335). `git check-ignore -v` confirms both paths. So there is no in-repo hygiene left to add for this alert; I considered a `.trunk/.gitignore` and a `lint.ignore` block in `trunk.yaml` and dropped both — the first would re-add the file fe6d335 deliberately deleted, and the second targets `trunk check`, which never surfaced these keys (the alerts came from GitHub scanning the committed blobs, and the cache paths are gitignored).

What remains is entirely maintainer-side:
1. Dismiss the 2 alerts as "Used in tests" under Security -> Secret scanning (needs `security_events`).
2. Record the history-scrub decision here (currently declined; the keys are scanner dummies and a force-push would break forks).
3. The "broader rework" has no spec yet: `mise.toml` still references `tools/`, `templates/trunk/` and `runtimes/` trees that do not exist at HEAD, and `trunk.yaml` still enables Ruby/Python runtimes pointing at `$DEVCONTRACTS_DIR/runtimes/`. Suggest a separate scoped issue for that and moving the third checkbox there.
```

## Fix round

Verdicts A (correctness + reproducibility) and B (scope + mergeability) both refuted the original round. Each must_fix and what was done:

| # | must_fix | Type | Action |
|---|---|---|---|
| A1 | `result.json` should report `done:false` (or partial): the patch satisfies zero of the three acceptance criteria. | patch-level (report) | `result.json` now has `"done": false`, `"partial": true`, `"patch_files": []`. |
| A2 | `verify_passed` should be false or qualified: `trunk check` was never run; `git check-ignore` + glob matching were stand-ins. | patch-level (report) | `"verify_passed": false`; the report states what was and was not run. |
| B1 | Drop `.trunk/.gitignore` (and the matching `contracts.toml` entry) or justify reversing fe6d335. | patch-level (code) | Dropped. No justification exists: the root `.gitignore` already covers the paths. |
| B2 | Either show `trunk check` actually reports the fixture keys or drop the `lint.ignore` block. | patch-level (code) | Dropped. It cannot be shown (paths gitignored, cache is a symlink, trunk unobtainable here). |
| B3 | Claim issue #2 via `claim-ticket.yml` and use `Claim-issue: bounded-systems/dev-contracts#2` (not `Refs #2`), never `Closes #2`. | process (credentials) | Moot with no commit; recorded in "Before merging (owner)" for any future PR. |
| B4 | Rewrite the proposed GitHub comment: remove the "surface in `trunk check`" implication; state plainly that `.trunk/.gitignore` re-adds the file deleted in fe6d335. | patch-level (report wording) | Comment rewritten. It no longer proposes either change, says explicitly why both were dropped (fe6d335; `trunk check` never surfaced the keys), and points every remaining item at the maintainer. |

With B1 and B2 both resolved by removal, the branch is empty. The old `0001-*.patch` was deleted and `git format-patch main..HEAD` produced no files. Nits (subject `(#2)` suffix, `(issue #2)` in a purpose string, long comment block, missing `.release/` intent) all concerned the withdrawn commit and no longer apply.
