// Behaviour tests for repo-standard-conformance.mjs — the classifier pinned
// against real callers, and the sweep pinned against a fake fetch so the two
// refusals that matter (a short denominator, a credential that reads nothing)
// are exercised rather than trusted.
//
//   bun test scripts/repo-standard-conformance.test.mjs
//
// Runs under bun, not node: the YAML parser is Bun.YAML, and the fixtures below
// are real workflow text (fetched 2026-09-04 over raw.githubusercontent.com
// from keycard, guest-room, conformance-kit and repo-health, plus the bare
// `merge_group:` the conformance template gained on 2026-09-10 for the merge
// queue — .github-private#913 step 5) — the point is that a caller shaped like
// the ones in the org classifies the way the survey classified it by hand. The suite uses node:test's API so it reads like every
// other suite here; `.claude/test-coverage.test.mjs` recognises the `bun test`
// line in org-defaults.yml for the same reason it recognises `node --test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ORG,
  STANDARD_INPUT_DEFAULTS,
  assertDenominator,
  buildSnapshot,
  classifyRepo,
  findCaller,
  fleetSlice,
  matchStandard,
  mergeGroupTrigger,
  orderRows,
  parseYaml,
  pullRequestTrigger,
  pushesDefault,
  renderSummary,
  runtimeExpectation,
  summarize,
  sweep,
  readRules,
  readRulesetNames,
  PUBLISHABLE_RULESET_NAMES,
} from "./repo-standard-conformance.mjs";

// ── fixtures: real callers ───────────────────────────────────────────────────

const KEYCARD = `name: standard
on:
  push:
    branches: [main]
  pull_request:
  merge_group:
permissions:
  contents: read
jobs:
  standard:
    uses: bounded-systems/.github/.github/workflows/repo-standard.yml@d126d721fa50275e12af0bdeaf1a2ff3016eedfd
    with:
      security: true
      test: true
      runtime: none
      test-command: >-
        curl --proto '=https' --tlsv1.2 -sSf https://elan.lean-lang.org/elan-init.sh
        | sh -s -- -y --default-toolchain none
        && export PATH="$HOME/.elan/bin:$PATH"
        && lake build
        && cargo test --manifest-path tools/Cargo.toml --locked
        && cargo clippy --manifest-path tools/Cargo.toml --all-targets -- -D warnings
        && bash specs/tla/check.sh
`;

const GUEST_ROOM = `name: standard
on:
  push:
    branches: [main]
  pull_request:
  merge_group:
permissions:
  contents: read
jobs:
  standard:
    uses: bounded-systems/.github/.github/workflows/repo-standard.yml@d43c3280588ef05f4ead43426db1091d4cb8f520
    with:
      security: true
      test: true
      runtime: bun
      test-command: "bun test"
`;

const CONFORMANCE_KIT = `name: standard
on:
  push:
    branches: [main]
  pull_request:
  merge_group:
permissions:
  contents: read
jobs:
  standard:
    uses: bounded-systems/.github/.github/workflows/repo-standard.yml@d126d721fa50275e12af0bdeaf1a2ff3016eedfd
    with:
      security: true
      test: true
      runtime: node
      test-command: "npm ci && npm test"
`;

// repo-health: a deno repo with its own ci.yml and NO standard caller.
const REPO_HEALTH_CI = `name: ci
on:
  push:
    branches: [main]
  pull_request:
permissions:
  contents: read
jobs:
  deno:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - run: deno test --allow-read
`;

const DEPS = `name: deps
on:
  pull_request:
  push:
    branches: [main]
  schedule:
    - cron: "23 7 * * 2"
  workflow_dispatch: {}
permissions:
  contents: read
jobs:
  osv:
    uses: bounded-systems/ci-workflows/.github/workflows/osv-scan.yml@fb7ca62fd9fb8af90af1097a0b21ee703c103dc4 # main
`;

const FRONT_DESK_ADD = `name: front-desk-add
on:
  issues:
    types: [opened]
  pull_request:
    types: [opened]
permissions:
  contents: read
jobs:
  add:
    runs-on: ubuntu-latest
    steps:
      - run: echo add
`;

// This repo's own caller, verbatim shape: a LOCAL uses and a path-filtered
// pull_request. It is a selftest, not this repo's gate — \`schema\` is — so the
// trigger predicate is not applied to a local caller (see the test below).
const SELFTEST = readFileSync(new URL("../.github/workflows/repo-standard-selftest.yml", import.meta.url), "utf8");

const wf = (path, text) => ({ path, doc: parseYaml(text), error: null });
const run = (conclusion) => ({ conclusion, url: `https://github.com/${ORG}/x/actions/runs/1`, sha: "abc", at: "2026-09-04T00:00:00Z", event: "push" });

// ── matchStandard / triggers ─────────────────────────────────────────────────

test("matchStandard: the org path with a SHA, a tag, a local ref, and anything else", () => {
  assert.deepEqual(matchStandard("bounded-systems/.github/.github/workflows/repo-standard.yml@d126d721fa50275e12af0bdeaf1a2ff3016eedfd"), { pin: "d126d721fa50275e12af0bdeaf1a2ff3016eedfd", local: false });
  assert.deepEqual(matchStandard("bounded-systems/.github/.github/workflows/repo-standard.yml@v1"), { pin: "v1", local: false });
  assert.deepEqual(matchStandard("./.github/workflows/repo-standard.yml"), { pin: "local", local: true });
  assert.equal(matchStandard("bounded-systems/ci-workflows/.github/workflows/osv-scan.yml@abc"), null);
  assert.equal(matchStandard(undefined), null);
});

