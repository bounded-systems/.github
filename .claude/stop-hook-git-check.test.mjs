// Unit tests for the Stop hook's git checks.
//
// This file had NO tests, unlike its sibling stop-hook-findings-check.sh, and it
// shipped three independent faults that all present as silence (.github-private
// #536, measured 2026-08-16 and reconfirmed here before this suite was written):
//
//   A  the signing guard read the EFFECTIVE commit.gpgsign, so writing the
//      repo-local `false` that disables signing also silenced the check for it.
//   B  `%G?` answers "can git VERIFY this", and nothing in the container can —
//      no gpg.ssh.allowedSignersFile — so a correctly SSH-signed commit reports
//      `N`, the same letter as unsigned.
//   C  `origin/HEAD` does not resolve in a --depth 1 clone; it reached git as an
//      exclude ref without the resolve test the other candidates got, so git
//      died, `2>/dev/null` ate it, and BOTH checks reported a clean tree.
//
// The order matters and is asserted below: C masks B, so fixing C alone turns
// silence into false positives — whose old remedy was `--amend`, which in a
// shallow clone produces a parentless root commit and closes the PR.
//
// Real repositories in temp dirs, not mocks: every fault above was a
// disagreement between what the script asked git and what git actually does, and
// a fake git would have agreed with the script both times.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "stop-hook-git-check.sh");

/**
 * Git environment for a fixture — HERMETIC, and that is not incidental.
 *
 * The first version of this suite inherited the ambient config and passed 12/12
 * locally while failing 3 in CI. This container has `commit.gpgsign=true` set
 * GLOBALLY by the harness; a bare runner does not, so the signature check the
 * suite exists to test was simply skipped there and the hook fell through to its
 * unpushed-commits message. The tests were agreeing with my machine rather than
 * asserting behaviour — the same shape as the injected-probe tests that let a
 * dead code path ship under 160 green cases.
 *
 * So the fixture supplies its own global config, mirroring the real shape:
 * signing on GLOBALLY, which is what makes a repo-local `false` the anomaly that
 * fault A is about. GIT_CONFIG_SYSTEM is nulled so a system-wide setting cannot
 * reach in either. The file lives OUTSIDE the work tree — inside it, it would
 * show up as an untracked file and trip the hook's own untracked check.
 */
const hermetic = (root) => ({
  ...process.env,
  GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
  GIT_CONFIG_SYSTEM: "/dev/null",
  HOME: root,
});

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: hermetic(dirname(cwd)) }).trim();

/**
 * Run the hook. Returns { code, stderr }.
 *
 * The hook reads a JSON envelope on stdin and signals by EXIT CODE — 0 quiet,
 * 2 something to say — so both are captured. `stop_hook_active:false` is the
 * live shape; `true` is the recursion guard.
 */
