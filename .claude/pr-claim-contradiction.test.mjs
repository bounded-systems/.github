// The body/commit contradiction guard in _pr-claim.yml (#298), run as the real
// step against a stubbed `gh`.
//
// WHY IT EXISTS. `closingIssuesReferences` is GitHub's resolution of the PR
// BODY's keywords. It cannot see COMMIT MESSAGES — and a squash merge folds the
// branch's commits into the merge commit, where closing keywords are honoured
// too. So a PR could pass pr-claim carrying a `Claim-issue:` trailer and still
// close the issue it promised to leave open.
//
// That is not hypothetical: #296 carried `Claim-issue: …#295` in its body and
// `Closes #295` in commit 741e8aa. closingIssuesReferences was empty, the check
// went green, and the merge closed #295 — which made .github-private#780
// unmergeable.
//
// THE STEP IS EXTRACTED FROM THE WORKFLOW, NOT COPIED. Editing the check changes
// what these cases execute.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import yaml from "node:util"; // not used; parsing is done with a tiny reader below

const here = dirname(fileURLToPath(import.meta.url));
const WF = join(here, "..", ".github", "workflows", "_pr-claim.yml");
const text = readFileSync(WF, "utf8");

// Pull the `run: |` block containing the guard, dedenting by its own indent.
function extractRun() {
  const lines = text.split("\n");
  const i = lines.findIndex((l) => /^\s*run: \|/.test(l));
  assert.notEqual(i, -1, "no run block found");
  const indent = lines[i + 1].match(/^\s*/)[0].length;
  const out = [];
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j];
    if (l.trim() !== "" && l.match(/^\s*/)[0].length < indent) break;
    out.push(l.slice(indent));
  }
  const body = out.join("\n");
  assert.ok(body.includes("conflicts"), "guard not in the extracted step");
  return body;
}
const STEP = extractRun();

function run({ body, commits, closes = [] }) {
  const dir = mkdtempSync(join(tmpdir(), "prclaim-"));
  const graphql = {
    data: { repository: { pullRequest: {
      body,
      closingIssuesReferences: { nodes: closes.map((n) => ({ number: n, repository: { nameWithOwner: "bounded-systems/.github" } })) },
      commits: { pageInfo: { hasNextPage: false },
                 nodes: commits.map((m, k) => ({ commit: { oid: `deadbeef${k}`.padEnd(40, "0"), message: m } })) },
    } } },
  };
  writeFileSync(join(dir, "graphql.json"), JSON.stringify(graphql));
  // `gh` stub: graphql returns the fixture; everything else returns empty JSON
  // so the step proceeds past this guard without network.
  writeFileSync(join(dir, "gh"), `#!/usr/bin/env bash
if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then cat "${dir}/graphql.json"; exit 0; fi
echo '[]'; exit 0
`);
  chmodSync(join(dir, "gh"), 0o755);
  writeFileSync(join(dir, "step.sh"), STEP);
  let stdout = "", status = 0;
  try {
    stdout = execFileSync("bash", [join(dir, "step.sh")], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`,
             GITHUB_REPOSITORY: "bounded-systems/.github", PR_EVENT: "296", PR_INPUT: "",
             GH_TOKEN: "stub", LABEL: "claimed", MAX_AGE: "0", NEED_DOOR: "false",
             GITHUB_STEP_SUMMARY: join(dir, "summary.md"), GITHUB_OUTPUT: join(dir, "out.txt") },
    });
  } catch (e) {
    status = e.status; stdout = (e.stdout || "") + (e.stderr || "");
  }
  return { stdout, status, fired: /body and commits disagree/.test(stdout) };
}

test("REGRESSION #296: trailer says keep open, commit says Closes — same issue", () => {
  const r = run({ body: "Claim-issue: bounded-systems/.github#295", commits: ["fix a thing\n\nCloses #295"] });
  assert.equal(r.fired, true, "the guard must fire on the shape that closed #295");
  assert.equal(r.status, 1);
});

test("a plain `Closes` PR with no trailer stays green — the common case", () => {
  const r = run({ body: "Ordinary work.", commits: ["do the thing\n\nCloses #295"], closes: [295] });
  assert.equal(r.fired, false, "must not fire without a Claim-issue trailer");
});

test("trailer and Closes naming DIFFERENT issues is legitimate", () => {
  const r = run({ body: "Claim-issue: bounded-systems/.github#280", commits: ["work\n\nCloses #295"], closes: [295] });
  assert.equal(r.fired, false, "closing one issue under another's claim is allowed");
});

test("every closing keyword GitHub honours is caught", () => {
  for (const kw of ["Closes", "closed", "Fix", "fixes", "FIXED", "Resolve", "resolves", "Resolved"]) {
    const r = run({ body: "Claim-issue: bounded-systems/.github#295", commits: [`x\n\n${kw} #295`] });
    assert.equal(r.fired, true, `${kw} #295 must be caught`);
  }
});

test("a bare mention of the number is not a closing keyword", () => {
  const r = run({ body: "Claim-issue: bounded-systems/.github#295", commits: ["refs #295, see also 295 of 400"] });
  assert.equal(r.fired, false, "only closing keywords count");
});

test("a trailer with no commits at all does not fire", () => {
  const r = run({ body: "Claim-issue: bounded-systems/.github#295", commits: [] });
  assert.equal(r.fired, false);
});