test("pullRequestTrigger: the survey's predicate over every `on:` shape", () => {
  assert.deepEqual(pullRequestTrigger("pull_request"), { present: true, unfiltered: true, synchronize: true });
  assert.deepEqual(pullRequestTrigger(["push", "pull_request"]), { present: true, unfiltered: true, synchronize: true });
  assert.deepEqual(pullRequestTrigger({ pull_request: null }), { present: true, unfiltered: true, synchronize: true });
  assert.deepEqual(pullRequestTrigger({ pull_request: { paths: ["x/**"] } }), { present: true, unfiltered: false, synchronize: true });
  assert.deepEqual(pullRequestTrigger({ pull_request: { "paths-ignore": ["docs/**"] } }), { present: true, unfiltered: false, synchronize: true });
  // front-desk-add's shape: reports once on `opened` and never again — the survey excludes it for exactly this.
  assert.deepEqual(pullRequestTrigger({ pull_request: { types: ["opened"] } }), { present: true, unfiltered: true, synchronize: false });
  assert.deepEqual(pullRequestTrigger({ push: { branches: ["main"] } }), { present: false });
  assert.deepEqual(pullRequestTrigger(undefined), { present: false });
});

test("mergeGroupTrigger: the key's presence over every `on:` shape", () => {
  assert.equal(mergeGroupTrigger({ pull_request: null, merge_group: null }), true, "a bare key is the template's shape");
  assert.equal(mergeGroupTrigger({ pull_request: null, merge_group: { types: ["checks_requested"] } }), true);
  assert.equal(mergeGroupTrigger({ pull_request: null, push: { branches: ["main"] } }), false);
  assert.equal(mergeGroupTrigger(["pull_request", "merge_group"]), true);
  assert.equal(mergeGroupTrigger(["pull_request"]), false);
  assert.equal(mergeGroupTrigger("merge_group"), true);
  assert.equal(mergeGroupTrigger("pull_request"), false);
  assert.equal(mergeGroupTrigger(undefined), false);
});

test("pushesDefault: branches list, unfiltered push, list form", () => {
  assert.equal(pushesDefault({ push: { branches: ["main"] } }, "main"), true);
  assert.equal(pushesDefault({ push: { branches: ["release"] } }, "main"), false);
  assert.equal(pushesDefault({ push: null }, "main"), true);
  assert.equal(pushesDefault(["push"], "main"), true);
  assert.equal(pushesDefault({ pull_request: null }, "main"), false);
});

// ── findCaller ───────────────────────────────────────────────────────────────

test("findCaller: merge_group is reported per caller — present on the template's shape, absent on a pull_request-only caller", () => {
  assert.equal(findCaller([wf(".github/workflows/standard.yml", KEYCARD)]).merge_group, true);
  const legacy = GUEST_ROOM.replace("  merge_group:\n", "");
  assert.equal(findCaller([wf(".github/workflows/standard.yml", legacy)]).merge_group, false);
});

test("findCaller: keycard — pinned, folded test-command flattened, effective inputs carry the defaults", () => {
  const c = findCaller([wf(".github/workflows/standard.yml", KEYCARD)]);
  assert.equal(c.state, "present");
  assert.equal(c.job, "standard");
  assert.equal(c.pin, "d126d721fa50275e12af0bdeaf1a2ff3016eedfd");
  assert.equal(c.pinned, true);
  assert.equal(c.effective.test, true);
  assert.equal(c.effective.runtime, "none");
  assert.equal(c.effective.quality, true, "an input the caller did not write takes the standard's default");
  assert.equal(c.effective["security-gate"], false);
  assert.match(c.effective["test-command"], /lake build/);
  assert.match(c.effective["test-command"], /specs\/tla\/check\.sh/);
  assert.deepEqual(c.pull_request, { present: true, unfiltered: true, synchronize: true });
  assert.equal(c.push_default, true);
});

test("findCaller: a repo with no caller is `absent`, and the org's other lanes do not count as one", () => {
  const c = findCaller([wf(".github/workflows/ci.yml", REPO_HEALTH_CI), wf(".github/workflows/deps.yml", DEPS)]);
  assert.deepEqual(c, { state: "absent" });
});

test("findCaller: this repo's own selftest is a local, pinned-by-construction caller", () => {
  const c = findCaller([wf(".github/workflows/repo-standard-selftest.yml", SELFTEST)]);
  assert.equal(c.state, "present");
  assert.equal(c.pin, "local");
  assert.equal(c.pinned, true);
  assert.equal(c.effective.security, true);
});

test("STANDARD_INPUT_DEFAULTS names every input repo-standard.yml declares, with its default", () => {
  // Read the reusable workflow rather than restate it: a new input with no
  // entry here would make every row's `effective` silently incomplete.
  const src = readFileSync(new URL("../.github/workflows/repo-standard.yml", import.meta.url), "utf8");
  const doc = parseYaml(src);
  const declared = doc.on.workflow_call.inputs;
  for (const [name, spec] of Object.entries(declared)) {
    if (name === "conformance-kit-ref" || name === "deno-version") continue; // pins, not behaviours
    assert.ok(name in STANDARD_INPUT_DEFAULTS, `repo-standard.yml declares '${name}' and STANDARD_INPUT_DEFAULTS does not`);
    assert.equal(STANDARD_INPUT_DEFAULTS[name], spec.default, `default for '${name}' drifted`);
  }
});

// ── runtimeExpectation ───────────────────────────────────────────────────────

test("runtimeExpectation: manifests imply toolchains; `none` is right for cargo and lean; nothing implied is null", () => {
  assert.deepEqual(runtimeExpectation(["Cargo.toml", "lakefile.lean", "README.md"], "none"), { expected: ["cargo", "lean"], configured: "none", match: true });
  assert.deepEqual(runtimeExpectation(["deno.json"], "bun"), { expected: ["deno"], configured: "bun", match: false });
  assert.deepEqual(runtimeExpectation(["package.json", "bun.lock"], "bun"), { expected: ["bun", "node"], configured: "bun", match: true });
  assert.deepEqual(runtimeExpectation(["README.md", "LICENSE"], "none"), { expected: [], configured: "none", match: null });
});

// ── classifyRepo ─────────────────────────────────────────────────────────────

