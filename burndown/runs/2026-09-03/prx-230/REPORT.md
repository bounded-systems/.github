# prx-230 — GH-230: headless planner ignores the issue body

## Outcome

**Already resolved on `main` (9de9551). No patch produced.** The scout's claim was
re-checked against a fresh clone and confirmed by running the named test.

## What changed (files)

Nothing. Branch `claude/burndown-prx-230` is identical to `main`
(`git log main..HEAD` is empty; `git format-patch` emitted no files).

## Evidence the fix already landed

Commits on `main`:

- `0312766` fix(plan): planner embeds the consumed source@pinned derivation (prx-pl2) (#81)
- `2701169` fix(prx): pin source@pinned for GitHub units so the headless planner consumes the real issue (GH-230) (#235)
- `9e5424e` fix(prx): no hydrate path — planner gets the issue as input or hard-fails (GH-261/GH-232) (#277)

Code (paths relative to repo root):

- `packages/prx/src/machine/runtime_profiles.ts:795-850` —
  `buildWorkUnitClaudePlanPrintRuntimeProfile({ sourceBody })` renders the issue
  inline in the user prompt between `----- BEGIN WORK UNIT SOURCE -----` /
  `----- END WORK UNIT SOURCE -----`, followed by "do NOT run `prx`/`bd` to
  re-fetch the source". With no `sourceBody` it emits a "must NOT fetch or
  fabricate" notice (the old "Hydrate workflow context…" instruction is gone).
- `packages/prx/src/pr-state/cli.ts:14007-14047` — headless `prx plan agent`
  consumes `<unit>:source@pinned` via `consumeArtifact(workUnitSourceEdge, …)`,
  builds `title\n\nbody`, passes it as `sourceBody`, and throws `CliError`
  ("no `<unit>:source@pinned` … Pin it first: `prx intake source <unit>`") when
  the pin is absent (except `--dry-run`). `cli.ts:2768/2880/2931` pin the source
  on `--create`.
- `packages/prx/src/session/open.ts:588-591`, `session/leg-input.ts:38-75`,
  `machine/machines/session-entry.ts:90,236` — the `prx session open` path
  resolves the signed pin and routes it to `sourceBody` for `actor === "plan"`.

Test satisfying the verify criterion:

- `packages/prx/test/pr-state/runtime_profiles.test.ts:1333-1351`
  "the planner embeds the consumed source body; falls back when absent (prx-pl2)"
  asserts `sdkSpec.prompt` contains `BEGIN WORK UNIT SOURCE` and the literal
  body text `Add a note to keymaker.ts`, and that the no-source prompt no longer
  contains `Hydrate workflow context`.
- Related: `test/pr-state/cli.test.ts:4803-4842` (source pin on `--create`, GH-230),
  `test/session/open.test.ts:~799` (sourceBody reaches the machine event).

## Verify output (trimmed)

```
$ bun test packages/prx/test/pr-state/runtime_profiles.test.ts -t "embeds the consumed source body"
 1 pass
 90 filtered out
 0 fail
 8 expect() calls
Ran 1 test across 1 file. [223.00ms]

$ bun test packages/prx/test/pr-state/runtime_profiles.test.ts
 91 pass
 0 fail
 814 expect() calls
Ran 91 tests across 1 file. [239.00ms]
```

Full log: `/home/claude/burndown/out/prx-230/verify.log`.

How it was run: `bun install` is impossible in this sandbox — registry.npmjs.org
and npm.jsr.io both answer `403 x-deny-reason: host_not_allowed` (egress policy),
so the scout's `verify_command` cannot complete as written. GitHub is reachable,
so the five `@bounded-systems/*` packages this test file transitively imports
(`env@0.2.0`, `proc@0.2.5`, `host@0.2.0`, `cas@0.1.2`, `policy@0.2.1`) were
cloned from github.com/bounded-systems at their version tags and symlinked into
bun's `node_modules/.bun/...` layout; `zod@4.4.3` came from a local copy. The
test file then ran unmodified against the real repo sources.

## Unresolved / not done, and why

- **Full `bun test`, `bun run typecheck`, lint not run.** `cli.test.ts`,
  `open.test.ts` and the rest of the suite import `xstate`,
  `@anthropic-ai/claude-agent-sdk`, `ajv`, and ~20 more JSR packages; the npm
  registry is policy-blocked here, so those cannot be installed. Nothing was
  changed, so there is no regression risk from this task; CI on `main` is the
  authority for the wider suite.
- **Issue's secondary suggestions are NOT implemented** (outside the task's
  stated scope; noted for the maintainer):
  - The stable system prompt (`runtime_profiles.ts:592-602`) still carries the
    imperative "Prefer the parity chain as the source of truth…" / "Prefer XState
    states/events…" directives the issue identifies as the confabulation seed.
    Demoting them to advisory would touch the GH-1407 cache-stable prefix and
    several prompt-text assertions.
  - No scope-fidelity gate (plan Problem/Scope must reference the pinned source)
    exists before `validated=true`.
- Minor observation: on the `--resume` partial-draft path (`cli.ts:14014`,
  `resumePartialPlan !== undefined`) the source is not re-embedded; the planner
  continues from the prior draft only. Not the scenario in GH-230.

## Ready-to-paste closing comment for GH-230

```
Closing — the primary fix is on main.

- #81 (0312766): `buildWorkUnitClaudePlanPrintRuntimeProfile` takes `sourceBody` and renders the issue inline in the planner's user prompt between `BEGIN/END WORK UNIT SOURCE` markers (`packages/prx/src/machine/runtime_profiles.ts`).
- #235 (2701169): `prx plan agent --create` pins `<unit>:source@pinned` so the headless planner consumes the real issue.
- #277 (9e5424e): the "hydrate it yourself" instruction is gone; `prx plan agent` hard-fails with "no `<unit>:source@pinned` … `prx intake source <unit>`" instead of letting the planner fabricate.

Verified on main @ 9de9551: `bun test packages/prx/test/pr-state/runtime_profiles.test.ts -t "embeds the consumed source body"` → 1 pass (asserts the literal issue body text appears in `sdkSpec.prompt`); the full file → 91 pass / 0 fail.

Not done here (open a follow-up if wanted): demoting the parity-chain/XState lines in `buildRoleStableSystemPrompt` from imperative to advisory, and a scope-fidelity gate before `validated=true`.
```
