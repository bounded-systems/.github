# prx-270 — top-of-file doc comment on `packages/prx/src/intake/intake-source.ts`

Issue: https://github.com/bounded-systems/prx/issues/270 (open, no comments, no linked PR)
Branch: `claude/burndown-prx-270` on top of `main` @ `9de9551`. Commit `fbd4529` (fix round; supersedes `fde6a37`). Not pushed.

## Finding: the issue's literal ask was already met, but the header was incomplete

- A `/** ... */` module comment has been at the top of the file since the verb was
  introduced in `ef696de` (2026-06-06, "prx intake source — intake owns the chain ROOT
  source@pinned (GH-232 slice 1) (#241)"), and survived `395b45f` (#283) and `92bfe92` (#297).
  So "a top-of-file doc comment exists" was true on `main` already.
- However, checked against the issue text and the burndown criterion, the existing header:
  - did NOT say the verb is "runnable by a human or an agent" (the one point #270's body
    explicitly asks the summary to make);
  - did NOT name or describe any of the file's five exports
    (`intakeSourceOptionsSchema`, `IntakeSourceOptions`, `IntakeSourceDeps`,
    `IntakeSourceError`, `runIntakeSource`);
  - did not mention the GH-292 signing gate that the body enforces.
- An unmerged remote branch `origin/GH-270` (`7800b8e`, 2026-06-06, "docs(prx): note
  intake-source is runnable by human or agent (GH-270)") adds only the "runnable by a human
  or an agent" sentence, on top of the pre-#283 header. It was never merged and is now
  stale relative to `main` (the paragraph it edits was rewritten in #283).
- The existing header's claims were re-checked against the code and hold: fetch delegated to
  `resolveWorkUnitSource` (`src/scout/source.ts`), pin via `pinWorkUnitSource`
  (`src/pipeline/source-pin.ts`, content-addressed + signed), no XState event emitted.

Conclusion: patch (small, doc-only), not close-as-stale.

## What changed

- `packages/prx/src/intake/intake-source.ts` — +18 lines, all inside the existing top-of-file
  JSDoc block (no second block added, nothing below the comment touched):
  - a paragraph stating the verb is runnable by a human (`prx intake source`, wired from
    `../pr-state/cli.ts`) or an agent invoking the same command, and that the pin is signed
    either way (GH-292; missing key is a hard refusal);
  - an "Exports (GH-270)" list describing each of the five exports, each checked against
    the code: options schema fields `id` + `format` (`plain`|`json`); `IntakeSourceDeps`
    fields `loadIdentity`/`buildResolver`/`pinSource`/`signer`/`repoPath`;
    `IntakeSourceError` re-wraps `ScoutSourceError` only (other errors rethrown);
    `runIntakeSource(options, output, deps)` prints `pinned <ref>` or JSON and returns `0`.
- `.changeset/gh270-intake-source-doc-comment.md` — EMPTY changeset (`---\n---` + a one-sentence
  note), required by `.github/workflows/changeset-check.yml` for any PR touching `packages/`
  (docs-only changes satisfy the gate with an empty changeset, per the workflow header).

Patch: `0001-docs-prx-expand-intake-source.ts-module-doc-comment-.patch`

## Verify output (trimmed)

Scout's header check (the grep part of `verify_command`):

```
$ cd packages/prx/src/intake && head -1 intake-source.ts | grep -q '^/\*\*' && for s in intakeSourceOptionsSchema IntakeSourceOptions IntakeSourceDeps IntakeSourceError runIntakeSource; do grep -q "$s" <(sed -n '1,/^\*\//p' intake-source.ts) || { echo "header missing $s"; exit 1; }; done && echo HEADER_OK
HEADER_OK
$ grep -n "^export" intake-source.ts     # exactly these five, all named in the header
44:export const intakeSourceOptionsSchema = z.object({
49:export type IntakeSourceOptions = z.infer<typeof intakeSourceOptionsSchema>;
56:export type IntakeSourceDeps = {
69:export class IntakeSourceError extends Error {}
76:export async function runIntakeSource(
```

Proof the change is comment-only (bun's transpiler strips comments):

```
$ bun build --no-bundle --target=bun <main version>  --outfile before.js
$ bun build --no-bundle --target=bun <HEAD version>  --outfile after.js
$ cmp before.js after.js && echo TRANSPILED_IDENTICAL
TRANSPILED_IDENTICAL
$ git diff main..HEAD --stat
 .changeset/gh270-intake-source-doc-comment.md |  6 ++++++
 packages/prx/src/intake/intake-source.ts      | 18 ++++++++++++++++++
$ git diff main..HEAD -- packages | grep -E '^[+-]' | grep -vE '^(\+\+\+|---)|^[+-] \*'   # any changed line NOT a comment line?
(empty)
```

changeset-check gate, simulated with the workflow's own logic:

```
$ changed="$(git diff --name-only main...HEAD)"; echo "$changed" | grep -qE '^packages/' && (echo "$changed" | grep -qE '^\.changeset/.+\.md$' && echo "changeset present — OK." || echo CHANGESET_MISSING)
changeset present — OK.
```

Formatting: biome `lineWidth` is 100; longest header line is 81 chars. Indentation/`*` gutter match the existing block.

`bun run typecheck` / `bun run check` / `bun test packages/prx/test/intake/intake-source.test.ts`
could NOT be run here:

```
$ bun install --frozen-lockfile
< 403 Forbidden
< x-deny-reason: host_not_allowed          (registry.npmjs.org, npm.jsr.io — all package fetches)
$ curl -sS -o /dev/null -w "%{http_code}\n" https://registry.npmjs.org/es-errors
403
$ bun test packages/prx/test/intake/intake-source.test.ts
error: ENOENT reading ".../packages/prx/node_modules/@bounded-systems/cas"
```

The sandbox egress proxy denies every package registry, so `node_modules` cannot be populated
(the sibling clones in /tmp/work have only dangling symlinks for the same reason). Since the
transpiled output is byte-identical to `main`, typecheck/lint/tests cannot have changed
outcome versus `main`; they should still be run by whoever applies the patch (CI will).

## Unresolved

- Repo checks (`bun run typecheck`, `bun run check`, `bun test ...`) not executed locally —
  network policy blocks registry access (see above). Comment-only change; run in CI.
- Per CLAUDE.md, `.claude/org-repair.sh` bootstrap and the `claim-ticket.yml` claim were not
  done (no GitHub credentials in this sandbox); the applier should claim #270 before opening
  the PR.
- The stale `origin/GH-270` branch (`7800b8e`) is superseded by this patch and can be deleted.
- The changeset gate is now satisfied by the empty changeset in the patch; `changeset-check`
  should pass on the PR without further action.

## Before merging (owner)

- [ ] Run `.claude/org-repair.sh bootstrap` and claim #270 via `claim-ticket.yml` (or assign +
      comment by hand) before opening the PR — needs GitHub credentials the sandbox lacks.
- [ ] Open the PR from `claude/burndown-prx-270` (`git am` the patch on `main`), title
      `docs(prx): expand intake-source.ts module doc comment (GH-270)`, body referencing #270.
- [ ] Confirm CI green: `ci`, plus `changeset-check` (empty changeset is included in the patch),
      and the `bun run typecheck && bun run check && bun test packages/prx/test/intake/intake-source.test.ts`
      trio that could not run in the sandbox.
- [ ] Delete the stale `origin/GH-270` branch (`7800b8e`) after merge.

## Ready-to-paste GitHub comment (issue #270)

```
A top-of-file JSDoc block has actually existed on `packages/prx/src/intake/intake-source.ts`
since ef696de (#241), so the literal acceptance criterion was already met on `main`. It was
incomplete against this issue's own text though: it never said the verb is runnable by a human
or an agent, and it didn't describe any of the file's five exports.

Patch (branch `claude/burndown-prx-270`, commit fbd4529) extends that existing block in place:
one paragraph on human/agent invocation + the GH-292 signing gate, and an "Exports" list covering
`intakeSourceOptionsSchema`/`IntakeSourceOptions`, `IntakeSourceDeps`, `IntakeSourceError`,
`runIntakeSource`, each checked against the code. Comment-only for the package: the transpiled
output is byte-identical to `main`. It also adds an empty changeset
(`.changeset/gh270-intake-source-doc-comment.md`) so `changeset-check` passes for a docs-only
change under `packages/`. It supersedes the stale, unmerged `GH-270` branch (7800b8e).

Apply: `git am 0001-docs-prx-expand-intake-source.ts-module-doc-comment-.patch` on `main`, then
`bun run typecheck && bun run check && bun test packages/prx/test/intake/intake-source.test.ts`
(not runnable in the sandbox that produced the patch — registry access is blocked there). The
changeset is already in the patch; no `bunx @changesets/cli add --empty` step is needed.
```

## Fix round

Verdict B (SCOPE + MERGEABILITY, refuted) must_fix items:

1. **Add an empty changeset** — done. Amended the single commit (`fde6a37` → `fbd4529`) to add
   `.changeset/gh270-intake-source-doc-comment.md` with empty frontmatter (`---\n---`) and a
   one-sentence note, matching the repo's prior empty changeset (`gh1068-guard3-empty-changesets.md`).
   Re-ran the `changeset-check` workflow's grep logic locally: `changeset present — OK.`
2. **Update the ready-to-paste comment and Unresolved to mention the changeset** — done (see
   above); the comment now says the changeset is included and no extra step is needed.

Verdict A (CORRECTNESS, not refuted) had no must_fix; two of its wording nits were factual
inaccuracies in the new prose, so they were fixed in the same amend:

- "tests run offline with a stub signer" → "tests can run offline (with a dev key or an injected
  signer)" — the test file uses the real signer under `PRX_PROVENANCE_KEY=dev`.
- "serves ... the intake actor inside the pipeline" → "an agent invoking the same command on the
  pipeline's behalf" — `runIntakeSource` has one caller (`pr-state/cli.ts`); agents use the CLI verb.

Not changed: the "one-paragraph" style nit (both verdicts) — the export list is what the burndown
verify criterion requires; noted for the PR body. Re-checks after the fix: header grep `HEADER_OK`,
transpiled output `TRANSPILED_IDENTICAL`, no non-comment changed lines under `packages/`, longest
header line 81 chars. `bun install` still cannot reach the registry (same 403 / hang as before), so
typecheck/check/test remain for CI; process items are listed under "Before merging (owner)".