test("classifyRepo: keycard-shaped — no findings, green run, managed and extra split, fleet joined", () => {
  const row = classifyRepo({
    repo: "keycard",
    files: [wf(".github/workflows/standard.yml", KEYCARD), wf(".github/workflows/deps.yml", DEPS), wf(".github/workflows/front-desk-add.yml", FRONT_DESK_ADD)],
    root: ["Cargo.toml", "lakefile.lean", "README.md", "specs"],
    run: run("success"),
    fleet: { unobserved: false, red: [] },
    headSha: "d126d721fa50275e12af0bdeaf1a2ff3016eedfd",
    tier: "critical",
  });
  assert.equal(row.repo, "bounded-systems/keycard");
  assert.deepEqual(row.findings, []);
  assert.deepEqual(row.gaps, []);
  assert.equal(row.caller.pin_is_head, true);
  assert.equal(row.test_lane, "present");
  assert.deepEqual(row.manifests, ["Cargo.toml", "lakefile.lean"]);
  assert.equal(row.runtime.match, true);
  assert.equal(row.standard_run.state, "green");
  assert.deepEqual(row.managed, ["deps.yml", "front-desk-add.yml", "standard.yml"]);
  assert.deepEqual(row.extra, []);
  assert.equal(row.tier, "critical");
  assert.equal(row.fleet.unobserved, false);
});

test("classifyRepo: a deno repo with its own ci.yml and no caller — one finding, the extra workflow listed with what it runs on", () => {
  const row = classifyRepo({
    repo: "repo-health",
    files: [wf(".github/workflows/ci.yml", REPO_HEALTH_CI), wf(".github/workflows/deps.yml", DEPS), wf(".github/workflows/front-desk-add.yml", FRONT_DESK_ADD)],
    root: ["deno.json", "deno.lock", "mod.ts", "src"],
    run: null,
  });
  assert.deepEqual(row.findings, ["caller-absent"], "the absent test lane is not counted a second time when there is no caller at all");
  assert.equal(row.test_lane, "absent");
  assert.equal(row.standard_run, null);
  assert.deepEqual(row.gaps, []);
  assert.equal(row.extra.length, 1);
  assert.equal(row.extra[0].path, ".github/workflows/ci.yml");
  assert.deepEqual(row.extra[0].on, ["push", "pull_request"]);
  assert.deepEqual(row.extra[0].uses, []);
  assert.deepEqual(row.runtime, { expected: ["deno"], configured: null, match: false });
});

test("classifyRepo: a toolchain with `test: false` is the fail-open case, and it is a finding", () => {
  const text = GUEST_ROOM.replace("test: true", "test: false");
  const row = classifyRepo({ repo: "x", files: [wf(".github/workflows/standard.yml", text)], root: ["bun.lock", "package.json"], run: run("success") });
  assert.deepEqual(row.findings, ["test-lane-absent"]);
  assert.equal(row.test_lane, "absent");
});

test("classifyRepo: a docs-only repo has no test lane to miss", () => {
  const row = classifyRepo({ repo: "x", files: [wf(".github/workflows/standard.yml", CONFORMANCE_KIT)], root: ["README.md", "docs"], run: run("success") });
  assert.equal(row.test_lane, "n/a");
  assert.deepEqual(row.findings, []);
});

test("classifyRepo: an unpinned ref and a path-filtered pull_request are findings; runtime mismatch is not", () => {
  const text = CONFORMANCE_KIT
    .replace("@d126d721fa50275e12af0bdeaf1a2ff3016eedfd", "@main")
    .replace("  pull_request:\n", "  pull_request:\n    paths: [\"src/**\"]\n");
  const row = classifyRepo({ repo: "x", files: [wf(".github/workflows/standard.yml", text)], root: ["deno.json"], run: run("success") });
  assert.deepEqual(row.findings.sort(), ["pin-not-sha", "pull-request-filtered", "test-lane-absent"].sort().filter((f) => f !== "test-lane-absent"));
  assert.equal(row.runtime.match, false, "node runtime on a deno manifest is reported");
  assert.ok(!row.findings.includes("runtime-mismatch"), "…but never a finding");
});

test("classifyRepo: a caller with merge_group has no finding for it; a pull_request-only caller is merge-group-absent — the queue would wait on it forever", () => {
  const withKey = classifyRepo({ repo: "gr", files: [wf(".github/workflows/standard.yml", GUEST_ROOM)], root: ["package.json", "bun.lock"], run: run("success") });
  assert.equal(withKey.caller.merge_group, true);
  assert.deepEqual(withKey.findings, []);

  const without = classifyRepo({ repo: "gr", files: [wf(".github/workflows/standard.yml", GUEST_ROOM.replace("  merge_group:\n", ""))], root: ["package.json", "bun.lock"], run: run("success") });
  assert.equal(without.caller.merge_group, false);
  assert.deepEqual(without.findings, ["merge-group-absent"]);
  // The pull_request predicate is untouched by the new key: both halves report independently.
  assert.deepEqual(without.caller.pull_request, { present: true, unfiltered: true, synchronize: true });
});

test("classifyRepo: the local selftest caller is exempt from the trigger predicate — this repo's gate is `schema`", () => {
  const row = classifyRepo({ repo: ".github", files: [wf(".github/workflows/repo-standard-selftest.yml", SELFTEST)], root: ["package.json", "bun.lock"], run: run("success") });
  assert.ok(!row.findings.includes("pull-request-filtered"), row.findings.join(","));
  assert.match(row.caller.trigger_predicate, /not applied/);
  assert.equal(row.caller.pin, "local");
  assert.equal(row.caller.pin_is_head, null);
  // ...but NOT from the merge_group half: the selftest is the reference every
  // standard.yml copies, so it carries the key it is measured for.
  assert.equal(row.caller.merge_group, true, "repo-standard-selftest.yml must trigger on merge_group");
  // And this is TRUE of this repo, left in on purpose: its tests run in
  // org-defaults.yml's schema job, not through the standard's test lane. The
  // standard's own repo is the first "extra CI that could fold into the
  // standard" the projection reports.
  assert.deepEqual(row.findings, ["test-lane-absent"]);
});

