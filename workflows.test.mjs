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

// ── inbound licence policy (#241) ────────────────────────────────────────────
// The dependency-review job is the org's only inbound licence gate, and its
// policy is one `with:` key. Deleting that key leaves a job that still runs,
// still reports, and still goes green — a gate that stops gating without
// looking broken, which is the exact shape the rest of this file exists for.
// Asserted structurally, from the file, for the same reason as everything else
// here: from how it IS wired, not from how it ought to be.
test("repo-standard: dependency-review carries an inbound licence policy", () => {
  const src = readFileSync(join(DIR, "repo-standard.yml"), "utf8");
  assert.match(src, /deny-licenses:/, "dependency-review has no licence policy");

  // The families that would actually poison an MIT package. Spot-checked rather
  // than exhaustively pinned: this guards deletion of the policy, not edits to
  // it — narrowing the list is a reviewed diff, dropping it is an accident.
  for (const id of ["AGPL-3.0-only", "GPL-3.0-only", "SSPL-1.0", "BUSL-1.1",
                    "PolyForm-Noncommercial-1.0.0"]) {
    assert.ok(src.includes(id), `deny-licenses no longer names ${id}`);
  }

  // allow-licenses and deny-licenses are mutually exclusive in the action;
  // setting both makes it error at runtime rather than fail a review.
  assert.doesNotMatch(src, /allow-licenses:/,
    "allow-licenses and deny-licenses cannot both be set");
});

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

// One name for one broker (infra#41). CF_BROKER_URL replaced
// FRONT_DESK_BROKER_URL org-wide, and front-desk-scheduler's `broker-vars` job
// asserts the retirement on every run — but it asserts it from THAT repo, and
// its comment claims "no workflow reads it any more" while two workflows here
// still did. The rename simply never reached this repo, so front-desk-add sat
// gated on a variable that no longer resolves and printed "broker not
// configured — skipping" on every run it ever made. Dormant, green, and silent.
//
// broker-vars cannot see this repo; this test is that assertion's other half.
for (const file of files) {
  test(`${file}: reads CF_BROKER_URL, not the retired FRONT_DESK_BROKER_URL`, () => {
    const offenders = readFileSync(join(DIR, file), "utf8")
      .split("\n")
      .map((line, i) => ({ line, n: i + 1 }))
      // A comment may name the old variable to explain the retirement; an
      // expression that READS it is the bug — it silently never resolves.
      .filter(({ line }) => !line.trim().startsWith("#"))
      .filter(({ line }) => line.includes("FRONT_DESK_BROKER_URL"));

    assert.deepEqual(
      offenders.map(({ n, line }) => `${n}: ${line.trim().slice(0, 70)}`),
      [],
      `${file} reads FRONT_DESK_BROKER_URL, which infra#41 retired in favour of ` +
        `CF_BROKER_URL. An unset variable fails open, so this does not go red — ` +
        `the step just skips forever. Use vars.CF_BROKER_URL.`,
    );
  });
}

// ── No workflow writes history with git; commits go through the API ─────────
//
// This repo's default branch requires verified signatures, and a commit made by
// `git commit` inside a runner carries none. The lane still goes entirely green
// — the branch pushes, the PR opens — and the PR is simply unmergeable forever.
// Every check passing while the outcome is impossible is the required-baseline
// failure shape (infra#135), and it has now happened twice here: org-defaults'
// `pin` hit it live (#128/#129), and registry-graph carried the identical defect
// unexercised the whole time, because it early-exits on "in sync" and had never
// once had real work to do. Two instances of one mistake is where a comment stops
// being enough.
//
// The fix both lanes use is `createCommitOnBranch`: commits made through the API
// are signed by GitHub as the token's identity, so the rule is satisfied with no
// signing key in the runner. This test is the ratchet — a third lane cannot
// reintroduce the shape by copying an older one.
//
// `git push` is covered by the same assertion for the same reason: pushing is how
// a runner-made commit reaches the branch. Comments may name either (both fixed
// lanes explain themselves at length); only an executable occurrence is the bug.
for (const file of files) {
  test(`${file}: creates commits through the API, not git`, () => {
    const offenders = readFileSync(join(DIR, file), "utf8")
      .split("\n")
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => !line.trim().startsWith("#"))
      .filter(({ line }) => /\bgit\s+(commit|push)\b/.test(line));

    assert.deepEqual(
      offenders.map(({ n, line }) => `${n}: ${line.trim().slice(0, 70)}`),
      [],
      `${file} runs git commit/push in the runner. Runner-made commits are ` +
        `unsigned and this repo requires verified signatures, so the lane goes ` +
        `green and produces a PR that can never merge (#129). Force the ref with ` +
        `the refs API, then carry the file changes in one createCommitOnBranch ` +
        `mutation — see the pin job in org-defaults.yml.`,
    );
  });
}

