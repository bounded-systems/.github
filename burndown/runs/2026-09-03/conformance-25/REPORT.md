# conformance-25 — audit: mint-released repo ⇒ release identity can create v* tags (trellis#34)

Branch `claude/burndown-conformance-25` (fix-round clone `/tmp/fix/conformance-25/conformance`), one commit `3206446` on top of `main` (`293dd55`); the fix round was amended into that single commit (never pushed, so no history to preserve). Not pushed. Patch: `0001-audit-release-tag-bypass-check-for-mint-released-rep.patch`.

## What changed

| file | change |
|---|---|
| `scripts/audit/release-tags.ts` (new) | Deno runner, modeled on `scripts/audit/actions.ts`: `gh repo list` → `git/trees` + raw `contents` for workflows/`.release/` → `repos/{o}/{r}/rulesets?targets=tag&includes_parents=true` → per-ruleset detail. Prints a markdown per-repo table (repo, mint-released, tag creation restricted, release-identity bypass, verdict, evidence) + summary. Report-only exit 0; `--strict` exits 1 on FAIL, `--fail-unknown` also on UNKNOWN; `--repo=<name>`; `--release-actor=any\|github-actions\|org-admin\|integration:<id>\|team:<id>\|role:<id>\|deploy-key:<id>`. |
| `scripts/audit/release-tags-lib.ts` (new) | Pure logic: ruleset `ref_name` fnmatch (`*`, `**`, `~ALL`, exclude), `restrictsTagCreation` (active + `creation` rule + covers `refs/tags/v1.0.0`), mint detection (`on: push: tags: [v*]` inline or list form, `.release/`, a line-anchored `uses: bounded-systems/mint/.github/workflows/release-cut.yml`), `scoreRepo` (SKIP/PASS/FAIL/UNKNOWN), table render. `bypass_actors` absent from the response ≠ empty: absent → UNKNOWN (token can't read it), `[]` → FAIL. `bypass_mode: pull_request` never counts. |
| `scripts/audit/release-tags_test.ts` + `scripts/audit/fixtures/{rulesets,repos}.json` (new) | 13 unit tests on fixture JSON in the GitHub ruleset API shape (enterprise/org/repo source, bypass actor types/modes, disabled, exclude `v*`, deletion-only, missing `bypass_actors`). Uses `node:assert` — no new dependency, `deno.lock` untouched (jsr.io is blocked in this sandbox, and it keeps CI lean). |
| `.github/workflows/release-tags-audit.yml` (new) | Two jobs split by credential. `pr` (pull_request, path-filtered): `deno task test:audit` + the audit under `github.token` only (→ UNKNOWN rows for restricted repos). `org` (schedule + workflow_dispatch, default-branch code): mints the org-admin App token exactly as `open-prs.yml` does (`vars.ORG_ADMIN_APP_ID` / `secrets.ORG_ADMIN_APP_PRIVATE_KEY`) and runs the audit into the step summary. PR-modified code never runs with the admin credential. `set -o pipefail` explicit in both `tee` steps. All actions SHA-pinned to the same revs as `actions-audit.yml`; harden-runner, `persist-credentials: false`. |
| `deno.json` | tasks `audit:release-tags`, `audit:release-tags:strict`, `test:audit`. |
| `README.md` | Row in the audit-vs-gate table; new "Release-tag bypass (mint-released repos)" section (columns, CLI, release-identity note, token scope); layout bullets. |
| `cspell.json` | `fnmatch` added to `words`; `scripts/audit/fixtures/**` added to `ignorePaths` (YAML-in-JSON strings would tokenize as `\njobs` etc.). |

### GH_TOKEN scope (documented in the script header, workflow header and README)
- Repo enumeration, trees, contents, and the rulesets **list** (`?targets=tag&includes_parents=true`): default token / `contents: read`.
- `bypass_actors` is only returned to a token with **write access to the ruleset**: `admin:org` (the org-admin App `scripts/audit.mjs` / `open-prs.yml` use) for org rulesets; **enterprise owner** for the enterprise-level `refs/tags/*` ruleset trellis#34 describes. Without it, every restricted repo scores `UNKNOWN`, never a false `PASS`.

## Verify output (trimmed — full log in `verify.log`)

```
$ deno fmt --check scripts/audit/ && deno lint scripts/audit/ && deno check scripts/audit/*.ts
Checked 6 files / Checked 4 files / (typecheck ok)

$ deno test --allow-read scripts/audit/          # 13 tests (deno task test:audit)
ok | 13 passed | 0 failed (9ms)

$ deno task audit:release-tags                   # gh = offline fixture shim (fake-gh.py)
| repo | mint-released | tag creation restricted | release-identity bypass | verdict | evidence |
| docs-site | no | - | n/a | SKIP | no v* tag-triggered workflow / .release/ |
| drift-gate | yes | yes | unknown | UNKNOWN | .github/workflows/publish-jsr.yml (on: push: tags: v*); enterprise ruleset "Restrict tag creation" (#9001, bounded): restricts creation; bypass_actors NOT VISIBLE to this token; organization ruleset "release-tags" (#42, ...): ... bypass via Integration#15368(always) |
| guest-room | yes | no | n/a | PASS | .github/workflows/release.yml (on: push: tags: v*); no tag rulesets apply |
| mint | yes | yes | no | FAIL | .release/ (mint intents); .github/workflows/release.yml (on: push: tags: v*); enterprise ruleset "Restrict tag creation" (#9001, bounded): restricts creation; NO release-identity bypass (actors: none) |
Summary: PASS=1 FAIL=1 UNKNOWN=1 SKIP=1 (mint-released: 3)
Report-only: exit 0.

$ scout verify_command (grep for a PASS/FAIL row)   → exit 0
$ ... --strict --release-actor=github-actions        → "--strict: 1 violations." exit 1
```

Sanity check: `classifyMintReleased` run over a real clone of `bounded-systems/mint` → `mintReleased: true`, evidence `.release/ (mint intents)`, `.github/workflows/release.yml (on: push: tags: v*)` (the commented example in mint's `release-cut.yml` header is correctly *not* counted).

Notes on the local run: `deno test` was run with `--no-npm --node-modules-dir=none` because `registry.npmjs.org` is blocked here and `nodeModulesDir: "auto"` otherwise tries to vendor drift-gate's deps at startup; the plain `deno task test` works wherever `deno task gate` does. cspell could not be run (npm blocked); tokens were reviewed by hand and the two cspell changes cover the new terms.

## Unresolved

1. **Live org findings not produced.** The sandbox has no GitHub credentials and `api.github.com` is blocked, so the per-repo table above is from a fixture shim, not the org. The owner must run `GH_TOKEN=<org-admin App token> deno task audit:release-tags` (or dispatch `release-tags-audit.yml`) to get the real table; expect the enterprise-level ruleset to show `UNKNOWN` unless the token is an enterprise owner.
2. **Release identity is a CLI argument, not a declared contract.** trellis#34 (open) has not settled where a repo declares its release identity. Default `--release-actor=any` accepts any `always` bypass actor and lists them as evidence; `--release-actor=github-actions` (Integration#15368, the identity behind mint's `release-cut.yml` CI cut) is the likely strict setting. Once trellis lands the `repo-config` node, wire it in place of the flag.
3. **Report-only, not yet a blocking gate.** Mirrors how `actions-audit.yml` was promoted: flip the workflow to `audit:release-tags:strict` once the live baseline is clean.
4. **Not claimed / bootstrap not run.** CLAUDE.md's `org-repair.sh` + `claim-ticket.yml` steps need org credentials; the issue is unclaimed. The commit now carries `Closes #25` so `pr-claim` passes once the claim exists (see "Before merging (owner)").
5. **Detection is heuristic** (tag-triggered workflow / `.release/` / release-cut caller); a repo with a differently-shaped release trigger would SKIP.

## Ready-to-paste issue comment

```
Patch for this (branch `claude/burndown-conformance-25`, one commit): a Deno audit `scripts/audit/release-tags.ts` implementing the trellis#34 contract.
Per repo it detects mint-released (workflow on `push: tags: [v*]`, `.release/`, or a mint `release-cut.yml` caller), reads `repos/{o}/{r}/rulesets?targets=tag&includes_parents=true` + each ruleset's detail, and scores: PASS (no active `creation` rule covers `refs/tags/v*`, or every restricting ruleset has an `always` bypass for the release identity), FAIL (visible restriction, no bypass), UNKNOWN (`bypass_actors` not readable with this token), SKIP (not mint-released) — as a markdown table with evidence (workflow path, ruleset id/name/source, actor list).
`--release-actor` picks the identity (`any` default while trellis#34 is open; `github-actions` = Integration#15368 for the release-cut path; `org-admin`, `integration:<id>`, `team:<id>`, …). Report-only; `--strict` exits 1 on FAIL. 13 unit tests on fixture JSON of the ruleset API shape. Workflow `release-tags-audit.yml` has two jobs: `pr` runs PR code with `github.token` only; `org` (schedule/dispatch, default branch) mints the org-admin App token like `open-prs.yml` — the admin credential never touches a pull_request job.
Token scope: the rulesets list needs only contents:read, but `bypass_actors` needs write access to the ruleset (admin:org for org rulesets; enterprise owner for the enterprise-level refs/tags/* one) — otherwise rows are UNKNOWN, never a false PASS.
Apply: `git am 0001-audit-release-tag-bypass-check-for-mint-released-rep.patch && deno task test:audit && GH_TOKEN=<org-admin token> deno task audit:release-tags` (note `deno task` resolves drift-gate's npm deps first because of `nodeModulesDir: auto`, so it is not network-free; the tests themselves are).
Not run against the live org here (no credentials) — please paste the resulting table back to this issue / trellis#34.
```

## Before merging (owner)

- [ ] Run `bash .claude/org-repair.sh` (CLAUDE.md step 1) — needs the environment-dialog `$ORG_BOOT_SHA256`.
- [ ] Claim issue #25 via `claim-ticket.yml` in `bounded-systems/.github` (or assign yourself + comment noting the window was down). Issue is currently open, unassigned, unlabeled; the required `pr-claim` check fails until it carries a claim.
- [ ] Open the PR with `Closes #25` in the body (the commit already carries the `Closes #25` trailer).
- [ ] Run the live audit once with org-admin credentials: `GH_TOKEN=<org-admin App token> deno task audit:release-tags` (or dispatch `release-tags-audit.yml` → `org` job) and paste the per-repo table into the PR body and trellis#34. Expect the enterprise-level `refs/tags/*` ruleset to read `UNKNOWN` unless the token is an enterprise owner.
- [ ] Let CI run cspell (not runnable offline here); `fnmatch` was added and fixtures are ignored, but new prose words were only hand-checked.
- [ ] After the live baseline is clean, promote the `org` job (and/or the `pr` job) to `audit:release-tags:strict` so the check is blocking, as the issue's "caught by the gate" wording asks.

## Fix round

Verdict-A: no must_fix. Verdict-B must_fix:

1. **Admin App token minted in a pull_request job** (must_fix, patch-level) — DONE. `release-tags-audit.yml` split into `pr` (`if: github.event_name == 'pull_request'`, `github.token` only, no `create-github-app-token` step) and `org` (`if: github.event_name != 'pull_request'`, i.e. schedule + workflow_dispatch from the default branch, the only job that mints the App token). Verified by parsing the YAML: the `pr` job has no app-token step. Workflow header rewritten to document the split; the incorrect "fork PRs fall back to github.token" claim is gone.
2. **Claim #25 + `Closes #25`** (must_fix, half patch-level / half process) — commit message amended to carry a `Closes #25` trailer (patch-level, done). Claiming the issue via `claim-ticket.yml` / `org-repair.sh` needs org credentials this sandbox does not have → listed under "Before merging (owner)". Because of that, `result.json` is marked `partial: true`.

Nits also addressed:
- `binaries.yml` (not a mint workflow file) removed from README.md, `release-tags.ts` and `release-tags-lib.ts` headers; they now name only `release.yml` / `publish-jsr.yml`, as the issue does.
- `deno.json` task `test` renamed `test:audit` (README, workflow updated).
- `TAG_TRIGGER_INLINE` / `TAG_TRIGGER_LIST` tightened from `v\*?` to `v\*` so a concrete `tags: [v1.2.3]` no longer counts as a `v*` trigger; the 13 tests still pass.
- `set -o pipefail` made explicit (with `shell: bash`) before the `deno task ... | tee` steps.
- Ready-to-paste comment: `deno task test` → `deno task test:audit`, notes the `nodeModulesDir: auto` network caveat, and describes the two-job workflow.

Not changed: the check stays report-only (both verdicts accept the actions-audit promotion precedent); promotion to `--strict` is on the owner checklist.

Re-ran in a fresh clone (`/tmp/fix/conformance-25/conformance`, `git am`, fixes amended into `3206446`): `deno fmt --check` / `deno lint` / `deno check` on `scripts/audit/` clean; `deno test --no-npm --node-modules-dir=none --allow-read scripts/audit/` → 13 passed; runner under `fake-gh.py` → same SKIP/UNKNOWN/PASS/FAIL table, scout verify grep exit 0; `--strict --release-actor=github-actions` → exit 1 (1 violation). Old patch deleted and regenerated with `git format-patch origin/main..HEAD`; re-applied cleanly to a second fresh clone. Full log in `verify.log`.
