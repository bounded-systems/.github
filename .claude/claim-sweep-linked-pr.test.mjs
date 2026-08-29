// The "linked open PR" predicate in _claim-sweep.yml, tested against fixtures.
//
// WHY THIS FILE EXISTS. Rule 3 of the sweep — release a claim on an open issue
// that has gone quiet — was inert from the day it shipped. It asked
//
//     search/issues?q=repo:$R+is:pr+is:open+$n
//
// where `$n` is a BARE FREE-TEXT TERM, so it matched any open PR whose indexed
// text merely contained those digits. Run 33272158443 kept five issues as
// "(linked open PR)" in a repository with ZERO open pull requests, one of them
// 21 days stale (#295). Nothing caught it: the rule ran, printed a decision for
// every issue, and every line looked plausible.
//
// THE FILTER IS READ OUT OF THE WORKFLOW, NEVER COPIED HERE. A test carrying its
// own copy of the expression passes while production runs something else, which
// is the drift #368 is about. Editing the workflow therefore changes what these
// cases execute — that is the point, and it is why the fixtures rather than the
// filter carry the intent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const workflow = readFileSync(
  join(here, "..", ".github", "workflows", "_claim-sweep.yml"),
  "utf8",
);

// Pull the jq program out of the `--jq '…'` that follows the timeline call.
function extractFilter() {
  const call = workflow.indexOf('gh api "repos/$R/issues/$n/timeline');
  assert.notEqual(call, -1, "timeline call not found — did the predicate move?");
  const open = workflow.indexOf("--jq '", call);
  assert.notEqual(open, -1, "no --jq filter after the timeline call");
  const start = open + "--jq '".length;
  const end = workflow.indexOf("'", start);
  assert.notEqual(end, -1, "unterminated jq filter");
  return workflow.slice(start, end);
}

const FILTER = extractFilter();

// FULL-LINE COMMENTS ARE STRIPPED BEFORE ANY GREP OVER THE WORKFLOW, and this is
// not fussiness — the first run of this file failed on its own documentation. The
// comment explaining the #295 defect necessarily QUOTES `search/issues`, so a
// naive grep for that string reads the explanation as the offence. `4830c48` hit
// the mirror image of this (a guard its own comment SATISFIED) and wrote the rule
// down for two workflows; it applies to any grep over a commented file. Stripping
// also keeps the cheapest route to green from being "delete the explanation".
const CODE = workflow
  .split("\n")
  .filter((l) => !/^\s*#/.test(l))
  .join("\n");

function run(timeline) {
  const out = execFileSync("jq", [FILTER], {
    input: JSON.stringify(timeline),
    encoding: "utf8",
  });
  return Number(out.trim());
}

const xref = (opts) => ({
  event: "cross-referenced",
  source: { issue: { state: opts.state, ...(opts.isPr ? { pull_request: {} } : {}) } },
});

test("the predicate still asks the timeline, not search/issues", () => {
  assert.ok(
    !CODE.includes("search/issues"),
    "search/issues is back — that endpoint is org-scoped and matches free text (#295)",
  );
  assert.match(FILTER, /cross-referenced/);
});

test("an open PR referencing the issue counts as linked", () => {
  assert.equal(run([xref({ isPr: true, state: "open" })]), 1);
});

test("a CLOSED PR reference does not count — the work is not live", () => {
  assert.equal(run([xref({ isPr: true, state: "closed" })]), 0);
});

test("an ISSUE cross-reference does not count, however many", () => {
  // The specimen from #295: heavily cross-referenced, no open PR. #314 carried
  // 14 cross-references and zero open-PR ones, which is what the old free-text
  // query was really matching on.
  const t = Array.from({ length: 14 }, () => xref({ isPr: false, state: "open" }));
  assert.equal(run(t), 0);
});

test("unrelated timeline events are ignored", () => {
  const t = [
    { event: "labeled" },
    { event: "assigned" },
    { event: "commented" },
    { event: "referenced" }, // a commit reference, not a cross-reference
  ];
  assert.equal(run(t), 0);
});

test("an empty timeline is zero, not an error", () => {
  assert.equal(run([]), 0);
});

test("mixed timeline counts only the open PR references", () => {
  const t = [
    { event: "labeled" },
    xref({ isPr: false, state: "open" }),
    xref({ isPr: true, state: "closed" }),
    xref({ isPr: true, state: "open" }),
    xref({ isPr: true, state: "open" }),
  ];
  assert.equal(run(t), 2);
});

test("REGRESSION #295: a stale issue with no open-PR reference releases", () => {
  // Reconstructed from bounded-systems/.github-private#373 — open, 21 days
  // untouched, 7 cross-references, none of them an open PR. The old predicate
  // kept it as "(linked open PR)"; a zero here is what lets rule 3 fire.
  const t = [
    { event: "labeled" },
    { event: "assigned" },
    ...Array.from({ length: 7 }, () => xref({ isPr: false, state: "open" })),
    { event: "renamed" },
  ];
  assert.equal(run(t), 0, "a claim with no live PR must not be retained");
});
