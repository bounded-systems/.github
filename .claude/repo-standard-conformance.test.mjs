// The session reader for the repo-standard conformance snapshot, driven over
// fixtures through its RSC_FILE seam — no fetch, no network.
//
// What is pinned is mostly how it REFUSES: a stale snapshot is a lead and an
// exit 1, not the fleet's state; a snapshot that does not name itself as this
// feed, or cannot say when it was made, is not rendered at all. The healthy
// path is pinned too, because a reader that prints nothing on good data and
// nothing on bad data is the shape every other reader here exists to avoid.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "repo-standard-conformance.sh");
const dir = mkdtempSync(join(tmpdir(), "rsc-"));

const stamp = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace(/\.\d{3}Z$/, "Z");

function snapshot(overrides = {}) {
  return {
    generated_at: stamp(60_000),
    feed: "repo-standard-conformance",
    org: "bounded-systems",
    strict: false,
    standard: { repo: "bounded-systems/.github", head_sha: "d126d721fa50275e12af0bdeaf1a2ff3016eedfd", selftest: { state: "green", url: "https://example/run" } },
    denominator: { public_repos: 3, enumerated: 3, verified: true, archived: 1, rows: 2 },
    fleet: { generated_at: "2026-09-04T14:13:32Z", repos_known: 97, repos_observed: 92, coverage_complete: false },
    totals: {
      rows: 2,
      caller: { present: 1, absent: 1, unreadable: 0 },
      pinned: 1,
      test_lane: { present: 1, absent: 1, "n/a": 0, unmeasured: 0 },
      standard_run: { green: 1, red: 0, other: 0, none: 0, unreadable: 0 },
      with_findings: 1,
      findings: 1,
      gaps: 1,
    },
    repos: [
      { repo: "bounded-systems/bare", findings: ["caller-absent"], gaps: [], extra: [{ path: ".github/workflows/ci.yml" }] },
      { repo: "bounded-systems/clean", findings: [], gaps: ["standard-run-unreadable"], extra: [] },
    ],
    ...overrides,
  };
}

function run(file, args = [], env = {}) {
  return spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, RSC_FILE: file, ...env },
  });
}

function fixture(name, data) {
  const p = join(dir, name);
  writeFileSync(p, typeof data === "string" ? data : JSON.stringify(data));
  return p;
}

test("a fresh snapshot prints the totals and the repos with findings, exit 0", () => {
  const r = run(fixture("fresh.json", snapshot()));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /public repos only/);
  assert.match(r.stdout, /denominator: 3 public repos, verified against \/orgs: true/);
  assert.match(r.stdout, /standard: {4}d126d721fa50 on main; selftest green/);
  assert.match(r.stdout, /fleet feed: {2}92\/97 observed/);
  assert.match(r.stdout, /callers: {5}1 present · 1 absent · 0 unreadable/);
  assert.match(r.stdout, /bounded-systems\/bare {2}caller-absent {3}extra: ci\.yml/);
  assert.doesNotMatch(r.stdout, /bounded-systems\/clean/, "a repo with no findings is not listed as one");
  assert.doesNotMatch(r.stderr, /STALE/);
});

test("--gaps lists what the lane could not measure, and nothing else", () => {
  const r = run(fixture("gaps.json", snapshot()), ["--gaps"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Measurement gaps/);
  assert.match(r.stdout, /bounded-systems\/clean {2}standard-run-unreadable/);
  assert.doesNotMatch(r.stdout, /bounded-systems\/bare/);
});

test("a stale snapshot is a lead, not the fleet: banner on stderr, still printed, exit 1", () => {
  const r = run(fixture("stale.json", snapshot({ generated_at: stamp(3 * 86_400_000) })));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /STALE/);
  assert.match(r.stderr, /At least one run did\n│ not happen/, "the banner's box-drawing prefix is part of the text a reader sees");
  assert.match(r.stdout, /callers:/, "the stale data is still shown — as a lead");
});

test("an unavailable fleet feed is said, not blanked", () => {
  const r = run(fixture("nofleet.json", snapshot({ fleet: { source: "x", unavailable: "HTTP 503" } })));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /fleet feed: {2}unavailable \(HTTP 503\)/);
});

test("a snapshot that is not this feed is refused", () => {
  const r = run(fixture("wrong.json", snapshot({ feed: "front-desk-public" })));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /malformed, misnamed/);
  assert.equal(r.stdout, "");
});

test("a snapshot with no parseable generated_at is refused", () => {
  const r = run(fixture("undated.json", snapshot({ generated_at: "yesterday" })));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no parseable generated_at/);
});

test("a missing file is an error, never an empty fleet", () => {
  const r = run(join(dir, "does-not-exist.json"));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no such file/);
});

test("an unknown argument is refused", () => {
  const r = run(fixture("args.json", snapshot()), ["--bogus"]);
  assert.equal(r.status, 2);
});