function runHook(cwd, { active = false } = {}) {
  try {
    execFileSync("bash", [HOOK], {
      cwd,
      env: hermetic(dirname(cwd)),
      input: JSON.stringify({ stop_hook_active: active }),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { code: 0, stderr: "" };
  } catch (e) {
    return { code: e.status ?? 1, stderr: e.stderr ?? "" };
  }
}

const SSH_ARMOUR = ["-----BEGIN SSH SIGNATURE-----", "U1NIU0lHAAAAAQAAADMAAAALc3NoLWVkMjU1MTk=", "-----END SSH SIGNATURE-----"];
const PGP_ARMOUR = ["-----BEGIN PGP SIGNATURE-----", "iQIzBAABCgAdFiEE", "-----END PGP SIGNATURE-----"];

/**
 * Write a commit object by hand, so a "signed" commit needs no signing key.
 *
 * The header block is what the hook reads, and `git hash-object -t commit` will
 * store whatever headers it is given — which is exactly the fixture needed here
 * and impossible to produce with `git commit` inside a container that has no
 * verifier. `sign` picks the flavour; `armourInMessage` puts the same bytes in
 * the MESSAGE instead, which is the case header-only parsing must reject.
 */
function commitRaw(cwd, { message = "c", parent = null, email = "noreply@anthropic.com", sign = null, armourInMessage = false } = {}) {
  const tree = git(cwd, "write-tree");
  const lines = [`tree ${tree}`];
  if (parent) lines.push(`parent ${parent}`);
  lines.push(`author Claude <${email}> 0 +0000`, `committer Claude <${email}> 0 +0000`);
  if (sign) {
    const armour = sign === "pgp" ? PGP_ARMOUR : SSH_ARMOUR;
    lines.push(`gpgsig ${armour[0]}`, ...armour.slice(1).map((l) => ` ${l}`));
  }
  const body = armourInMessage ? `${message}\n\n${SSH_ARMOUR.join("\n")}` : message;
  const raw = `${lines.join("\n")}\n\n${body}\n`;
  const sha = execFileSync("git", ["hash-object", "-t", "commit", "-w", "--stdin"], {
    cwd,
    env: hermetic(dirname(cwd)),
    input: raw,
    encoding: "utf8",
  }).trim();
  git(cwd, "update-ref", "HEAD", sha);
  return sha;
}

/**
 * A repo with a remote, a committed file, and signing configured GLOBALLY —
 * which is how the harness configures it, and why a repo-local override is the
 * interesting case rather than a normal one.
 */
function repo({ localGpgsign = null, withOriginHead = true, sign = "ssh", email = "noreply@anthropic.com" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "stophook-"));
  // Signing on GLOBALLY, as the harness configures it — so a repo-local `false`
  // is the anomaly fault A is about, rather than the only source of truth.
  writeFileSync(join(root, "gitconfig"), "[commit]\n\tgpgsign = true\n");
  const dir = join(root, "repo");
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "noreply@anthropic.com");
  git(dir, "config", "user.name", "Claude");
  git(dir, "remote", "add", "origin", "https://example.invalid/x.git");
  writeFileSync(join(dir, "f.txt"), "one\n");
  git(dir, "add", "f.txt");
  const base = commitRaw(dir, { message: "base", sign: "ssh" });
  // The remote-tracking ref the branch is compared against.
  git(dir, "update-ref", "refs/remotes/origin/main", base);
  // origin/HEAD is what a --depth 1 clone does NOT have. Default to present so
  // individual tests opt into the shallow shape rather than every test carrying it.
  if (withOriginHead) git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  if (localGpgsign !== null) git(dir, "config", "--local", "commit.gpgsign", localGpgsign);
  return { root, dir, base, add: (opts) => commitRaw(dir, { parent: git(dir, "rev-parse", "HEAD"), sign, email, ...opts }) };
}

const clean = (r) => rmSync(r.root, { recursive: true, force: true });

// ── The recursion guard and the bail-outs ────────────────────────────────────

test("an already-active stop hook exits immediately", () => {
  const r = repo();
  try {
    writeFileSync(join(r.dir, "dirty.txt"), "x\n");
    assert.equal(runHook(r.dir, { active: true }).code, 0);
  } finally {
    clean(r);
  }
});

test("uncommitted changes and untracked files are both reported", () => {
  const r = repo();
  try {
    writeFileSync(join(r.dir, "f.txt"), "changed\n");
    const dirty = runHook(r.dir);
    assert.equal(dirty.code, 2);
    assert.match(dirty.stderr, /uncommitted changes/);

    git(r.dir, "checkout", "--", "f.txt");
    writeFileSync(join(r.dir, "new.txt"), "x\n");
    const untracked = runHook(r.dir);
    assert.equal(untracked.code, 2);
    assert.match(untracked.stderr, /untracked files/);
  } finally {
    clean(r);
  }
});

// ── A: the guard that silenced itself ────────────────────────────────────────

test("A: a repo-local commit.gpgsign=false is a FINDING, not a reason to go quiet", () => {
  // The exact fault the check exists to catch used to disable the check, because
  // it read the effective value. Writing that override cost two PRs on
  // 2026-08-16: signing silently off, merge gate rejecting hours later.
  const r = repo({ localGpgsign: "false" });
  try {
    const got = runHook(r.dir);
    assert.equal(got.code, 2, "a local gpgsign=false was accepted silently");
    assert.match(got.stderr, /LOCAL commit\.gpgsign=false/);
    assert.match(got.stderr, /--local --unset commit\.gpgsign/, "the remedy must name the fix");
  } finally {
    clean(r);
  }
});

test("A: a repo-local commit.gpgsign=true is not a finding", () => {
  const r = repo({ localGpgsign: "true" });
  try {
    assert.equal(runHook(r.dir).code, 0);
  } finally {
    clean(r);
  }
});

