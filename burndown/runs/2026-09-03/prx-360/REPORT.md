# prx-360 -- pilot loops on the implement stage: tester leg served the executor profile + plan

Issue: https://github.com/bounded-systems/prx/issues/360
Branch: `claude/burndown-prx-360` (on top of `main` @ 9de9551), one commit, not pushed.
Patch: `0001-fix-pilot-serve-the-tester-leg-its-own-tester-profil.patch` (this directory; regenerated after the fix round).

## Root cause (traced)

`packages/prx/src/cli/pilot-real.ts` maps `tester -> "implement"` (`roleSessionActor`) and
`buildRealLegRunner` opened every leg as `open({ actor, workUnitId, interaction: "headless" })`
with no role axis. `openSession` (`packages/prx/src/session/open.ts`) then dispatched
`OPEN_IMPLEMENT_SESSION`, whose headless branch in
`packages/prx/src/machine/machines/session-entry.ts` unconditionally built
`buildWorkUnitClaudeImplementSdkRuntimeProfile` -- the EXECUTOR profile
(`PRX_AGENT_ROLE=executor`, acceptEdits + implement allowlist, prompt "Execute the approved
implementation plan ... commit the work"), with the `plan@draft` body embedded as scope.
So the testing leg re-implemented the unit, reported "done", and the machine cycled
`executing -> checking -> testing` until the retreat budget was spent. No tester profile existed
on the headless path at all (only a role-string branch in the legacy task-role helpers, which
`openSession` never uses).

## What changed

| File | Change |
|---|---|
| `packages/prx/src/machine/runtime_profiles.ts` | New `buildWorkUnitClaudeTestSdkRuntimeProfile({workUnitId, planPath?, planBody?})`: headless TESTER profile. `PRX_AGENT_ROLE=tester`; ruleset `actorRuleset("implement", {role:"reader", omitOwnNamespace:true, extraAllow:[Bash(bun test:*), Bash(bun run:*), Bash(prx tools git:*)]})`. The resulting `allowedTools` is exactly `[Read, Grep, Glob, Bash(bun test:*), Bash(bun run:*), Bash(prx tools git:*)]` -- Edit/Write are denied, raw git/gh/bd stay behind SHARED_DENY, and `omitOwnNamespace` keeps `Bash(prx implement:*)` OUT (it would otherwise re-admit `prx implement agent`, i.e. let the tester re-launch the executor). System prompt says the implementation is already committed, inspect + run tests + report evidence, do not re-implement, and if `bun test` is unavailable in the sandbox say so rather than claim a pass; user prompt "Test the committed implementation of <unit>", plan embedded as CONTEXT only. |
| `packages/prx/src/machine/machines/session-entry.ts` | `OPEN_IMPLEMENT_SESSION` gains `role?: "executor" \| "tester"`; headless + `role:"tester"` selects the tester profile. Absent/`executor` paths unchanged. |
| `packages/prx/src/session/schema.ts` | `SessionOpenInput.role: z.enum(["executor","tester"]).optional()` (not part of the exported JSON schema set; `schemas:check` clean). |
| `packages/prx/src/session/open.ts` | Threads `role` into the implement event; the spawn attestation for a tester opening `implement` is minted at `<unit>:spawn@tester` (was overwriting the executor's `spawn@implement`), and `SPAWN_ATTESTED.details.role` reports it. |
| `packages/prx/src/cli/pilot-real.ts` | New `roleSessionRole = { executor: "executor", tester: "tester" }`; `OpenSessionFn` accepts `role?`; the leg runner passes it, so the tester leg still opens the implement worktree (the commit is there) but gets its own profile. |
| `packages/prx/src/session/leg-input.ts` | Comment only: the plan is the tester's context, not its scope. |
| `docs/prx/pipeline-orchestrator.md` | Role -> actor paragraph updated to describe the role axis (hand-written doc, not generated). |
| Tests | `packages/prx/src/cli/pilot-real.test.ts` (tester leg opens `implement` WITH `role:"tester"` and the profile that leg RUNS is the tester's -- the verify criterion), `packages/prx/test/machine/session_entry.test.ts` (headless+tester -> tester profile; executor/absent unchanged), `packages/prx/test/session/open.test.ts` (event carries role, spawn@tester minted), `packages/prx/test/pr-state/runtime_profiles.test.ts` (5 builder-shape tests, incl. a pin that `Bash(prx implement:*)` is NOT in the tester allowlist). |

Diff: 11 files, +447/-7.

## Verify output (trimmed)

Environment note: the sandbox's egress policy blocks `registry.npmjs.org` and `jsr.io`
(`x-deny-reason: host_not_allowed`), so `bun install` cannot run. To execute the repo's checks
I vendored every dependency from source at the pinned tags via `git clone` from GitHub
(xstate 5.32.6, all 23 `@bounded-systems/*` JSR packages at their `vX.Y.Z` tags, drizzle-orm
0.45.2, ajv-formats 3.0.1, bun-types 1.3.13), reused on-disk copies of zod 4.4.3 / ajv 8.18 /
@types/node, downloaded the biome 2.5.10 release binary, and wrote a 17-line stub for
`@anthropic-ai/claude-agent-sdk` (tests inject a fake `query`). None of that is in the patch.

Scout verify command (targeted suites incl. the architecture guard):

```
$ bun test packages/prx/src/cli/pilot-real.test.ts packages/prx/test/session/open.test.ts \
    packages/prx/test/pr-state/runtime_profiles.test.ts packages/prx/test/machine/session_entry.test.ts \
    packages/prx/src/machine/machines/pilot.test.ts packages/prx/src/machine/machines/pilot-runner.test.ts \
    packages/prx/test/session/leg-input.test.ts packages/prx/test/audit/architecture.test.ts
 196 pass
 0 fail
Ran 196 tests across 8 files. [406.00ms]
```

Full suite, before vs after (same vendored environment; re-run after the fix round in a fresh clone):

```
main @ 9de9551 :  5764 pass / 22 (fail) lines + 2 module-load errors   (Ran 5812 tests across 503 files)
this branch    :  5773 pass / 22 (fail) lines + 2 module-load errors   (Ran 5821 tests across 503 files)
diff of the sorted (fail) sets: IDENTICAL
```

The 22 failures are pre-existing / sandbox-only (generated-artifact drift checks that resolve the
repo root through the vendored `repo-root` package path, `.claude/agents/*.md` codegen,
`openapi.json` drift -- also red on untouched `main` here -- the agent-SDK stub, and an ssh
keygen test). +9 pass = the 9 new tests.

Other checks:

```
$ biome check <10 changed .ts files>      -> Checked 10 files. No fixes applied.
$ bun run docs:check                      -> exit 0 (driftCount 0)
$ bun run schemas:check                   -> exit 0 (driftCount 0, count 47)
$ bun run features:check                  -> exit 0
$ bun run openapi:check                   -> FAIL, identical failure on untouched main (pre-existing)
$ tsc --noEmit (TS 6.0.3 on disk; repo pins 7.0.2; run with customConditions:["bun"] so the
  vendored packages resolve to source) -> zero errors in any touched file; remaining errors are
  only in files importing packages unavailable here (ts-morph, marked, the SDK stub types).
```

## Unresolved / follow-ups

1. Not run against a live `PRX_PILOT_REAL=1 prx pilot` drive -- no API key / beads server in
   the sandbox. The fix is proven at the seam the issue names (profile selection) with mocked
   I/O, the same way `pilot-real.test.ts` already proves the other legs.
2. Tester verdict semantics (issue bullet 3, "independent advancement"): the machine already
   advances `testing -> reviewing` on a successful tester run (`createSdkLegRunner`: success =>
   advance). A tester that runs and REPORTS failing tests still counts as a successful agent run
   and advances; making a red test report retreat to `executing` (like the checks gate) is a
   separate design decision not taken here -- outside the stated root cause.
3. `bun run typecheck` under the pinned TypeScript 7.0.2 and `bun run check` over the whole tree
   could not be run exactly as CI does (registry blocked); touched files are clean under 6.0.3
   + biome 2.5.10.
4. Org process from CLAUDE.md (`.claude/org-repair.sh` bootstrap, `claim-ticket.yml` dispatch)
   was not performed -- no GitHub credentials in this sandbox. Claim the issue before opening the PR.

## Ready-to-paste GitHub comment

```
Traced it: `roleSessionActor.tester -> "implement"` is fine (the tester needs the executor's worktree), but `openSession` had no role axis, so `OPEN_IMPLEMENT_SESSION` + headless always built `buildWorkUnitClaudeImplementSdkRuntimeProfile` -- the executor profile with the draft plan as scope. The tester re-implemented, said "done", and the pilot looped executing->checking->testing until the budget ran out.

Patch (branch `claude/burndown-prx-360`, 1 commit, +447/-7):
- new `buildWorkUnitClaudeTestSdkRuntimeProfile`: `PRX_AGENT_ROLE=tester`; allowlist is exactly Read/Grep/Glob + `Bash(bun test:*)` + `Bash(bun run:*)` + `Bash(prx tools git:*)`, Edit/Write denied, and `omitOwnNamespace: true` so the tester does NOT get `Bash(prx implement:*)` (which would let it re-launch `prx implement agent`); prompt consumes the COMMITTED implementation; plan is context only
- `OPEN_IMPLEMENT_SESSION` / `SessionOpenInput` gain `role?: "executor"|"tester"`; the tester leg now mints its own `<unit>:spawn@tester`
- `pilot-real.ts` passes `role: "tester"` for the tester leg; `pilot-real.test.ts` asserts the tester leg opens implement as tester AND runs the tester profile; session_entry/open/runtime_profiles tests cover the rest (+9 tests, full suite otherwise unchanged)

Apply: `git am 0001-fix-pilot-serve-the-tester-leg-its-own-tester-profil.patch` on `main` (or fetch the branch).
Not done here: a live `PRX_PILOT_REAL=1` drive (the issue's acceptance criterion -- a docs-only unit reaching author -> CI -> merge -- is proven only by the mocked full-machine drive in `pilot-real.test.ts`), deciding whether a tester that reports red tests should retreat to `executing` rather than advance (currently any successful run advances), and binding the tester's spawn attestation to the executor's commit instead of `plan@draft` (leg-input.ts defers that until the executor output path lands).
```

## Before merging (owner)

- [ ] Run the CLAUDE.md org bootstrap (`.claude/org-repair.sh`) and dispatch `claim-ticket.yml` to claim #360 -- no GitHub credentials in the sandbox, so the claim was not made.
- [ ] Open the PR from `claude/burndown-prx-360` (the patch is not pushed); include the scope/verification statement CONTRIBUTING asks for, stating explicitly that the live `PRX_PILOT_REAL=1` docs-only drive was NOT exercised.
- [ ] Optionally run that live drive before merging if you treat the issue's acceptance criterion as a merge gate.
- [ ] `bun run typecheck` / `bun run check` under the pinned TypeScript 7.0.2 and a real `bun install` -- the sandbox could only run TS 6.0.3 with vendored deps (touched files clean).

## Fix round

Verdict A (correctness + reproducibility): no must_fix. Verdict B (scope + mergeability) must_fix items:

1. **`Bash(prx implement:*)` leaked into the tester allowlist** (actorRuleset own-namespace glob). Fixed: `buildWorkUnitClaudeTestSdkRuntimeProfile` now passes `omitOwnNamespace: true` (same precedent as the `submit` profile) with an explanatory comment; `runtime_profiles.test.ts` pins `expect(allowed).not.toContain("Bash(prx implement:*)")` plus a prefix check. Probe after the fix: `allowedTools = [Read, Grep, Glob, Bash(bun test:*), Bash(bun run:*), Bash(prx tools git:*)]`.
2. **Ready-to-paste comment / REPORT table misdescribed the allowlist.** Fixed: both now list the exact allowlist (including `Bash(bun run:*)`) and the `omitOwnNamespace` guarantee. The commit message body was corrected the same way.

Nits taken while in there: the tester system prompt now says to report explicitly if `bun test` is unavailable rather than claim a pass (verdict B nit 1); the commit message's "9 implement legs" now matches the issue's "10 legs spawned at implement" (verdict B nit 2); the comment's follow-up list names the deferred spawn-input binding (verdict A nit 1). Not taken: narrowing `Bash(bun run:*)` (verdict B's must_fix wording keeps `bun run`), the `acceptEdits` cosmetic, and the doc-narrative trim.

Changes were folded into the single commit with `git commit --amend` (one logical change, history kept minimal); the old patch was deleted and regenerated with `git format-patch 9de9551..HEAD`. Re-verified in a fresh clone + `git am`: targeted 8 suites 196/196; `packages/prx/test/machine` 439/439; full suite 5773 pass vs 5764 on main with identical sorted (fail) sets; biome on the 10 changed `.ts` files clean; `docs:check` / `schemas:check` / `features:check` exit 0, driftCount 0; tsc 6.0.3 whole-tree error count 598 (all in vendored packages / files importing unavailable deps), none in touched files; the regenerated patch `git am`s cleanly onto 9de9551.

## Post-final correction (2026-09-03)

The commit body previously said "10 legs spawned at implement, zero at the review/author
stages". Issue #360 states `legCount: 10` with **9** `spawn@implement` legs and 0
reviewer/author legs. The commit message now quotes the issue exactly. The patch was
regenerated; no `git commit --amend` is needed before pushing.