test("classifyRepo: run states — red conclusions are findings, cancelled is `other`, 403 and none are gaps", () => {
  const files = [wf(".github/workflows/standard.yml", GUEST_ROOM)];
  const root = ["bun.lock"];
  assert.deepEqual(classifyRepo({ repo: "a", files, root, run: run("failure") }).findings, ["standard-run-red"]);
  assert.deepEqual(classifyRepo({ repo: "a", files, root, run: run("startup_failure") }).findings, ["standard-run-red"]);
  const cancelled = classifyRepo({ repo: "a", files, root, run: run("cancelled") });
  assert.equal(cancelled.standard_run.state, "other");
  assert.deepEqual(cancelled.findings, []);
  const unreadable = classifyRepo({ repo: "a", files, root, run: { unreadable: "403" } });
  assert.equal(unreadable.standard_run.state, "unreadable");
  assert.deepEqual(unreadable.findings, []);
  assert.deepEqual(unreadable.gaps, ["standard-run-unreadable"]);
  const none = classifyRepo({ repo: "a", files, root, run: null });
  assert.equal(none.standard_run.state, "none");
  assert.deepEqual(none.gaps, ["standard-run-none"]);
});

test("classifyRepo: an unreadable workflows listing is a gap, never a finding, and never `absent`", () => {
  const row = classifyRepo({ repo: "x", files: null, filesError: "403", root: null, rootError: "403" });
  assert.equal(row.caller.state, "unreadable");
  assert.deepEqual(row.findings, []);
  assert.deepEqual(row.gaps, ["workflows-unreadable", "root-unreadable:403"]);
  assert.equal(row.test_lane, "unmeasured");
});

test("classifyRepo: a workflow that does not parse is recorded on the row, not dropped", () => {
  const files = [wf(".github/workflows/standard.yml", GUEST_ROOM), { path: ".github/workflows/broken.yml", doc: null, error: "parse: bad" }];
  const row = classifyRepo({ repo: "x", files, root: ["bun.lock"], run: run("success") });
  assert.deepEqual(row.workflows.parse_errors, [".github/workflows/broken.yml"]);
  assert.equal(row.extra[0].parse_error, "parse: bad");
});

// ── denominator, summary, snapshot ───────────────────────────────────────────

// ── the dark-factory arrangement (.github-private#913 step 4) ────────────────

const RULES_37 = { read: true, contexts: ["pr-claim / pr-claim", "standard / test"], rulesets: [21805316, 22333366] };
// The name side, shaped like a real listing: one publishable name, one withheld.
const NAMES_37 = { read: true, names: { 21805316: "required-baseline", 22333366: "ci-green-dot-github" } };
const AUTO_MERGE = `name: auto-merge
on:
  pull_request:
    types: [opened, reopened, ready_for_review, synchronize]
permissions:
  contents: read
jobs:
  auto-merge:
    permissions:
      contents: read
      id-token: write
    uses: bounded-systems/.github/.github/workflows/_auto-merge.yml@2cd9ebc0a2543b3ba11dc7673b351a9d1f6c9445
`;
const RUST_ROOT = ["Cargo.toml", "lakefile.lean"];

test("readRules: the required contexts and the rulesets that require them; anything but a 200 array is unreadable", () => {
  const r = readRules({ status: 200, body: [
    { type: "required_status_checks", ruleset_id: 22333366, parameters: { required_status_checks: [{ context: "standard / test" }] } },
    { type: "required_status_checks", ruleset_id: 21805316, parameters: { required_status_checks: [{ context: "pr-claim / pr-claim" }] } },
    { type: "required_signatures", ruleset_id: 1 },
  ] });
  assert.deepEqual(r, RULES_37);
  assert.deepEqual(readRules({ status: 200, body: [] }), { read: true, contexts: [], rulesets: [] });
  // A failed read is never an empty gate.
  assert.deepEqual(readRules({ status: 403, body: { message: "no" } }), { read: false, reason: "403" });
  assert.deepEqual(readRules({ status: 200, body: { not: "an array" } }), { read: false, reason: "200" });
});

test("readRulesetNames: ids to names, redacted to the allowlist; anything but a 200 array is unreadable", () => {
  const r = readRulesetNames({ status: 200, body: [
    { id: 22333366, name: "ci-green-dot-github", enforcement: "active", source_type: "Organization" },
    { id: 21805316, name: "required-baseline", enforcement: "active", source_type: "Organization" },
    // A name the allowlist does not admit: the id is kept, the name is withheld —
    // NOT dropped, so the row shows that something applies here it did not name.
    { id: 18646713, name: "default-branch-protection", enforcement: "active" },
    { id: 999, enforcement: "active" },        // no name at all: skipped, not published as null
    { name: "no id either" },
  ] });
  assert.deepEqual(r, { read: true, names: { 18646713: null, 21805316: "required-baseline", 22333366: "ci-green-dot-github" } });
  assert.deepEqual(readRulesetNames({ status: 200, body: [] }), { read: true, names: {} });
  // Missing attribution is never wrong attribution, and never "no ruleset applies".
  assert.deepEqual(readRulesetNames({ status: 403, body: { message: "no" } }), { read: false, reason: "403" });
  assert.deepEqual(readRulesetNames({ status: 200, body: { not: "an array" } }), { read: false, reason: "200" });
  // Integer-like keys serialise ascending, so the committed snapshot diffs stably.
  assert.equal(JSON.stringify(r.names), '{"18646713":null,"21805316":"required-baseline","22333366":"ci-green-dot-github"}');
});

// This is the redaction's safety argument, mechanised. A name may be published only
// because it is ALREADY a public string in this repo; if that stops being true, or if
// someone adds a name that was never public, this fails rather than leaking. The two
// files that carry the list are excluded, or the check would prove itself.
test("PUBLISHABLE_RULESET_NAMES: every publishable name is already committed elsewhere in this public repo", () => {
  const SELF = ["scripts/repo-standard-conformance.mjs", "scripts/repo-standard-conformance.test.mjs"];
  const ROOT = fileURLToPath(new URL("../", import.meta.url));
  const corpus = [];
  (function walk(rel) {
    for (const e of readdirSync(ROOT + rel, { withFileTypes: true })) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const path = rel + e.name;
      if (e.isDirectory()) walk(path + "/");
      else if (e.isFile() && !SELF.includes(path) && statSync(ROOT + path).size < 1_000_000) {
        corpus.push(readFileSync(ROOT + path, "utf8"));
      }
    }
  })("");
  assert.ok(corpus.length > 50, `expected this repo's tree, found ${corpus.length} files — the proof would be vacuous`);
  for (const name of PUBLISHABLE_RULESET_NAMES) {
    assert.ok(corpus.some((t) => t.includes(name)), `"${name}" may not be published: it is not committed anywhere else in this public repo`);
  }
  // And the list is a redaction, not a pass-through: a name shaped like the family
  // but carrying a repo this lane never read is NOT admitted by being ci-green-ish.
  assert.equal(PUBLISHABLE_RULESET_NAMES.has("ci-green-fleet"), false);
});