// ── Every local broker-gh-token caller declares the scopes it needs ──────────
//
// The action exports `permissions` so callers can assert their scope before
// doing work, and for months exactly one caller did — asserting `pull_requests`
// and then dying on the unasserted `contents` at `git push`, exit 128, before
// any of its own failure annotations could run (#87). #93 moved the assertion
// into the action behind a `require:` input; this is the half that keeps a
// fourth caller from silently opting out of it.
//
// Scoped to `uses: ./` — the LOCAL action. front-desk-add.yml pins a published
// SHA of an older version where the input does not exist, and is deliberately
// `continue-on-error` (the central sweep is its backstop), so requiring a
// declaration there would be both impossible and pointless.
for (const file of files) {
  const source = readFileSync(join(DIR, file), "utf8");
  if (!source.includes("uses: ./.github/actions/broker-gh-token")) continue;

  test(`${file}: every local broker-gh-token step declares require:`, () => {
    // Each `uses:` line through to the end of its `with:` block. Indentation
    // ends the step, which is enough structure without a YAML dependency —
    // the same trade this file's header records.
    const lines = source.split("\n");
    const missing = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes("uses: ./.github/actions/broker-gh-token")) continue;
      const indent = lines[i].search(/\S/);
      let declared = false;
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j];
        if (line.trim() === "") continue;
        // Strictly less, not `<=`: a step's sibling keys (`with:`, `env:`) sit at
        // the SAME indent as `uses:`, so `<=` stopped at `with:` and never saw
        // the input inside it — reporting both correctly-declared callers as
        // missing. The next step's `- ` marker dedents further, which is what
        // actually ends the block.
        if (line.search(/\S/) < indent) break;
        if (/^\s*require:/.test(line)) { declared = true; break; }
      }
      if (!declared) missing.push(i + 1);
    }

    assert.deepEqual(
      missing,
      [],
      `${file} mints a broker token without declaring require: at line(s) ` +
        `${missing.join(", ")}. State every scope the job will use — a partial ` +
        `preflight is worse than none, because it turns "check your scopes" into ` +
        `"scopes were checked". If the job genuinely only reads, say so in a ` +
        `comment on the step rather than leaving the input off.`,
    );
  });
}

// ── _labels defaults to reporting, and never to deleting ────────────────────
//
// Two inputs on `_labels.yml` are safety properties rather than preferences,
// and both fail SILENTLY if they flip:
//
//   apply: true  — every caller that meant to run a drift CHECK starts writing
//                  instead. The run still goes green, so nothing says so.
//   prune: true  — an undeclared live label is deleted, which strips it from
//                  every issue that carried it. There is no undo, and the
//                  Front Desk projection reads `claimed` by exact name.
//
// A default is one word in a file nobody re-reads, which is exactly the shape
// this file exists to ratchet. Asserted structurally, from the file.
test("_labels: apply and prune default false, strict defaults true", () => {
  const src = readFileSync(join(DIR, "_labels.yml"), "utf8");

  // strict is the third of the same kind: it decides whether a drift REPORT is
  // an alarm or a preview. Flipped to false org-wide, every drift check goes
  // quietly green and the lane still looks like it is watching.
  for (const [input, want] of [["apply", "false"], ["prune", "false"], ["strict", "true"]]) {
    // The input's own block: from `      apply:` to the next key at that
    // indent. Same indentation-bounded read as the broker-gh-token check
    // above, for the same reason — no YAML dependency.
    const lines = src.split("\n");
    const start = lines.findIndex((l) => new RegExp(`^\\s{6}${input}:\\s*$`).test(l));
    assert.notEqual(start, -1, `_labels.yml declares no '${input}' input`);

    const indent = lines[start].search(/\S/);
    let dflt = null;
    for (let i = start + 1; i < lines.length; i++) {
      if (lines[i].trim() === "") continue;
      if (lines[i].search(/\S/) <= indent) break;
      const m = /^\s*default:\s*(\S+)/.exec(lines[i]);
      if (m) { dflt = m[1]; break; }
    }

    assert.equal(
      dflt,
      want,
      `_labels.yml input '${input}' defaults to ${dflt}, must be ${want}. ` +
        `apply:true silently turns every drift CHECK into a write; prune:true ` +
        `silently deletes undeclared labels off every issue carrying them; ` +
        `strict:false silently downgrades every drift alarm to a preview. All ` +
        `three regressions stay green, which is why this is a test not a comment.`,
    );
  }
});

// ── _auto-merge holds contents:write only through the broker, and never fetches the PR ──
//
// The arming lane (.github#386) is called from every gated repo on every PR. Three
// properties make that safe, and each is one line that fails silently if it moves:
//   - it is `pull_request`-shaped and never `pull_request_target` — the PR's code gets no
//     write token and no run in the base repo's context;
//   - it checks nothing out — nothing from the PR is fetched or executed;
//   - its only write identity is the broker door `pr-arm`, asserted for both scopes it
//     uses, so a caller that forgets `id-token: write` fails at the mint naming the gap.
// Asserted structurally, from the file.
test("_auto-merge: broker-minted identity, no checkout, never pull_request_target", () => {
  // Comments are stripped first: the header NAMES pull_request_target to say never.
  const src = readFileSync(join(DIR, "_auto-merge.yml"), "utf8")
    .split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  assert.doesNotMatch(src, /pull_request_target/, "_auto-merge must never run in the base repo's context on a fork PR");
  assert.doesNotMatch(src, /actions\/checkout/, "_auto-merge must not fetch the PR (or anything)");
  assert.match(src, /uses: bounded-systems\/\.github\/\.github\/actions\/broker-gh-token@[0-9a-f]{40}/, "the broker action is SHA-pinned");
  assert.match(src, /app: pr-arm/, "the door is pr-arm");
  assert.match(src, /require: contents, pull_requests/, "both scopes the job uses are asserted at mint");
  assert.match(src, /id-token: write/, "the job declares the OIDC grant it needs from its caller");
  // The only token that arms is the minted one — GITHUB_TOKEN reads the rules and nothing more.
  const armStep = src.slice(src.indexOf("name: Arm auto-merge"));
  assert.match(armStep, /GH_TOKEN: \$\{\{ steps\.app-token\.outputs\.token \}\}/, "the arm step uses the minted token");
  assert.doesNotMatch(armStep, /github\.token/, "the arm step never falls back to GITHUB_TOKEN");
});
