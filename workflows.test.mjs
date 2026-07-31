// Structural checks on the workflow files themselves.
//
// ── Why this exists ──────────────────────────────────────────────────────────
// org-defaults.yml shipped a `gh pr create --body "..."` whose prose — blank
// lines, a `---` rule, a leading `_` — sat at COLUMN 0 inside a `run: |` block
// scalar. A non-empty line at column 0 ends the scalar, and `---` there starts
// a new YAML document, so the file stopped being a workflow at all.
//
// What makes that worth a gate rather than a fix is how it FAILED. GitHub does
// not report an unparseable workflow as a failing check on the PR; it records a
// run named by the file's raw path, and the jobs inside it — here `schema`, the
// job that runs every test in this repo — simply never happen. The pull request
// showed seven checks, all green, with the test suite never executed. A break
// that removes your gates does not look like a break.
//
// ── What this can and cannot see ─────────────────────────────────────────────
// It runs from the `schema` job, i.e. from inside org-defaults.yml. So it fully
// covers the other eleven workflows, and covers org-defaults.yml itself only
// before a push — locally, or on a PR where org-defaults.yml still parses. If
// org-defaults.yml is ALREADY broken on a branch, this cannot run to say so.
//
// The half that WOULD catch that is `schema` being a required status check: one
// that never reports blocks the merge. IT IS NOT ONE TODAY. Measured 2026-07-31,
// the same day this was written: `.github` is absent from the `ci-green` ruleset
// (which names `front-desk-scheduler` only), and this repo's default branch
// carries `pull_request`, `required_signatures`, `required_linear_history` and
// `non_fast_forward` — none of which look at CI at all. So the gap is open.
//
// Stating it as closed, which an earlier draft of this comment did, would be the
// exact mistake the file exists to catch: a mechanism asserted from how it ought
// to be wired rather than from how it is. `.github` does meet the documented
// prerequisite for joining `ci-green` — one always-run job with a stable name,
// which `schema` is — and that is a change to org/rulesets/ci-green.json in
// `.github-private`, not to this repo.
//
// A real YAML parser would be a better check and would need a dependency. This
// asserts the one structural property that broke, which is cheap and exact.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = ".github/workflows";
const files = readdirSync(DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));

test("there are workflows to check", () => {
  // Guards the guard: a bad path here would make every test below vacuously
  // pass, which is the failure mode this whole file exists to complain about.
  assert.ok(files.length > 0, `no workflow files found in ${DIR}`);
});

for (const file of files) {
  test(`${file}: nothing but a top-level key starts at column 0`, () => {
    const offenders = readFileSync(join(DIR, file), "utf8")
      .split("\n")
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => line.length > 0 && !/^\s/.test(line))
      // A top-level mapping key (`name:`, `on:`, `jobs:`) or a comment. Anything
      // else at column 0 is block-scalar content that escaped its indentation.
      .filter(({ line }) => !/^[A-Za-z_][\w-]*:/.test(line) && !line.startsWith("#"));

    assert.deepEqual(
      offenders.map(({ n, line }) => `${n}: ${line.slice(0, 60)}`),
      [],
      `${file} has content at column 0 — a run: | block scalar has leaked. ` +
        `Prose belongs in a file passed with --body-file, not inline.`,
    );
  });
}
