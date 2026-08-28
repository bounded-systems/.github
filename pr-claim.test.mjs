// Behavioural tests for `_pr-claim.yml` — the check that a PR names an issue
// carrying a live claim.
//
// ── Why these run the shell, not a model of it ───────────────────────────────
// This repo's own `workflows.test.mjs` exists because a gate went green while
// never executing, and its lesson is that a mechanism asserted from its SHAPE is
// not measured. A structural test over this workflow ("it contains the string
// `exit 1`") would repeat exactly that mistake on the file whose entire job is
// to stop rules from being believed rather than checked.
//
// So: the `run:` block is extracted verbatim from the YAML and executed by bash,
// with `gh` stubbed by a script on PATH that serves fixtures. What is under test
// is the bytes that will run on the runner. If someone edits the workflow and
// breaks the logic, these go red — which a structural test could not do.
//
// ── What is still NOT covered ────────────────────────────────────────────────
// The GraphQL query text itself. The stub returns whatever fixture it is handed,
// so a query that asks GitHub for the wrong field passes here and fails live.
// That is a real gap, and the honest mitigation is that the query is exercised
// the first time the check runs on a real PR — including this one's.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WORKFLOW = ".github/workflows/_pr-claim.yml";

// ── Extract the `run:` block ────────────────────────────────────────────────
// A block scalar ends at the first non-blank line indented less than its body.
// That is the same YAML rule `workflows.test.mjs` was written about, so it is
// applied here rather than assumed.
function extractRunScript(src) {
  const lines = src.split("\n");
  const start = lines.findIndex((l) => /^\s*run:\s*\|\s*$/.test(l));
  assert.notEqual(start, -1, "no `run: |` block in the workflow");
  const indent = lines[start + 1].match(/^ */)[0].length;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") { out.push(""); continue; }
    if (line.match(/^ */)[0].length < indent) break;
    out.push(line.slice(indent));
  }
  return out.join("\n");
}

const SCRIPT = extractRunScript(readFileSync(WORKFLOW, "utf8"));

// ── Fixture builders ────────────────────────────────────────────────────────
const prPayload = (body, closes = []) => ({
  data: {
    repository: {
      pullRequest: {
        body,
        closingIssuesReferences: {
          nodes: closes.map(([nameWithOwner, number]) => ({
            number,
            repository: { nameWithOwner },
          })),
        },
      },
    },
  },
});

const issue = ({ state = "open", labels = [], assignees = [], isPr = false } = {}) => ({
  state,
  labels: labels.map((name) => ({ name })),
  assignees: assignees.map((login) => ({ login })),
  ...(isPr ? { pull_request: { url: "x" } } : {}),
});

const DAY = 86400_000;
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString();

const claimComment = (claimant, { marker = "claim-ticket", when = daysAgo(0) } = {}) => ({
  created_at: when,
  body: `🎫 **Claimed** by ${claimant} — dispatched by \`bdelanghe\` — [run](https://x)\n\n<!-- ${marker} -->\nRelease by removing the \`claimed\` label (and unassigning) if work stops without a merged PR.`,
});

const releaseComment = (claimant, { when = daysAgo(0) } = {}) => ({
  created_at: when,
  body: `🔓 **Released** by ${claimant} — [run](https://x)\n\n<!-- front-desk-claim -->\nRecorded by the shared claim door.`,
});