test("classifyRepo: dark factory — the standard and the claim required, and the arming lane present, is gate_ready with no finding", () => {
  const row = classifyRepo({ repo: "desk", files: [wf(".github/workflows/standard.yml", KEYCARD), wf(".github/workflows/auto-merge.yml", AUTO_MERGE)], root: RUST_ROOT, run: run("success"), rules: RULES_37, rulesetNames: NAMES_37 });
  assert.deepEqual(row.dark_factory, { required_checks: ["pr-claim / pr-claim", "standard / test"], rulesets: [21805316, 22333366], ruleset_names: { 21805316: "required-baseline", 22333366: "ci-green-dot-github" }, arming_lane: "auto-merge.yml", gate_ready: true });
  assert.deepEqual(row.findings, []);
  assert.deepEqual(row.gaps, []);
  // The caller is org-managed, so it is not counted as extra CI.
  assert.deepEqual(row.extra, []);
  assert.ok(row.managed.includes("auto-merge.yml"));
});

test("classifyRepo: dark factory — gated but unarmed is a finding; a caller nothing requires is the fail-open finding", () => {
  const unarmed = classifyRepo({ repo: "k", files: [wf(".github/workflows/standard.yml", KEYCARD)], root: RUST_ROOT, run: run("success"), rules: RULES_37 });
  assert.deepEqual(unarmed.findings, ["arming-lane-absent"]);
  assert.equal(unarmed.dark_factory.gate_ready, false);

  const ungated = classifyRepo({ repo: "k", files: [wf(".github/workflows/standard.yml", KEYCARD)], root: RUST_ROOT, run: run("success"), rules: { read: true, contexts: [], rulesets: [] } });
  assert.deepEqual(ungated.findings, ["gate-absent"], "green that gates nothing is the fail-open case");
  assert.equal(ungated.dark_factory.gate_ready, false);

  // No caller and no rules: caller-absent already says it; gate-absent is about a caller whose green decides nothing.
  const bare = classifyRepo({ repo: "k", files: [], root: [], rules: { read: true, contexts: [], rulesets: [] } });
  assert.deepEqual(bare.findings, ["caller-absent"]);

  // THE CLAIM ALONE IS NOT A GATE (#391). required-baseline requires pr-claim on every default
  // branch, so a caller whose only required context is the claim is still the fail-open case,
  // and a bare repo with only the claim is neither gated nor unarmed-while-gated.
  const claimOnly = { read: true, contexts: ["pr-claim / pr-claim"], rulesets: [21805316] };
  const claimGated = classifyRepo({ repo: "k", files: [wf(".github/workflows/standard.yml", KEYCARD)], root: RUST_ROOT, run: run("success"), rules: claimOnly });
  assert.deepEqual(claimGated.findings, ["gate-absent"], "the claim is the human touch, not CI — nothing requires the standard");
  assert.deepEqual(claimGated.dark_factory.required_checks, ["pr-claim / pr-claim"], "the claim is still LISTED; it just does not count as a gate");
  const bareClaim = classifyRepo({ repo: "k", files: [], root: [], rules: claimOnly });
  assert.deepEqual(bareClaim.findings, ["caller-absent"], "no caller and no CI gate: not arming-lane-absent — there is no green to wait on");

  // Gated by something other than the standard (this repo's own `schema`): gated, unarmed, not gate_ready — the standard is not what is required.
  const schema = classifyRepo({ repo: "dot", files: [wf(".github/workflows/standard.yml", KEYCARD), wf(".github/workflows/auto-merge.yml", AUTO_MERGE)], root: RUST_ROOT, run: run("success"), rules: { read: true, contexts: ["pr-claim / pr-claim", "schema"], rulesets: [1] } });
  assert.deepEqual(schema.findings, []);
  assert.equal(schema.dark_factory.gate_ready, false);
});

// The point of the field: `gate-absent` says a caller's green decides nothing, and on
// its own it does not say WHY. The applying rulesets, by name, split the two remedies.
test("classifyRepo: dark factory — ruleset names attribute gate-absent to enrolment or to a toothless ruleset", () => {
  const caller = [wf(".github/workflows/standard.yml", KEYCARD)];
  const claimOnly = { read: true, contexts: ["pr-claim / pr-claim"], rulesets: [21805316] };

  // Never enrolled: the org floor applies, no ci-green ruleset does. Remedy: add the repo.
  const unenrolled = classifyRepo({ repo: "k", files: caller, root: RUST_ROOT, run: run("success"), rules: claimOnly, rulesetNames: { read: true, names: { 21805316: "required-baseline" } } });
  assert.deepEqual(unenrolled.findings, ["gate-absent"]);
  assert.deepEqual(unenrolled.dark_factory.ruleset_names, { 21805316: "required-baseline" });

  // Enrolled but toothless: ci-green applies and still requires no CI context.
  // Remedy: fix the ruleset. Same finding, and now the row tells them apart.
  const toothless = classifyRepo({ repo: "k", files: caller, root: RUST_ROOT, run: run("success"), rules: claimOnly, rulesetNames: { read: true, names: { 21805316: "required-baseline", 22333366: "ci-green-dot-github" } } });
  assert.deepEqual(toothless.findings, ["gate-absent"], "attribution changes nothing about the verdict");
  assert.deepEqual(toothless.dark_factory.rulesets, [21805316], "still only the rulesets that require a check");
  assert.deepEqual(toothless.dark_factory.ruleset_names, { 21805316: "required-baseline", 22333366: "ci-green-dot-github" }, "but every ruleset that APPLIES is named, which is what attributes the finding");

  // A ruleset applies whose name is not public: the id says something is there, the
  // null says this lane will not name it. Not dropped, not guessed at.
  const withheld = classifyRepo({ repo: "k", files: caller, root: RUST_ROOT, run: run("success"), rules: claimOnly, rulesetNames: readRulesetNames({ status: 200, body: [{ id: 21805316, name: "required-baseline" }, { id: 4242, name: "some-ruleset-named-elsewhere" }] }) });
  assert.deepEqual(withheld.dark_factory.ruleset_names, { 4242: null, 21805316: "required-baseline" });
  assert.deepEqual(withheld.findings, ["gate-absent"]);
});

