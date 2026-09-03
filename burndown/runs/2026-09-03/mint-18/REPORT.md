# mint-18 — docs: how to bootstrap a first release + the tag-creation-actor requirement

Issue: https://github.com/bounded-systems/mint/issues/18
Branch: `claude/burndown-mint-18` (1 commit on top of `main` @ 3e1ef40, not pushed; fix-round checkout at `/tmp/fix/mint-18/mint`, HEAD e621e74)
Patch: `0001-docs-bootstrapping-a-first-release-and-the-tag-creat.patch`

## What changed

| file | change |
| --- | --- |
| `README.md` | +101 lines, two new subsections under **Use**, right after the `mint plan / version / release` block: **`### First release`** (the `mint version` vs `mint release` input invariant, then Path A "by hand" and Path B "by intent" as numbered steps, the end state both reach, and the CI-dispatch variant with dry-run first) and **`### Tag creation under rulesets — the bypass actor`** (the rejection signature, a 2-row table naming the actor per path — the releaser's own account from a checkout vs `github-actions[bot]`/`GITHUB_TOKEN` for the dispatched `release.yml` -> `release-cut.yml` cut — where the bypass list lives, that a dry-run dispatch never pushes, what to do when the push is rejected, and `--no-push` as the deliberate hand-off). |
| `.release/README.md` | +3 lines: pointer to `README.md#first-release`, noting `mint release` reads the manifest, not intents. |
| `.github/workflows/release-cut.yml` | +7 comment lines beside `git config user.name "github-actions[bot]"` naming the actor and the ruleset/bypass requirement. Comment-only; no behaviour change. |
| `.release/first-release-docs.md` | new `bump: patch` intent, per the repo's per-PR intent convention (precedent: the #11 docs change shipped as a patch intent in 0.5.0). |

No code changes. Scout's plan followed in full; its claims re-checked against `mint.mjs`, `plan.mjs`, `intents.mjs`, `release.yml`, `release-cut.yml` and all held.

## Evidence the doc is accurate (exercised, not just read)

Scratch repos driven with the branch's `mint.mjs` (`/tmp/work/mint-18/scratch`):

- Path A: manifest `0.1.0` + hand-written `## 0.1.0` entry, no `.release/` at all -> `mint release --dry-run` previews, `mint release --no-push` creates `v0.1.0` + `v0.1.0.intoto.json`. A second `mint release` refuses: `tag v0.1.0 already exists.`
- Path B: manifest `0.0.0` + `.release/first.md` (`bump: minor`) -> `mint plan` shows `0.0.0 → 0.1.0`; `mint version` bumps, creates `CHANGELOG.md` from nothing, deletes the intent; after commit `mint release` cuts `v0.1.0`.
- Manifest `0.1.0` with no changelog entry -> `mint release: no CHANGELOG.md entry for 0.1.0 — run \`mint version\` first.` (the message quoted in the doc).
- Rejected push (remote unreachable, same code path as a ruleset rejection): tag and `.intoto.json` are left locally, `mint release` exits 1, re-running refuses because the tag exists -> the doc's "push the tag yourself, don't re-run" guidance is what the code does.
- `release-cut.yml`: the `Cut and push the tag` step has `if: ${{ !inputs.dry-run }}` and pushes with the checkout's `GITHUB_TOKEN` after `git config user.name "github-actions[bot]"` -> the doc's actor table and "a dry run never pushes" claim.

## Verify output (trimmed)

```
$ npm test
# tests 32
# pass 32
# fail 0

$ node mint.mjs plan --date 2026-09-03        # the new intent parses
mint plan — 0.8.0 → 0.8.1  (patch, 1 intent)
## 0.8.1 — 2026-09-03
### Patch
- docs: how to bootstrap a first release (by hand or by intent), and which actor must be on the ruleset bypass list for the tag push (#18)

$ grep -qi 'first release' README.md && grep -qi 'bypass' README.md && grep -qi 'no-push' README.md \
  && grep -qi 'github-actions\[bot\]\|GitHub Actions' README.md && npm test --silent && echo OK
OK

$ python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release-cut.yml'))"   # still valid YAML
yaml ok
```

The repo has no lint/typecheck script; `npm test` (`node --test`) is its only check. Note: `npm ci` was blocked in the sandbox (registry 403 through the egress policy), so `zod@4.4.3` (exact lockfile version) and `semver@7.7.4` (lockfile wants 7.8.5, `^7.6.0`) were symlinked into `node_modules/` from local copies to run the suite; `node_modules/` is gitignored and not in the patch.

## Unresolved

1. **Claim not made.** `CLAUDE.md` requires claiming the issue via `claim-ticket.yml` in `bounded-systems/.github` (or assign + comment by hand). The sandbox has no GitHub credentials and no `gh`; `.claude/org-repair.sh` reported `ORG_BOOT_SHA256 unset — not a bounded-systems cloud session; nothing to do`. The claim window was down for this run; whoever applies the patch should claim #18 first.
2. **Ruleset bypass semantics could not be reproduced.** No org access in the sandbox and docs.github.com is blocked by the egress policy. The wording therefore states the mechanism (bypass list; `Cannot create ref due to creations being restricted` verbatim from the issue) and hedges the one point I could not confirm: whether a given ruleset's bypass picker can list the GitHub Actions identity used by `GITHUB_TOKEN`. The doc says "add it if the picker offers it; if it cannot be listed, narrow the rule or cut from a checkout as a bypass-listed human". A maintainer with org admin should check the bypass dialog once and either tighten that sentence or leave the hedge.
3. **The intent is optional.** It follows the #11 precedent for docs, but an unconsumed intent makes `release-cut.yml` refuse the next cut until `mint version` runs — which is the intended flow. If maintainers consider this "mint's own plumbing" (as with 6cae138), drop `.release/first-release-docs.md` from the patch.

## Before merging (owner)

- [ ] **Claim #18** before opening the PR: dispatch `claim-ticket.yml` in `bounded-systems/.github`, or assign yourself + comment by hand and note the claim window was down. The repo's `pr-claim` check fails any PR whose `Fixes #18` names an unclaimed issue (verdict-B must_fix). Sandbox had no GitHub credentials, so this was not done here.
- [ ] Open the PR from the branch; the commit subject no longer carries `(#18)` so the squash-merge PR number is the only suffix.
- [ ] With org admin, check once whether the ruleset bypass picker can list the GitHub Actions identity used by `GITHUB_TOKEN`, and tighten or keep the hedged sentence in README "Tag creation under rulesets".
- [ ] Decide whether to keep `.release/first-release-docs.md` (per #11/#49 precedent) or drop it as mint's own plumbing (cf. 6cae138).

## Ready-to-paste GitHub comment

```
Docs for both halves of this are in a patch on branch `claude/burndown-mint-18` (one commit on main@3e1ef40, no code changes; docs and comments only):

- README **Use → "First release"**: the invariant (`mint version` reads intents + writes the version; `mint release` reads only the manifest version and needs a `## <version>` CHANGELOG entry, never `.release/`), then Path A by hand (set `0.1.0`, write the entry, commit, `mint release --dry-run`, `mint release`) and Path B by intent (`0.0.0`, `.release/first.md` with `bump: minor`, `mint version`, commit, release), plus the CI-dispatch variant.
- README **"Tag creation under rulesets — the bypass actor"**: the `Cannot create ref due to creations being restricted` rejection, a table naming the actor per path (your own account from a checkout; `github-actions[bot]` via `GITHUB_TOKEN` for the dispatched cut — not whoever clicked Run workflow), that a dry-run dispatch never pushes, that a rejected push leaves the tag + provenance locally so the fix is `git push origin v0.1.0` (not re-running `mint release`), and `--no-push` as the deliberate hand-off.
- Pointer from `.release/README.md`, a comment beside the push in `release-cut.yml`, and a patch intent.

Both bootstrap paths were exercised against scratch repos; `npm test` is green (32/32).
Apply: `git am 0001-docs-bootstrapping-a-first-release-and-the-tag-creat.patch`. One thing to eyeball with org admin: whether the ruleset bypass picker can list the Actions identity — the doc hedges that sentence.
```

## Fix round

Verdicts A and B both returned `refuted: false` with high confidence. must_fix items:

1. **verdict-B: claim issue #18 before opening the PR** — PROCESS item (needs GitHub credentials the sandbox does not have). Not doable here; recorded as the first item of the "Before merging (owner)" checklist above. verdict-A had no must_fix.

Nits taken while regenerating the patch (single commit amended, history unchanged in shape):

- Commit subject: dropped the trailing `(#18)` so the squash-merge PR number is not doubled up; `Fixes #18` in the body still links the issue (verdict-B nit).
- README Path A sample changelog heading: `## 0.1.0 — 2026-07-08` -> `## 0.1.0 — YYYY-MM-DD` so it does not read as a copy-paste trap (verdict-A nit).

Nits left as-is (owner decisions, listed in the checklist): the bypass-picker hedge, the `release-cut.yml` comment, and whether to keep the intent.

Re-ran on a fresh clone of origin/main (3e1ef40) after `git am`: `npm test` 32/32 (semver 7.7.4 / zod 4.4.3 symlinked, registry blocked), `node mint.mjs plan --date 2026-09-03` -> `0.8.0 → 0.8.1 (patch, 1 intent)`, release-cut.yml still valid YAML, scout verify_command OK. Old patch deleted and regenerated with `git format-patch origin/main..HEAD`.