// ── Runner ──────────────────────────────────────────────────────────────────
function run({ pr, issues = {}, comments = {}, env = {}, repo = "bounded-systems/.github-private" }) {
  const dir = mkdtempSync(join(tmpdir(), "pr-claim-"));
  const fixtures = join(dir, "fixtures");
  mkdirSync(fixtures);
  writeFileSync(join(fixtures, "pr.json"), JSON.stringify(pr));
  for (const [k, v] of Object.entries(issues)) {
    writeFileSync(join(fixtures, `issue-${k}.json`), JSON.stringify(v));
  }
  for (const [k, v] of Object.entries(comments)) {
    writeFileSync(join(fixtures, `comments-${k}.json`), JSON.stringify(v));
  }

  // The stub. Keyed on the request shape rather than on argument position, so
  // reordering flags in the workflow does not silently stop matching.
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const stub = join(bin, "gh");
  writeFileSync(stub, `#!/usr/bin/env bash
set -u
args="$*"
if [[ "$args" == *graphql* ]]; then
  cat "${fixtures}/pr.json"; exit 0
fi
if [[ "$args" =~ issues/([0-9]+)/comments ]]; then
  n="\${BASH_REMATCH[1]}"
  key="$(printf '%s' "$args" | sed -E 's#.*(repos/[^ ]*)/issues/[0-9]+/comments.*#\\1#')"
  owner="$(printf '%s' "$key" | sed -E 's#repos/##')"
  f="${fixtures}/comments-\${owner//\\//_}_\${n}.json"
  [ -f "$f" ] || f="${fixtures}/comments-\${n}.json"
  if [ -f "$f" ]; then cat "$f"; else echo '[]'; fi
  exit 0
fi
if [[ "$args" =~ issues/([0-9]+)$ ]] || [[ "$args" =~ issues/([0-9]+)[[:space:]] ]]; then
  n="\${BASH_REMATCH[1]}"
  f="${fixtures}/issue-\${n}.json"
  if [ -f "$f" ]; then cat "$f"; exit 0; fi
  echo "not found" >&2; exit 1
fi
echo "unstubbed gh call: $args" >&2
exit 1
`);
  chmodSync(stub, 0o755);

  const summary = join(dir, "summary.md");
  writeFileSync(summary, "");
  const script = join(dir, "check.sh");
  writeFileSync(script, SCRIPT);

  let status = 0;
  let output = "";
  try {
    output = execFileSync("bash", [script], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: dir,
        GH_TOKEN: "stub",
        GITHUB_REPOSITORY: repo,
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_STEP_SUMMARY: summary,
        PR_INPUT: "",
        PR_EVENT: "1",
        LABEL: "claimed",
        MAX_AGE: "0",
        NEED_DOOR: "false",
        ...env,
      },
    });
  } catch (e) {
    status = e.status ?? 1;
    output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  return { status, output, summary: readFileSync(summary, "utf8") };
}

// ── The rule itself ─────────────────────────────────────────────────────────

test("green: a `Closes #N` reference to an open, labelled, claimed issue", () => {
  const r = run({
    pr: prPayload("Closes #722.", [["bounded-systems/.github-private", 722]]),
    issues: { 722: issue({ labels: ["claimed"], assignees: ["bdelanghe"] }) },
    comments: { 722: [claimComment("claude/some-session")] },
  });
  assert.equal(r.status, 0, r.output);
  assert.match(r.summary, /✅ live/);
  assert.match(r.summary, /claude\/some-session/);
});