test("classifyRepo: dark factory — unreadable rules are a gap with the status, never a finding; not measured at all is null", () => {
  const unreadable = classifyRepo({ repo: "k", files: [wf(".github/workflows/standard.yml", KEYCARD)], root: RUST_ROOT, run: run("success"), rules: { read: false, reason: "403" } });
  assert.deepEqual(unreadable.findings, []);
  assert.deepEqual(unreadable.gaps, ["rules-unreadable:403"]);
  assert.equal(unreadable.dark_factory.gate_ready, null);
  assert.equal(unreadable.dark_factory.required_checks, null);
  assert.equal(unreadable.dark_factory.ruleset_names, null, "rulesetNames not passed: attribution is absent, and silent");
  // The two listings fail independently. A names 403 is its own gap with its own status,
  // and it never lets the gate read as empty: required_checks still comes from `rules`.
  const noNames = classifyRepo({ repo: "k", files: [wf(".github/workflows/standard.yml", KEYCARD), wf(".github/workflows/auto-merge.yml", AUTO_MERGE)], root: RUST_ROOT, run: run("success"), rules: RULES_37, rulesetNames: { read: false, reason: "403" } });
  assert.deepEqual(noNames.findings, [], "an unnamed ruleset is a limit of this lane, never a defect of the repo");
  assert.deepEqual(noNames.gaps, ["ruleset-names-unreadable:403"]);
  assert.equal(noNames.dark_factory.ruleset_names, null);
  assert.deepEqual(noNames.dark_factory.required_checks, ["pr-claim / pr-claim", "standard / test"]);
  assert.equal(noNames.dark_factory.gate_ready, true, "the gate is read from its own endpoint and is unaffected");
  // Both down: two gaps, in endpoint order, still no finding.
  const neither = classifyRepo({ repo: "k", files: [wf(".github/workflows/standard.yml", KEYCARD)], root: RUST_ROOT, run: run("success"), rules: { read: false, reason: "500" }, rulesetNames: { read: false, reason: "403" } });
  assert.deepEqual(neither.gaps, ["rules-unreadable:500", "ruleset-names-unreadable:403"]);
  assert.deepEqual(neither.findings, []);
  // Workflows unreadable AND rules readable: gated, but whether it is armed is unknown — no arming finding on top of the workflows gap.
  const dark = classifyRepo({ repo: "k", files: null, filesError: "403", root: null, rootError: "403", rules: RULES_37 });
  assert.deepEqual(dark.findings, []);
  assert.equal(dark.dark_factory.arming_lane, null);
  assert.equal(dark.dark_factory.gate_ready, false);
  // The unit surface: rules not passed is "not under measurement", stated as null rather than defaulted to ungated.
  assert.equal(classifyRepo({ repo: "k", files: [], root: [] }).dark_factory, null);
  // rulesetNames not passed is the same surface: no attribution and NO gap, so the
  // hundreds of existing classifier assertions do not each acquire a phantom gap.
  const noArg = classifyRepo({ repo: "k", files: [wf(".github/workflows/standard.yml", KEYCARD)], root: RUST_ROOT, run: run("success"), rules: RULES_37 });
  assert.deepEqual(noArg.gaps, []);
  assert.equal(noArg.dark_factory.ruleset_names, null);
});

test("summarize + renderSummary: the dark-factory totals count what was measured, and the row prints even at zero", () => {
  const rows = [
    classifyRepo({ repo: "ready", files: [wf(".github/workflows/standard.yml", KEYCARD), wf(".github/workflows/auto-merge.yml", AUTO_MERGE)], root: RUST_ROOT, run: run("success"), rules: RULES_37 }),
    classifyRepo({ repo: "gated", files: [wf(".github/workflows/standard.yml", KEYCARD)], root: RUST_ROOT, run: run("success"), rules: RULES_37 }),
    classifyRepo({ repo: "unmeasured", files: [wf(".github/workflows/standard.yml", KEYCARD)], root: RUST_ROOT, run: run("success") }),
    // Only the org baseline's claim is required: counted in the row, not as gated (#391).
    classifyRepo({ repo: "claim-only", files: [], root: [], rules: { read: true, contexts: ["pr-claim / pr-claim"], rulesets: [21805316] } }),
  ];
  const t = summarize(rows);
  assert.equal(t.gated, 2, "the claim-only repo is not gated");
  assert.equal(t.arming_lane, 1);
  assert.equal(t.gate_ready, 1);
  assert.equal(t.merge_group, 3, "every present caller here carries merge_group; the caller-less repo is not counted");
  const snap = buildSnapshot({ now: "2026-09-08T12:00:00Z", rows, denominator: { public_repos: 4, enumerated: 4, verified: true, archived: 0, rows: 4 }, fleet: { unavailable: "x" }, standard: { head_sha: null, selftest: { state: "none" } }, strict: false });
  assert.match(renderSummary(snap), /\| gated \/ arming lane \/ dark-factory ready \| 2 \/ 1 \/ 1 \|/);
  assert.match(renderSummary(snap), /\| callers triggering on merge_group \| 3 \|/);
});

test("assertDenominator: exact equality, and a non-integer is a refusal too", () => {
  assert.deepEqual(assertDenominator({ enumerated: 94, publicRepos: 94 }), { ok: true });
  assert.equal(assertDenominator({ enumerated: 93, publicRepos: 94 }).ok, false);
  assert.equal(assertDenominator({ enumerated: 95, publicRepos: 94 }).ok, false, "over-counting is as wrong as under");
  assert.equal(assertDenominator({ enumerated: 94, publicRepos: undefined }).ok, false);
});

