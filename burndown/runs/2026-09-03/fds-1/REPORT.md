# fds-1 — Delta sync (bounded-systems/front-desk-scheduler#1)

## Verdict

The scout's claim is **confirmed**: the delta sync the issue asks for already exists and runs in production. What was missing was the proof — no test exercised `syncPullDelta` (it shelled out to `dolt`/`gh` with no seam). This branch adds the seam and the test; no behaviour change on the live path. The issue can be closed on this evidence (its `depends-on` #3 is Closed by PR #144, confirmed by verdict B) — via a PR carrying `Closes #1`, after #1 is claimed (see "Before merging (owner)").

Evidence on `main` (19437d5):

| Commit | What |
|---|---|
| `f3c0f61` `#1: delta sync via Search API — ~1 GraphQL point vs 610` | `syncPullDelta` in `src/mirror.ts`, `scripts/sync-delta.ts`, `.github/workflows/mirror-sync-delta.yml` |
| `1b1683c` `Event-driven delta: repository_dispatch(board-changed) trigger` | webhook-driven delta, hourly cron `37 * * * *` as backstop |
| `3f9285a` (#57) `board: read the board with fieldValueByName — 1,415 points to ~15` | the full pull itself is now ~15 points (measured 16, 2026-07-31, `src/mirror.ts:80`); it stays the drift backstop, `mirror-sync.yml`, cron `17 */6 * * *` (every 6h — not weekly, despite stale in-repo comments) |
| `ca285a8` (#100) | delta refreshes `closed_at`, reopen clears it |

`src/mirror.ts` (`syncPullDelta`, ~L1114 after this patch): reads the last `sync_log.synced_at` as the cursor, runs `gh search issues --owner <org> --updated >=<date> --json number,repository,title,state,isPullRequest,closedAt --limit 500`, UPDATEs title/status(closed→Done)/closed_at only on rows the mirror already has, meters `api_spend` verb `delta-search` and appends `sync_log`. `schema/mirror.sql` L235-260 has `sync_log`/`api_spend`.

## What changed (branch `claude/burndown-fds-1`, commit `3c63bdf`)

- `src/mirror.ts` — `export interface DeltaIo { sql, gh, graphqlLimit }`, default `liveDeltaIo` (dolt sql / gh / rate_limit); `syncPullDelta(org = "bounded-systems", io: DeltaIo = liveDeltaIo)`; `DeltaResult.fetched` (size of the delta the search returned). All existing callers unchanged. The literal `"--json", "..."` string and the `closed_at = sqlDatetimeOrNull(...)` line are preserved so `test/closed-at-freshness.test.ts`'s source-grep assertions still hold.
- `test/sync-delta.test.ts` (new, 5 tests) — in-memory mirror + scripted Search API. The headline test: first sync (3 items), change ONE issue, second sync → asserts `--updated >=2026-09-01` (the first sync's cursor), `fetched === 1`, `changed === 1`, `newSeen === 0`, exactly one `UPDATE items ... WHERE item_id = 'PVTI_b'` with `status = 'Done'` and the new `closed_at`, and a second `sync_log` row with `items_count = 1`. Plus: metering (`delta-search`, 0 points, live `graphql_remaining`), reopen clears `closed_at` without touching status, unknown issue counted not written, date-granularity cursor pinned.
- `scripts/sync-delta.ts` — log line prints `fetched` alongside `changed` (cosmetic).
- Commit message carries `Closes #1` (the repo's merge path is a PR gated by `pr-claim.yml`).

Mutation check: replacing the cursor with the constant floor makes all 5 new tests fail; restored.

## Verify output (trimmed)

`node --test test/sync-delta.test.ts`:
```
ok 1 - second sync after a single-item change fetches only that delta and writes only that row
ok 2 - the delta lane is metered as delta-search and costs no GraphQL
ok 3 - a reopen in the delta clears closed_at, and status is left to the board
ok 4 - a changed issue the mirror does not have is counted, not written
ok 5 - the cursor is the last sync_log row at date granularity
# tests 5  # pass 5  # fail 0
```

`node --test test/sync-delta.test.ts test/closed-at-freshness.test.ts` → 11 pass, 0 fail.

`npm test` (355 → 360 tests):
```
# tests 360
# pass 353
# fail 7
not ok  test/capability.test.ts, claim-named, claim-ticket-summary, graph, held, list, next
```
The 7 failures are identical before and after this change and are purely environmental: `ERR_MODULE_NOT_FOUND: Cannot find package 'zod'` — `deno install --frozen` cannot run here (`npm.jsr.io`, `registry.npmjs.org`, `jsr.io` all return 403 through the sandbox egress policy). Same 7 on untouched `main`.

`deno check src/mirror.ts test/sync-delta.test.ts scripts/sync-delta.ts test/closed-at-freshness.test.ts`: no errors in any touched file. One pre-existing error surfaces in `src/dolt-server.ts:221` (TS2488, `mysql2` types unresolved) — reproduced on untouched `main`, same sandbox cause.

Scout `verify_command` was run in its equivalent form at `/tmp/work/fds-1/front-desk-scheduler` (`deno install --frozen` fails on egress; `node --test test/sync-delta.test.ts` passes; `npm test` as above).

## Unresolved

- Could not run `deno install --frozen` / fully green `npm test` / full `deno check` locally (registry egress 403). CI (`test.yml`) is the real gate; the touched files typecheck clean.
- `since` stays at date granularity (`.slice(0, 10)`) — a deliberate over-fetch of same-day items, pinned by a test rather than tightened, since changing it alters a live hourly workflow and is out of scope for #1.
- Not addressed (documented limitation, CLAUDE.md "delta lane"): the delta does not add brand-new items or pick up board FIELD changes; the full pull (every 6h) does. The test asserts this scope rather than overstating it.
- Stale numbers (`~610`, `1,314`, `1,415`) and stale "weekly" wording in pre-existing comments (`src/mirror.ts:1075/1108`, `scripts/sync-delta.ts:6/17`, `mirror-sync-delta.yml:6`) left as-is to keep the diff scoped; the new test file and commit message use the correct every-6h cadence.
- `fetched` counts every Search hit including pull requests (`isPullRequest` is fetched but never filtered — pre-existing), so the CLI's "issue(s)" log line slightly overstates.

## Before merging (owner)

- [ ] Claim #1: dispatch `claim-ticket.yml` in `bounded-systems/.github` (repo `front-desk-scheduler`, issue `1`, your claimant), then confirm the claim comment on #1 names you. `pr-claim.yml` fails closed on an unclaimed issue and CLAUDE.md forbids working unclaimed. (Scout recorded `claimed: false`; #1 currently has no assignee/label/comments.)
- [ ] Open the PR from `claude/burndown-fds-1` against `main` with the body below — the commit and body carry `Closes #1`. Do not close #1 by hand; let the PR close it.
- [ ] Let CI (`test.yml`: `deno install --frozen && npm test`, plus vars/drift and `pr-claim`) be the green gate — the sandbox could not install deps.
- [ ] Optionally re-check #3 is still Closed (it was, by PR #144, at review time).

## Ready-to-paste PR body

```
Closes #1

The delta sync this issue asks for already shipped: f3c0f61 (Search API, `syncPullDelta` + `scripts/sync-delta.ts` + `mirror-sync-delta.yml`), then 1b1683c (event-driven via repository_dispatch `board-changed`, hourly cron as backstop). The full pull it was meant to displace dropped from ~1,415 to ~15 points in 3f9285a (#57; measured 16 points on 2026-07-31, `src/mirror.ts:80`) and remains the drift backstop in `mirror-sync.yml` — on `17 */6 * * *` (every 6h), a tighter cadence than the weekly one the issue proposed. #3 (depends-on) is closed (PR #144).

What was missing was proof: nothing exercised `syncPullDelta` because it shelled out to dolt/gh with no seam. This PR adds an optional `DeltaIo` parameter (default = live dolt/gh/rate_limit, no caller changes), `DeltaResult.fetched`, and `test/sync-delta.test.ts`: first sync, change ONE issue, second sync → asserts the search is bounded by the last `sync_log` cursor, returns exactly 1 issue, and issues exactly 1 `UPDATE` for that row (plus metering, reopen-clears-closed_at, unknown-issue-not-written, date-granularity cursor). 5/5 pass; the existing suite is unaffected. No behaviour change on the live path.

Not touched: the stale "weekly" / "~610" wording in older comments next to the delta code — happy to fix in a follow-up.

Local check: `deno install --frozen && npm test`.
```

## Fix round

Verdict A (correctness): `must_fix: []`. Verdict B (scope/mergeability) `must_fix`:

1. **Claim #1 before opening the PR** — PROCESS (needs owner credentials). Added to "Before merging (owner)".
2. **Replace `efcd8d6` with `3f9285a` (#57)** — PATCH. Commit message amended (`3c63bdf`); REPORT evidence table and PR body now cite `3f9285a` (#57) and the measured 16-point figure at `src/mirror.ts:80`.
3. **mirror-sync.yml is every-6h, not weekly; drop "as proposed here"** — PATCH. PR body now states `17 */6 * * *` (every 6h) and explicitly says this differs from the issue's weekly proposal. Also fixed the copied "weekly" wording in the new `test/sync-delta.test.ts` header and one assertion message (verdict B nit / verdict A nit); pre-existing stale comments left untouched and called out.
4. **Deliver as a PR with `Closes #1`, not an issue comment + attached patch; Apply line must run `deno install --frozen`** — PATCH + PROCESS. Commit message now carries `Closes #1`; the "Ready-to-paste GitHub comment" was replaced by a PR body, and its local-check line is `deno install --frozen && npm test`. Opening the PR itself is on the owner checklist.

Re-ran after the fixes (fresh clone at `19437d5`, `git am`, `/tmp/fix/fds-1/front-desk-scheduler`): `node --test test/sync-delta.test.ts test/closed-at-freshness.test.ts` → 11/11; `npm test` → 360 tests, 353 pass, 7 fail (same 7 env-only `zod` ERR_MODULE_NOT_FOUND files as on main); `deno check` on touched files → only the pre-existing `src/dolt-server.ts:221` TS2488. Patch regenerated with `git format-patch main..HEAD`.