test("red: a PR that names no issue at all", () => {
  const r = run({ pr: prPayload("A tidy little refactor. No issue, no ticket.") });
  assert.equal(r.status, 1);
  assert.match(r.summary, /names no issue/);
  // The error must TELL the author both accepted forms. A gate that only says
  // "no" trains people to route around it.
  assert.match(r.summary, /Closes #123/);
  assert.match(r.summary, /Claim-issue: owner\/repo#123/);
});

test("red: the named issue exists but carries no claim — the #265 case", () => {
  // bounded-systems/.github PR #265 `Closes #264`, and #264 had no assignee and
  // no `claimed` label on 2026-08-28. This is that PR, as a fixture.
  const r = run({
    pr: prPayload("Closes #264.", [["bounded-systems/.github", 264]]),
    issues: { 264: issue({ labels: [], assignees: [] }) },
    comments: { 264: [] },
  });
  assert.equal(r.status, 1);
  assert.match(r.summary, /no .claimed. label, no assignee/);
  assert.match(r.summary, /No named issue carries a live claim/);
});

test("red: the claim was released", () => {
  const r = run({
    pr: prPayload("Closes #722.", [["bounded-systems/.github-private", 722]]),
    // A release removes the label, but a stuck label is a real state (#652) —
    // the release marker must be decisive on its own.
    issues: { 722: issue({ labels: ["claimed"] }) },
    comments: {
      722: [claimComment("claude/a", { when: daysAgo(2) }), releaseComment("claude/a")],
    },
  });
  assert.equal(r.status, 1);
  assert.match(r.summary, /released/);
});

test("green again after a re-claim: only the LATEST marker decides", () => {
  const r = run({
    pr: prPayload("Closes #722.", [["bounded-systems/.github-private", 722]]),
    issues: { 722: issue({ labels: ["claimed"] }) },
    comments: {
      722: [
        claimComment("claude/a", { when: daysAgo(5) }),
        releaseComment("claude/a", { when: daysAgo(4) }),
        claimComment("claude/b", { when: daysAgo(1) }),
      ],
    },
  });
  assert.equal(r.status, 0, r.output);
  assert.match(r.summary, /✅ live/);
  assert.match(r.summary, /claude\/b/);
});

test("red: the named issue is closed", () => {
  const r = run({
    pr: prPayload("Closes #722.", [["bounded-systems/.github-private", 722]]),
    issues: { 722: issue({ state: "closed", labels: ["claimed"] }) },
    comments: { 722: [claimComment("claude/a")] },
  });
  assert.equal(r.status, 1);
  assert.match(r.summary, /issue closed/);
});

test("red: `Closes` pointing at a pull request, not an issue", () => {
  // The issues API serves PRs too, and a PR can carry the `claimed` label. A
  // rule about issues must not be satisfiable by naming another PR.
  const r = run({
    pr: prPayload("Closes #710.", [["bounded-systems/.github-private", 710]]),
    issues: { 710: issue({ labels: ["claimed"], isPr: true }) },
    comments: { 710: [claimComment("claude/a")] },
  });
  assert.equal(r.status, 1);
  assert.match(r.summary, /is a PR/);
});

test("red, and for the RIGHT reason: an unreadable issue is not a pass", () => {
  const r = run({
    pr: prPayload("Claim-issue: bounded-systems/some-private-repo#5"),
    issues: {},
  });
  assert.equal(r.status, 1);
  assert.match(r.summary, /unreadable/);
  assert.match(r.output, /may not reach that repository/);
});

// ── The trailer form ────────────────────────────────────────────────────────

test("green: `Claim-issue:` trailer, same repo, no closing keyword", () => {
  // The machine-lane case: a recurring PR runs UNDER a standing claim it must
  // not close.
  const r = run({
    pr: prPayload("Routine registry refresh.\n\nClaim-issue: #700\n"),
    issues: { 700: issue({ labels: ["claimed"] }) },
    comments: { 700: [claimComment("machine/registry-refresh")] },
  });
  assert.equal(r.status, 0, r.output);
  assert.match(r.summary, /machine\/registry-refresh/);
  assert.match(r.summary, /trailer/);
});

test("green: `Claim-issue:` trailer naming another repository", () => {
  const r = run({
    pr: prPayload("Claim-issue: bounded-systems/.github-private#722"),
    issues: { 722: issue({ labels: ["claimed"] }) },
    comments: { 722: [claimComment("claude/x")] },
    repo: "bounded-systems/prx",
  });
  assert.equal(r.status, 0, r.output);
});

test("the trailer must be a whole line — a mention in prose is not a link", () => {
  const r = run({
    pr: prPayload("We considered a Claim-issue: #700 trailer here but did not add one."),
    issues: { 700: issue({ labels: ["claimed"] }) },
    comments: { 700: [claimComment("machine/x")] },
  });
  assert.equal(r.status, 1);
  assert.match(r.summary, /names no issue/);
  // And SILENTLY: prose that happens to contain the key is not a malformed
  // trailer, so warning about it would train authors to ignore the warning.
  // This assertion is the one that distinguishes a line-anchored match from a
  // substring match — without it, dropping the anchor passes every test here.
  assert.doesNotMatch(r.output, /unparseable/);
});

test("a genuinely malformed trailer IS warned about", () => {
  const r = run({ pr: prPayload("Claim-issue: not-a-reference") });
  assert.equal(r.status, 1);
  assert.match(r.output, /unparseable Claim-issue/);
  assert.match(r.output, /expected/);
});

test("`Claim:` — the claimant-string line PRs already use — is NOT a linkage", () => {
  // PR #265's body carries `Claim: claude/claims-audit-faceid-6uqqg0`. If this
  // check read that key it would be reading a line whose existing meaning is a
  // claimant, not an issue, and would resolve it against nothing.
  const r = run({ pr: prPayload("Draft per org convention. Claim: `claude/claims-audit-faceid-6uqqg0`.") });
  assert.equal(r.status, 1);
  assert.match(r.summary, /names no issue/);
});

// ── Disjunction, doors, and the optional ratchets ───────────────────────────

test("one live claim among several named issues is enough", () => {
  const r = run({
    pr: prPayload("Closes #1. Closes #2.", [
      ["bounded-systems/.github-private", 1],
      ["bounded-systems/.github-private", 2],
    ]),
    issues: { 1: issue({ labels: [] }), 2: issue({ labels: ["claimed"] }) },
    comments: { 1: [], 2: [claimComment("claude/b")] },
  });
  assert.equal(r.status, 0, r.output);
});

test("both mechanized doors are recognised, despite their different markers", () => {
  // #226 unified the doors' behaviour and left `<!-- claim-ticket -->` and
  // `<!-- front-desk-claim -->` different. A reader that knew only one would
  // call half the org's claims absent.
  for (const marker of ["claim-ticket", "front-desk-claim"]) {
    const r = run({
      pr: prPayload("Closes #9.", [["bounded-systems/.github-private", 9]]),
      issues: { 9: issue({ labels: ["claimed"] }) },
      comments: { 9: [claimComment("claude/a", { marker })] },
    });
    assert.equal(r.status, 0, `${marker}: ${r.output}`);
    assert.match(r.summary, /mechanized/);
  }
});

test("a hand-claim (assignee only, no marker) passes by default, and says so", () => {
  const r = run({
    pr: prPayload("Closes #9.", [["bounded-systems/.github-private", 9]]),
    issues: { 9: issue({ labels: [], assignees: ["bdelanghe"] }) },
    comments: { 9: [] },
  });
  assert.equal(r.status, 0, r.output);
  // Passing is a decision; hiding it would not be. The door must be legible.
  assert.match(r.summary, /hand/);
});

test("`require_mechanized_door` rejects the hand-claim it otherwise allows", () => {
  const r = run({
    pr: prPayload("Closes #9.", [["bounded-systems/.github-private", 9]]),
    issues: { 9: issue({ labels: ["claimed"], assignees: ["bdelanghe"] }) },
    comments: { 9: [] },
    env: { NEED_DOOR: "true" },
  });
  assert.equal(r.status, 1);
  assert.match(r.summary, /mechanized door is required/);
});

test("`max_claim_age_days` is off by default and binding when set", () => {
  const stale = {
    pr: prPayload("Closes #9.", [["bounded-systems/.github-private", 9]]),
    issues: { 9: issue({ labels: ["claimed"] }) },
    comments: { 9: [claimComment("claude/a", { when: daysAgo(40) })] },
  };
  assert.equal(run(stale).status, 0, "default 0 must not expire anything");
  const limited = run({ ...stale, env: { MAX_AGE: "30" } });
  assert.equal(limited.status, 1);
  assert.match(limited.summary, /40d old \(limit 30d\)/);
});

test("with an age limit set, an undateable hand-claim is red rather than assumed fresh", () => {
  const r = run({
    pr: prPayload("Closes #9.", [["bounded-systems/.github-private", 9]]),
    issues: { 9: issue({ labels: ["claimed"] }) },
    comments: { 9: [] },
    env: { MAX_AGE: "30" },
  });
  assert.equal(r.status, 1);
  assert.match(r.summary, /cannot date a hand-claim/);
});

// ── Fail closed, and for a stated reason ────────────────────────────────────

test("a GraphQL error is a failure, NOT `no issue named`", () => {
  // HTTP 200 with an `errors` key is how a permission problem arrives. Reading
  // it as an empty PR would send the author to add a `Closes` line that is
  // already there.
  const r = run({ pr: { errors: [{ message: "Resource not accessible by integration" }] } });
  assert.equal(r.status, 1);
  assert.match(r.output, /could not read PR/);
  assert.doesNotMatch(r.summary, /names no issue/);
});

test("a malformed label input fails naming itself", () => {
  const r = run({ pr: prPayload(""), env: { LABEL: "not a label" } });
  assert.equal(r.status, 1);
  assert.match(r.output, /label must match/);
});

test("a non-numeric PR number fails before any API call", () => {
  const r = run({ pr: prPayload(""), env: { PR_INPUT: "abc", PR_EVENT: "" } });
  assert.equal(r.status, 1);
  assert.match(r.output, /no PR to check/);
});

test("the explicit `pr` input wins over the triggering event", () => {
  const r = run({
    pr: prPayload("Closes #9.", [["bounded-systems/.github-private", 9]]),
    issues: { 9: issue({ labels: ["claimed"] }) },
    comments: { 9: [claimComment("claude/a")] },
    env: { PR_INPUT: "77", PR_EVENT: "1" },
  });
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /PR #77 names a live claim/);
});