test("summarize + orderRows: worst repo first, every state counted once", () => {
  const rows = [
    classifyRepo({ repo: "clean", files: [wf(".github/workflows/standard.yml", GUEST_ROOM)], root: ["bun.lock"], run: run("success") }),
    classifyRepo({ repo: "bare", files: [wf(".github/workflows/ci.yml", REPO_HEALTH_CI)], root: ["deno.json"], run: null }),
    classifyRepo({ repo: "dark", files: null, filesError: "403", root: null, rootError: "403" }),
  ];
  const ordered = orderRows(rows);
  assert.equal(ordered[0].repo, "bounded-systems/bare");
  const t = summarize(ordered);
  assert.deepEqual(t.caller, { present: 1, absent: 1, unreadable: 1 });
  assert.equal(t.with_findings, 1);
  assert.equal(t.findings, 1);
  assert.equal(t.gaps, 2);
  assert.deepEqual(t.standard_run, { green: 1, red: 0, other: 0, none: 0, unreadable: 0 });
});

test("buildSnapshot + renderSummary: the feed names itself, states its visibility rule, and the summary carries the denominator", () => {
  const rows = [classifyRepo({ repo: "clean", files: [wf(".github/workflows/standard.yml", GUEST_ROOM)], root: ["bun.lock"], run: run("success") })];
  const snap = buildSnapshot({
    now: "2026-09-04T15:00:00Z",
    rows,
    denominator: { public_repos: 1, enumerated: 1, verified: true, archived: 0, rows: 1 },
    fleet: { source: "x", unavailable: "HTTP 503" },
    standard: { repo: "bounded-systems/.github", head_sha: "d126d721fa50275e12af0bdeaf1a2ff3016eedfd", selftest: { state: "green", conclusion: "success", url: "u" } },
    strict: false,
  });
  assert.equal(snap.feed, "repo-standard-conformance");
  assert.match(snap.visibility, /public repos only/);
  assert.equal(Date.parse(snap.generated_at) > 0, true);
  const md = renderSummary(snap);
  assert.match(md, /Denominator: 1 public repos/);
  assert.match(md, /Fleet feed: unavailable \(HTTP 503\)/);
  assert.match(md, /selftest success/);
});

test("fleetSlice: the repo's red rows and whether the feed lists it unobserved", () => {
  const body = { unobserved: ["bounded-systems/night-audit"], red: [{ repo: "bounded-systems/prx", workflow: "pages", conclusion: "failure", since: "s", run_url: "r" }, { repo: "bounded-systems/x", workflow: "y" }] };
  assert.deepEqual(fleetSlice(body, "bounded-systems/prx"), { unobserved: false, red: [{ workflow: "pages", conclusion: "failure", since: "s", run_url: "r" }] });
  assert.deepEqual(fleetSlice(body, "bounded-systems/night-audit"), { unobserved: true, red: [] });
  assert.equal(fleetSlice(null, "bounded-systems/prx"), null);
});

// ── the sweep, against a fake GitHub ─────────────────────────────────────────

function fakeGitHub({ publicRepos, repos, workflowsByRepo, rootByRepo, runsByRepo, rulesByRepo = {}, rulesetsByRepo = {}, fleet = null, selftest = "success" }) {
  const json = (status, body) => ({ status, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) });
  const text = (status, body) => ({ status, headers: new Headers(), json: async () => { throw new Error("not json"); }, text: async () => body });
  return async (url) => {
    const u = new URL(url);
    const p = u.pathname;
    if (u.host === "hooks.bounded.tools") return fleet ? json(200, fleet) : json(503, { error: "down" });
    if (u.host === "raw.githubusercontent.com") {
      const [, , repo, , ...rest] = p.split("/");
      const path = rest.join("/");
      const t = workflowsByRepo[repo]?.[path];
      return t == null ? text(404, "404") : text(200, t);
    }
    if (p === `/orgs/${ORG}`) return json(200, { public_repos: publicRepos });
    if (p === `/orgs/${ORG}/repos`) return json(200, repos.map((name) => ({ name, archived: false, default_branch: "main" })));
    const m = /^\/repos\/bounded-systems\/([^/]+)\/(.*)$/.exec(p);
    if (!m) return json(404, {});
    const [, repo, rest] = m;
    if (rest.startsWith("actions/workflows/repo-standard-selftest.yml/runs")) return json(200, { workflow_runs: [{ conclusion: selftest, html_url: "u", head_sha: "h", updated_at: "t" }] });
    if (rest.startsWith("contents/.github/workflows")) {
      const w = workflowsByRepo[repo];
      if (w === "forbidden") return json(403, { message: "Resource not accessible by integration" });
      if (!w) return json(404, {});
      return json(200, Object.keys(w).map((path) => ({ type: "file", name: path.split("/").pop(), path })));
    }
    if (rest.startsWith("contents/")) return rootByRepo[repo] ? json(200, rootByRepo[repo].map((name) => ({ name, type: "file" }))) : json(403, {});
    if (rest.startsWith("properties/values")) return json(403, {});
    if (rest === "rulesets") {
      const rs = rulesetsByRepo[repo];
      if (rs === "forbidden") return json(403, {});
      return json(200, (rs ?? []).map(([id, name]) => ({ id, name, enforcement: "active", source_type: "Organization" })));
    }
    if (rest.startsWith("rules/branches/")) {
      const rr = rulesByRepo[repo];
      if (rr === "forbidden") return json(403, {});
      return json(200, (rr ?? []).map((context, i) => ({ type: "required_status_checks", ruleset_id: 100 + i, parameters: { required_status_checks: [{ context }] } })));
    }
    if (rest.startsWith("actions/workflows/")) {
      const r = runsByRepo[repo];
      if (r === "forbidden") return json(403, {});
      return json(200, { workflow_runs: r ? [{ conclusion: r, html_url: "u", head_sha: "h", updated_at: "t", event: "push" }] : [] });
    }
    return json(404, {});
  };
}