// ── B: presence, not verifiability ───────────────────────────────────────────

test("B: an SSH-signed commit is NOT flagged, though %G? calls it N", () => {
  // The regression. No allowedSignersFile exists here — the same state every
  // container is in — so %G? reports N for this commit and the old code called
  // a correctly signed commit Unverified.
  const r = repo();
  try {
    r.add({ message: "signed", sign: "ssh" });
    const got = runHook(r.dir);
    assert.doesNotMatch(got.stderr, /Unverified/, "a signed commit was reported as Unverified");
  } finally {
    clean(r);
  }
});

test("B: a PGP-signed commit is NOT flagged either", () => {
  // GitHub signs its own squash-merges with PGP (verified on 1337986, 6675ce5,
  // 57b93c5). An SSH-only presence test would call every merge unsigned.
  const r = repo();
  try {
    r.add({ message: "pgp", sign: "pgp" });
    assert.doesNotMatch(runHook(r.dir).stderr, /Unverified/);
  } finally {
    clean(r);
  }
});

test("B: a genuinely unsigned commit IS flagged", () => {
  const r = repo();
  try {
    r.add({ message: "bare", sign: null });
    const got = runHook(r.dir);
    assert.equal(got.code, 2);
    assert.match(got.stderr, /Unverified/);
  } finally {
    clean(r);
  }
});

test("B: signature armour in the MESSAGE does not count as a signature", () => {
  // Header-only parsing, and not a hypothetical: the commits fixing this very
  // file quote SSH armour in their bodies.
  const r = repo();
  try {
    r.add({ message: "quotes armour", sign: null, armourInMessage: true });
    const got = runHook(r.dir);
    assert.equal(got.code, 2, "armour in the commit message was accepted as a signature");
    assert.match(got.stderr, /Unverified/);
  } finally {
    clean(r);
  }
});

test("B: a signed commit with a foreign committer email is still flagged", () => {
  const r = repo();
  try {
    r.add({ message: "wrong identity", sign: "ssh", email: "someone@example.com" });
    assert.equal(runHook(r.dir).code, 2);
  } finally {
    clean(r);
  }
});

// ── C: one unresolvable ref must not silence everything ──────────────────────

test("C: an unresolved origin/HEAD does not silence the checks", () => {
  // The shallow-clone shape: no origin/HEAD, and a branch with no remote
  // counterpart, so origin/HEAD reached the exclude list unfiltered. git died,
  // stderr was discarded, and the hook reported a clean tree.
  const r = repo({ withOriginHead: false });
  try {
    git(r.dir, "checkout", "-q", "-b", "feature");
    r.add({ message: "unsigned on a branch with no upstream", sign: null });
    const got = runHook(r.dir);
    assert.equal(got.code, 2, "the hook went silent instead of reporting an unsigned commit");
    assert.match(got.stderr, /Unverified|unpushed/);
  } finally {
    clean(r);
  }
});

test("C: unpushed commits are still counted when origin/HEAD is missing", () => {
  const r = repo({ withOriginHead: false });
  try {
    git(r.dir, "checkout", "-q", "-b", "feature");
    r.add({ message: "properly signed, just unpushed", sign: "ssh" });
    const got = runHook(r.dir);
    assert.equal(got.code, 2);
    assert.match(got.stderr, /unpushed/);
  } finally {
    clean(r);
  }
});

// ── The remedy, which is part of the defect ──────────────────────────────────

test("the remedy never routes to --amend, and names the shallow trap", () => {
  // Fixing C without this turns silence into false positives whose suggested fix
  // severs the parent in a --depth 1 clone: GitHub loses the merge base and
  // closes the PR. The advice is the bug's last mile, so it is asserted.
  const r = repo();
  try {
    r.add({ message: "bare", sign: null });
    const got = runHook(r.dir);
    assert.match(got.stderr, /reset --soft HEAD~1 && git commit -C ORIG_HEAD/);
    assert.doesNotMatch(got.stderr, /git commit --amend --no-edit/, "the remedy still routes to --amend");
    assert.match(got.stderr, /parentless root commit/, "the shallow trap must be named, not just avoided");
  } finally {
    clean(r);
  }
});
