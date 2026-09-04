# gpr-10 — Wire window-burn metering (consumedPoints per window)

Issue: https://github.com/bounded-systems/gh-project-room/issues/10 (open, part of epic #5)
Branch: `claude/burndown-gpr-10` on top of `main` @ `f28b2b2` (not pushed)
Patch: `0001-feat-budget-wire-window-burn-metering-consumedPoints.patch` (1 commit, 8 files, +452/−25)

**Scope:** this lands the meter and the `--ledger` seam. It does **not** close #10 — the issue asks for real per-window burn wired in via the telemetry/OTLP source, which is not yet filed in this repo, and no caller of `front-desk-budget.yml` supplies a ledger today, so production behaviour is unchanged (unmetered, fail-open) until an emitter exists. The commit carries `Refs #10` + `Claim-issue: bounded-systems/gh-project-room#10` (no `Closes`).

## What changed

| File | Change |
| --- | --- |
| `window-meter.ts` (new) | Pure, dependency-free meter. `UsageSample {at, points}`, `windowStart(window, now, anchor=0)` (rolling: `now − duration`; calendar: last boundary at/before `now`, boundaries every `durationHours` from `anchor`, default Unix epoch), `consumedPoints(window, samples, now, anchor)` (sum of samples with `windowStart <= at <= now`; future samples ignored), `unitsToPoints(units, conversion)` (tokens → points), `meterBudget(budget, samples, now, planned)` (= `planCapacity` with the live-burn axis filled in). Clock is a parameter — no `Date.now()`. |
| `window-meter_test.ts` (new) | 8 tests, fixed epoch-ms clock. **Verify criterion:** rolling 5h window accumulates 1→3→6 and slides samples out at 5h+1ms / 6h+1ms / 7h+1ms; calendar 168h window accumulates 4→10→15, resets to only the boundary sample (2) at the boundary instant, then 9, then 0 in the following week. Plus future-sample/order, empty ledger, `unitsToPoints`, `meterBudget`. |
| `budget-check.ts` | New optional `--ledger <path>`: JSON array of `{at, points}` / `{at, units}` (`at` epoch ms or ISO-8601; `units` folded through the budget's conversion). Decision extracted into exported pure `evaluate({budgetId, aboutToSpend, samples?, now})` + `parseLedger(json, budget)`. Existing flags / exit codes (0 allow, 1 block, 2 usage) unchanged. No ledger, unknown budget, or unreadable ledger → `consumedPoints = 0`, static envelope only (same fail-open posture as before, now logged as a `(warn)` line). The `#10 not yet wired` comments are gone. |
| `budget-check_test.ts` (new) | 5 tests: no-ledger fail-open (envelope still enforced), metered burn closes the gate and re-opens after the sample slides out, calendar burn resets at the weekly boundary, unknown budget fails open regardless of ledger, `parseLedger` accepts points/units/ISO and skips junk. |
| `.github/workflows/front-desk-budget.yml` | Optional `ledger` input (string, default `""`), passed as `--ledger` only when non-empty, together with a read grant scoped to that one file (`--allow-read="$LEDGER"`; no read grant at all when unmetered); header comment no longer says "fail-open until #10". Callers passing only `budget_id`/`about_to_spend` are unaffected. |
| `deno.json` | `./window-meter` export, `publish.include`, and `check` task include `window-meter.ts`. No new dependencies (deno.lock untouched). |
| `.github/workflows/jsr-check.yml` | `window-meter.ts` added to the `deno check` step. |
| `CLAUDE.md` | Key-files rows for `window-meter.ts` and the `--ledger` flag. |

Design choices worth a reviewer's eye:
- Calendar boundaries are epoch-aligned by default (`anchor = 0`, so the 168h "weekly" window flips on Thursdays 00:00 UTC); `anchor` is an explicit parameter so a Monday-00:00 anchor is a one-line change and the choice is not baked in.
- Window bounds are inclusive on both ends (`start <= at <= now`); a sample at exactly the calendar boundary belongs to the new window.
- The meter lives in its own file rather than `prioritization.ts`, whose docstring says the meter is deliberately not part of the contract ("the meter lives in the room, not here").

## Verify output (trimmed; full log in `verify-output.txt`)

Environment note: the sandbox blocks `jsr.io` and `registry.npmjs.org` (proxy 403, org egress policy). Deno 2.5.0 was fetched from the GitHub release, and `@std/assert` was vendored from `github.com/denoland/std` via a local-only `--import-map` (not committed). Everything that only needs `@std/assert` ran; the whole-repo `deno task check` / `deno task test` / bare `deno lint` need `zod` + the MCP SDK from npm and `verbspec` from jsr, which could not be fetched.

```
$ deno fmt --check
Checked 31 files                                                      exit=0

$ deno lint --config emptycfg.json   # emptycfg.json contains `{}`
            window-meter.ts window-meter_test.ts budget-check.ts budget-check_test.ts prioritization.ts
Checked 5 files                                                       exit=0

$ deno check contract.ts prioritization.ts window-meter.ts budget-check.ts board-inputs.ts \
             window-meter_test.ts budget-check_test.ts prioritization_test.ts
Check ... (8 files)                                                   exit=0

$ deno test window-meter_test.ts --filter window       # scout verify_command step
windowStart: rolling is now minus the duration ... ok
windowStart: calendar snaps to the last boundary from the anchor ... ok
consumedPoints: rolling window accumulates, then slides samples out ... ok
consumedPoints: calendar window accumulates and resets at the boundary ... ok
meterBudget: feeds the windowed burn into planCapacity ... ok
ok | 5 passed | 0 failed | 3 filtered out                             exit=0

$ deno test window-meter_test.ts budget-check_test.ts prioritization_test.ts board-inputs_test.ts \
            contract-guard_test.ts traceability-check_test.ts reads_test.ts
running 8 tests from ./window-meter_test.ts   ... all ok
running 5 tests from ./budget-check_test.ts   ... all ok
running 7 tests from ./prioritization_test.ts ... all ok
running 4 tests from ./board-inputs_test.ts   ... all ok
running 5 tests from ./contract-guard_test.ts ... all ok
running 4 tests from ./traceability-check_test.ts ... all ok
running 1 test  from ./reads_test.ts          ... all ok
ok | 34 passed | 0 failed (421ms)                                     exit=0

$ deno run --allow-read budget-check.ts --budget rolling-5h --about-to-spend 1 --ledger ledger.json
  # ledger: 250k tokens (=5 pts) 1h ago, 4.5 pts 1 min ago, 99 pts in 2020
budget "rolling-5h" exhausted: 10.5/10 pts (5h window) — blocking new agent work until reset
                                                                      exit=1
$ deno run --allow-read budget-check.ts --budget weekly --about-to-spend 1 --ledger ledger.json
budget "weekly" healthy (10.5/40 pts)                                 exit=0
$ deno run budget-check.ts --budget rolling-5h --about-to-spend 1     # no ledger, as before
window burn unmetered (no --ledger) — consumedPoints=0, enforcing the static envelope only (warn)
budget "rolling-5h" healthy (1/10 pts)                                exit=0

$ deno task check   → error: Failed caching npm package 'etag@1.8.1' (403, sandbox)   exit=1
$ deno task test    → error: Failed caching npm package 'content-type@1.0.5' (403)    exit=1
```

The patch was also applied with `git am` onto a clean `main` worktree to confirm it applies without conflicts.

## Unresolved

1. **Full `deno task check` / `deno task test` / `deno lint` not run end-to-end** — they need `npm:zod`, the MCP SDK, and `jsr:@bounded-systems/verbspec`, all blocked by the sandbox egress policy. The touched files and every network-free test file pass; the untouched test files that import npm/jsr packages (`health`, `health-issue`, `ready`, `scout-reads`, `verbs`, `webhook`) were not exercised. `jsr-check.yml` on the PR will cover this.
2. **The ledger emitter is not in this repo, so #10 stays open.** #10 says metering depends on the telemetry/OTLP source; no such issue is filed in this repo (the spike doc's "#75 telemetry" is stale numbering — live #75 is the merged health-issue PR). This lands the meter and the `--ledger` seam; something (the telemetry source once filed, or the `api_spend` table mentioned in `docs/behavioral-prioritization-delivered.md` — a different, prose-only meter that this patch does not touch) still has to write `[{at, points|units}]` for the gate to be metered in production. Until then the gate runs exactly as before (unmetered, fail-open).
3. **Calendar anchor** — epoch-aligned by default; if the org wants Monday-00:00 UTC weeks, pass an `anchor` (would need a `--anchor` flag on `budget-check.ts`, deliberately not added to keep scope tight).
4. **Not claimed / not pushed.** See "Before merging (owner)" below.
5. `spike-behavioral-prioritization.md` still lists "#101 — wire window-burn metering" as an unchecked next step; left as-is since it is a historical spike record and the numbering there does not match the live issue.

## Before merging (owner)

Process items the sandbox cannot do (no GitHub credentials):

- [ ] Claim #10 via `claim-ticket.yml` (bounded-systems/.github) **before** opening the PR — CLAUDE.md step 2, and the required `pr-claim` check needs the named issue to carry a live claim.
- [ ] Push `claude/burndown-gpr-10` and open the PR against `main`.
- [ ] PR body: include `Claim-issue: bounded-systems/gh-project-room#10` on its own line (already in the commit trailer) and do **not** write `Closes #10` anywhere — pr-claim@bc4cb7d fails a PR that says both, and this work does not close the issue.
- [ ] Let `jsr-check.yml` be the first full run of `deno task check` / `deno task test` / `deno lint` and the new `./window-meter` export (npm/jsr were blocked here).
- [ ] Optionally file the telemetry/OTLP emitter as its own issue and link it from #10, so the "depends on" has a real number.

## Ready-to-paste GitHub comment for #10

```
Patch ready for this (not yet pushed — needs a claim first per CLAUDE.md): `claude/burndown-gpr-10`, one commit on top of `main` @ f28b2b2.

Scope up front: this lands the meter and the `--ledger` seam and does NOT close #10. The telemetry/OTLP source this issue depends on is not yet filed in this repo, and no caller of `front-desk-budget.yml` supplies a ledger today, so production behaviour is unchanged (unmetered, fail-open) until an emitter exists. The commit carries `Refs #10` + `Claim-issue: bounded-systems/gh-project-room#10`, not `Closes`.

- New `window-meter.ts` (pure, clock-injected, no deps, JSR-exported as `./window-meter`): `UsageSample {at, points}`, `windowStart()`, `consumedPoints(window, samples, now)` — sums samples inside the budget's *current* window; rolling windows slide samples out as they age, calendar windows reset at each boundary (epoch-anchored by default, `anchor` injectable). Also `unitsToPoints()` (tokens → points) and `meterBudget()` (= `planCapacity` with live burn filled in).
- `budget-check.ts` gains `--ledger <path>` (JSON array of `{at, points}` or `{at, units}`), and the decision is now an exported pure `evaluate()`; existing flags, exit codes and the fail-open posture with no ledger are unchanged (now logged as a warn). `front-desk-budget.yml` gets an optional `ledger` input with a read grant scoped to that file.
- Tests: `window-meter_test.ts` asserts consumedPoints accumulates per window and resets at the calendar boundary / slides out of the rolling window; `budget-check_test.ts` covers fail-open vs fail-closed. 34/34 network-free tests pass; `deno fmt --check` clean.
- Follow-up (separate issue, not yet filed): the emitter that writes the ledger — the telemetry/OTLP source, or the `api_spend` table from docs/behavioral-prioritization-delivered.md, which is a different meter this patch does not touch.

Apply: `git checkout -b claude/burndown-gpr-10 main && git am 0001-feat-budget-wire-window-burn-metering-consumedPoints.patch`, then `deno task check && deno task test`.
```

## Fix round

Verdicts A (correctness) and B (scope/mergeability) re-ran every check and reproduced the numbers; their must_fix items were all about framing, not code. Fixer re-cloned `main` @ `f28b2b2` into `/tmp/fix/gpr-10/gh-project-room`, `git am`'d the patch, amended the single commit (history kept to one honest commit), re-ran the checks, and regenerated the patch.

| must_fix | Source | What was done |
| --- | --- | --- |
| Do not use `Closes #10`; state that this lands the meter + seam only and production is unchanged | A, B(3) | Commit body now has an explicit "This does NOT close #10 …" paragraph; REPORT header, Unresolved #2 and the ready-to-paste comment say the same thing in the same words. No `Closes` anywhere. |
| Remove/correct the "#75 telemetry" cross-reference (live #75 is the merged health-issue PR) | B(1) | Commit body and comment now say "the telemetry/OTLP source, which is not yet filed in this repo"; `#75` appears nowhere in the patch or the comment. |
| Satisfy `pr-claim`: claim #10, add `Claim-issue: bounded-systems/gh-project-room#10`, never alongside `Closes` | B(2) | Patch-level: `Claim-issue: bounded-systems/gh-project-room#10` added as a commit trailer (with `Refs #10, epic #5`, no `Closes`). Process-level (claiming, PR body): listed under "Before merging (owner)". |

Nits picked up while in there (cheap, no behaviour change): commit subject no longer ends in `(#10)` (it mimicked the squash-merge PR-number suffix); `front-desk-budget.yml` grants `--allow-read="$LEDGER"` scoped to the ledger file and no read grant when unmetered (matches the repo's scoped-grant style; verified the snippet end-to-end with and without a ledger); the REPORT's `deno lint --config '{}'` line corrected to a real empty config file. Not done: `--anchor` CLI flag, reconciling `docs/behavioral-prioritization-delivered.md` beyond a note in the comment (both left as documented follow-ups).

Re-run after the fix (deno 2.9.6, `@std/assert` via the local import map): `deno fmt --check` 31 files clean; `deno lint` 5 files clean; `deno check` on the 8 network-free modules clean; `deno test window-meter_test.ts --filter window` 5/5; the 7 network-free test files 34/34; CLI: ledger with 10.5 pts → exit 1, no ledger → warn + exit 0, unreadable ledger → warn + exit 0. `deno task check` still fails on the npm 403 (sandbox). Regenerated patch `git am`s cleanly onto a fresh `main` worktree.