test("sweep: a short enumeration refuses with DENOMINATOR and produces no snapshot", async () => {
  const fetchImpl = fakeGitHub({ publicRepos: 3, repos: ["a", "b"], workflowsByRepo: {}, rootByRepo: {}, runsByRepo: {} });
  await assert.rejects(sweep({ fetchImpl, token: "t", log: () => {} }), /DENOMINATOR: enumerated 2 public repos but .* reports 3/);
});

test("sweep: no token is a refusal, not an empty org", async () => {
  await assert.rejects(sweep({ fetchImpl: fakeGitHub({ publicRepos: 0, repos: [], workflowsByRepo: {}, rootByRepo: {}, runsByRepo: {} }), token: "", log: () => {} }), /GH_TOKEN is empty/);
});

test("sweep: a credential that reads nothing is named as the thing measured", async () => {
  const fetchImpl = fakeGitHub({ publicRepos: 2, repos: ["a", "b"], workflowsByRepo: { a: "forbidden", b: "forbidden" }, rootByRepo: {}, runsByRepo: {} });
  await assert.rejects(sweep({ fetchImpl, token: "t", log: () => {} }), /every one of 2 repos was unreadable/);
});

test("sweep: the happy path — rows, denominator, standard block, fleet join, and a 403 on runs as a gap", async () => {
  const fetchImpl = fakeGitHub({
    publicRepos: 3,
    repos: ["keycard", "repo-health", "night-audit"],
    workflowsByRepo: {
      keycard: { ".github/workflows/standard.yml": KEYCARD, ".github/workflows/deps.yml": DEPS, ".github/workflows/auto-merge.yml": AUTO_MERGE },
      "repo-health": { ".github/workflows/ci.yml": REPO_HEALTH_CI },
      // night-audit: an empty repo — no workflows dir at all
    },
    rootByRepo: { keycard: ["Cargo.toml", "lakefile.lean"], "repo-health": ["deno.json"], "night-audit": [] },
    runsByRepo: { keycard: "forbidden" },
    // keycard is gated on the two contexts the dark factory needs; the other two have no rules at all.
    rulesByRepo: { keycard: ["standard / test", "pr-claim / pr-claim"] },
    // keycard's applying rulesets: one publishable name, one the allowlist withholds.
    // repo-health's listing 403s, so the row shows a gap rather than "nothing applies";
    // night-audit has a listing and it is empty.
    rulesetsByRepo: { keycard: [[100, "ci-green-dot-github"], [101, "not-a-public-name"]], "repo-health": "forbidden" },
    fleet: { generated_at: "2026-09-04T14:13:32Z", repos_known: 97, repos_observed: 92, coverage_complete: false, unobserved: ["bounded-systems/night-audit"], red: [{ repo: "bounded-systems/repo-health", workflow: "ci", conclusion: "failure", since: "s", run_url: "r" }] },
  });
  const snap = await sweep({ fetchImpl, token: "t", now: "2026-09-04T15:00:00Z", headSha: "d126d721fa50275e12af0bdeaf1a2ff3016eedfd", log: () => {} });
  assert.equal(snap.denominator.enumerated, 3);
  assert.equal(snap.denominator.verified, true);
  assert.equal(snap.standard.selftest.state, "green");
  assert.equal(snap.fleet.repos_known, 97);
  const by = Object.fromEntries(snap.repos.map((r) => [r.repo.split("/")[1], r]));
  assert.deepEqual(by.keycard.findings, []);
  assert.deepEqual(by.keycard.gaps, ["standard-run-unreadable"], "a 403 on another repo's runs is a measurement gap the first real run will settle");
  assert.equal(by.keycard.caller.pin_is_head, true);
  assert.deepEqual(by["repo-health"].findings, ["caller-absent"]);
  assert.deepEqual(by["repo-health"].fleet.red.map((r) => r.workflow), ["ci"]);
  assert.deepEqual(by["night-audit"].findings, ["caller-absent"]);
  assert.equal(by["night-audit"].fleet.unobserved, true);
  assert.equal(by["night-audit"].test_lane, "n/a");
  assert.equal(snap.repos[0].findings.length >= snap.repos[snap.repos.length - 1].findings.length, true);
  assert.equal(snap.totals.rows, 3);
  // The dark-factory read rode along: keycard is gated, armed and ready; the two without a caller are neither gated nor findings for it.
  assert.equal(by.keycard.dark_factory.gate_ready, true);
  assert.deepEqual(by.keycard.dark_factory.required_checks, ["pr-claim / pr-claim", "standard / test"]);
  assert.deepEqual(by.keycard.dark_factory.ruleset_names, { 100: "ci-green-dot-github", 101: null }, "the redaction is applied on the way into the snapshot, not on the way out");
  assert.deepEqual(by["repo-health"].dark_factory, { required_checks: [], rulesets: [], ruleset_names: null, arming_lane: null, gate_ready: false });
  assert.ok(by["repo-health"].gaps.includes("ruleset-names-unreadable:403"), "a listing this lane could not read is a gap, not an empty attribution");
  assert.deepEqual(by["night-audit"].dark_factory.ruleset_names, {}, "a listing that read and returned nothing is {} — measured, and empty");
  assert.deepEqual(by["night-audit"].findings, ["caller-absent"], "attribution adds no finding anywhere");
  assert.deepEqual(snap.totals.gated, 1);
  assert.deepEqual(snap.totals.gate_ready, 1);
  assert.equal(snap.totals.merge_group, 1, "keycard's caller carries the key; the two without a caller do not count");
});

test("sweep: an unavailable fleet feed is recorded, not fatal, and rows carry no join", async () => {
  const fetchImpl = fakeGitHub({ publicRepos: 1, repos: ["keycard"], workflowsByRepo: { keycard: { ".github/workflows/standard.yml": KEYCARD } }, rootByRepo: { keycard: ["Cargo.toml"] }, runsByRepo: { keycard: "success" } });
  const snap = await sweep({ fetchImpl, token: "t", log: () => {} });
  assert.equal(snap.fleet.unavailable, "HTTP 503");
  assert.equal(snap.repos[0].fleet, null);
  assert.equal(snap.repos[0].standard_run.state, "green");
});
