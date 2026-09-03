// The drift detector must not claim drift it cannot distinguish from staleness
// (#359).
//
// ── Why this exists ──────────────────────────────────────────────────────────
// On 2026-09-03 this hook announced, at session start:
//
//     ⚠ org context DRIFT: …/.github-private/claude/context.md and
//       …/.github/claude/context.md differ. … bare sessions are getting the
//       other text — see .github-private#581.
//
// There was no drift. Both copies on their default branches hashed to
// 0b9aa1d4…; the .github checkout was one commit behind, behind by exactly the
// commit that had synced them. `cmp` compared a stale working tree against a
// current one.
//
// That is a HARMFUL false positive, not a noisy one: the message asserts an
// org-level fact and points at #581, whose remedy is to sync the files — so
// acting on it means copying the stale copy over the current one and CREATING
// the drift the message invented.
//
// ── Why this one is BEHAVIOURAL, unlike its neighbour ────────────────────────
// inject-org-context.test.mjs is deliberately a content gate: its property is a
// URL, and a textual failure deserves a textual check. This property is not
// textual. "Reports drift only when it can tell" is a claim about what the code
// DOES with a stale checkout, and the only way to know is to build one. Asserting
// the message wording alone would pass against code that still cannot tell.
//
// No network: the fixture is local git repos with local "remotes", so @{u}
// resolves without egress — which is also the constraint the hook itself runs
// under, since it lives on the bootstrap path.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("./inject-org-context.sh", import.meta.url));

// Extract the checkout-election block: from the root resolution through the end
// of the drift `if`. Running the whole hook would need network (step 0 fetches
// the public copy), and the property under test is entirely in this block.
function drecipe() {
  const lines = readFileSync(HOOK, "utf8").split("\n");
  const start = lines.findIndex((l) => l.startsWith('R="${CLAUDE_SESSION_ROOT:-}"'));
  assert.notEqual(start, -1, "anchor moved: no root-resolution line — fix this test, do not delete it");
  let end = -1;
  for (let i = start; i < lines.length; i++) {
    if (lines[i] === "fi") { end = i; break; }
  }
  assert.notEqual(end, -1, "anchor moved: no closing fi — fix this test");
  const block = lines.slice(start, end + 1).join("\n");
  // THE #112 GUARD. A slice that missed the comparison would run clean and
  // assert nothing, which is exactly how a green test comes to cover no code.
  assert.match(block, /cmp -s/, "the extracted block does not contain the comparison — the slice is wrong");
  assert.match(block, /drift=/, "the extracted block does not set drift — the slice is wrong");
  return block;
}

function git(cwd, ...args) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

// Two repos, each with a local bare "remote" so `@{u}` resolves offline.
function fixture(privText, pubText, { pubBehind = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "drift-"));
  for (const [name, text] of [[".github-private", privText], [".github", pubText]]) {
    const bare = join(root, `remote-${name}.git`);
    const wt = join(root, name);
    execFileSync("git", ["init", "-q", "--bare", bare]);
    execFileSync("git", ["init", "-q", wt]);
    git(wt, "config", "user.email", "t@t");
    git(wt, "config", "user.name", "t");
    mkdirSync(join(wt, "claude"), { recursive: true });
    writeFileSync(join(wt, "claude", "context.md"), text);
    git(wt, "add", "-A");
    git(wt, "commit", "-qm", "one");
    git(wt, "remote", "add", "origin", bare);
    git(wt, "push", "-q", "-u", "origin", "HEAD:refs/heads/main");
  }
  mkdirSync(join(root, ".github", ".claude"), { recursive: true });
  writeFileSync(join(root, ".github", ".claude", "boot.sh"), "");
  if (pubBehind) {
    // Advance the REMOTE without advancing the checkout: the exact shape that
    // produced the false alarm.
    const wt = join(root, ".github");
    writeFileSync(join(wt, "claude", "context.md"), "synced text\n");
    git(wt, "commit", "-qam", "two");
    git(wt, "push", "-q", "origin", "HEAD:main");
    git(wt, "reset", "-q", "--hard", "HEAD~1");
  }
  return root;
}

function runBlock(root) {
  // Via CLAUDE_SESSION_ROOT, not by pre-assigning R: the block's FIRST line is
  // `R="${CLAUDE_SESSION_ROOT:-}"`, so an assignment ahead of it is overwritten
  // and the fixture is silently bypassed. My first draft did exactly that and
  // the tests failed against correct code — the harness, not the hook.
  return execFileSync("bash", ["-c", `${drecipe()}\nprintf '%s' "$drift"`], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_SESSION_ROOT: root },
  });
}

test("identical copies produce no warning at all", () => {
  const root = fixture("same\n", "same\n");
  try {
    assert.equal(runBlock(root), "", "identical copies must not warn");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a BEHIND checkout is not announced as drift — the #359 false positive", () => {
  // The copies must actually differ on disk: private carries what main has,
  // the .github checkout is parked one commit back on the old text. That is
  // the measured shape — behind by exactly the commit that synced them.
  const root = fixture("synced text\n", "old text\n", { pubBehind: true });
  try {
    const out = runBlock(root);
    assert.notEqual(out, "", "a difference on disk should still be reported, just not as drift");
    // The load-bearing assertion: it must not assert drift as fact. The old
    // message opened "org context DRIFT:" and stated what bare sessions get.
    assert.doesNotMatch(out, /org context DRIFT/, "must not assert DRIFT — it cannot tell staleness from drift");
    assert.match(out, /MAY BE DRIFT, OR ONE CHECKOUT MAY SIMPLY BE BEHIND/i);
    assert.match(out, /context-parity\.sh/, "must cite the probe that can actually settle it");
    assert.match(out, /\.github\b/, "must name which checkout looks behind");
    assert.match(out, /hint, not a verification/i, "the remote-tracking read is itself local and must be qualified");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a real difference with both checkouts current says so is NOT evidence either", () => {
  const root = fixture("private text\n", "different public text\n");
  try {
    const out = runBlock(root);
    assert.notEqual(out, "");
    assert.doesNotMatch(out, /org context DRIFT/);
    // "Neither is behind" must not read as a clean bill: the remote-tracking
    // ref is a local read and goes stale without a fetch. Reporting it as proof
    // of drift would be the same defect wearing the opposite sign.
    assert.match(out, /NOT evidence/i, "must not treat 'not behind' as proof of drift");
    assert.match(out, /context-parity\.sh/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the elected copy is still the private one — this changes the message, not the election", () => {
  const block = drecipe();
  assert.match(block, /priv="\$R\/\.github-private\/claude\/context\.md"/);
  assert.match(block, /pub="\$R\/\.github\/claude\/context\.md"/);
});
