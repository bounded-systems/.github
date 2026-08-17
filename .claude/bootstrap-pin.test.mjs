// Drift gate for the bootstrap pin and its digests.
//
// ── Why this exists ──────────────────────────────────────────────────────────
// boot.sh (fetched by the one-line setup-script field — README.md carries the
// field's canonical text) fetches files from a pinned commit and executes
// them, refusing anything whose SHA-256 does not match a recorded digest. Both
// the pin and the digests were hand-maintained, and BOTH went wrong within one
// afternoon (2026-07-31):
//
//   1. #71 recorded the pin it branched from, which predated register-mcp.mjs —
//      so the moment it merged, the fallback fetched a 404 for the file that PR
//      existed to install.
//   2. #72 changed session-start-dispatch.mjs without re-pinning, so the
//      fallback began installing a version older than main.
//
// Neither was caught by anything. The failure is invisible to whoever has
// `.github` attached, because the attached checkout always wins — the fallback is
// the path nobody exercises, and the symptom is "works for me, fails for a
// session without .github". That is the same argument infra#122 makes about a
// vendored script with no drift gate, one layer down.
//
// ── Why the checks live in gen-bootstrap-pin.mjs ─────────────────────────────
// This file used to reimplement the parse and the hashing. A gate that decides
// "correct" separately from the tool that PRODUCES correct is one refactor away
// from disagreeing with it — which is the same class of bug as #71 and #72, just
// relocated. The generator owns both, and this file asserts on it.
//
// ── Why FRESHNESS is not asserted on a pull request ──────────────────────────
// `SUM_*` is content-addressed; `PIN` is a commit. They must agree with each
// other, and PIN cannot name the merge commit before it exists — so on a PR that
// touches a fetched file the pair is inconsistent no matter what the author
// does. Recording the new digests early only moves the red from FRESHNESS to
// INTEGRITY. Asserting it there produced an expected-red on every such PR, which
// is how a gate teaches people to ignore it.
//
// It is still checked and still reported (see the diagnostic below); it is
// asserted on push, where main is the thing making the claim and org-defaults.yml
// opens the bump PR automatically. INTEGRITY stays hard everywhere, because a
// wrong digest is a live bug on any branch.
//
// Checked against GIT OBJECTS, not the network: hermetic, and it attests to the
// commit rather than to whatever an endpoint happened to return — which is the
// stronger claim, and the one the digests are supposed to encode.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { inspect, parseBootstrap } from "./gen-bootstrap-pin.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BOOT_SH = readFileSync(join(HERE, "boot.sh"), "utf8");
const README = readFileSync(join(HERE, "README.md"), "utf8");
const ATTEST = readFileSync(join(HERE, "..", ".github", "workflows", "attest-boot.yml"), "utf8");

const { pin, digests, fetches } = parseBootstrap(BOOT_SH);

/** True when this run is judging a merged state rather than a proposed one. */
const JUDGING_MAIN = process.env.GITHUB_EVENT_NAME !== "pull_request";

// ── The script says what it does ─────────────────────────────────────────────

test("boot.sh carries a pin and at least one verified fetch", () => {
  assert.ok(pin, "no PIN=<40 hex> found — the setup script lost its pin");
  assert.ok(fetches.length > 0, "no fetch_verified calls found — nothing is being pinned");
});

test("every fetched file is digest-checked, and every digest is used", () => {
  // An unverified fetch is the whole hole this gate exists to keep shut: a file
  // fetched without a digest is executed on the endpoint's word alone.
  for (const { file, sumVar } of fetches) {
    assert.ok(digests[sumVar], `${file} is fetched against ${sumVar}, which is not defined`);
  }
  const used = new Set(fetches.map((f) => f.sumVar));
  for (const name of Object.keys(digests)) {
    // An orphan digest is not dangerous, but it is a strong sign a fetch was
    // removed and its digest left behind — or that one was added and not wired up.
    assert.ok(used.has(name), `${name} is declared but no fetch_verified uses it`);
  }
});

test("the setup script fetches nothing without a digest", () => {
  // Catches a bare `curl … -o` added alongside the verified path.
  const rawCurls = [...BOOT_SH.matchAll(/^\s*curl[^\n]*-o\s+(\S+)/gm)].map((m) => m[1]);
  for (const target of rawCurls) {
    assert.ok(
      target.includes(".unverified"),
      `boot.sh curls to ${target} directly — fetched files must land on an ` +
        `.unverified path and be moved only after the digest check`,
    );
  }
});

test("the documented regenerate and confirm loops cover every fetched file", () => {
  // Both snippets enumerate the fetch set by hand, one line away from the
  // `fetch_verified` calls that define it. A file missing from a loop is a file
  // whose digest a maintainer following the docs would never recompute — exactly
  // how #72 shipped a stale digest. Cheap to state, so it is stated. Loops live
  // in boot.sh's own comments, in README prose, and in attest-boot.yml's run
  // summary; all three are held to it.
  //
  // attest-boot.yml joined this list the hard way. #205 derived that workflow's
  // path filter and subject list from the fetch set, and MISSED a third
  // enumeration — the summary loop — which kept reporting four files after five
  // were attested. A gate that covers two of three hand-written copies is the
  // same trap one level up, so the loop scan now reads that file too. Leading
  // whitespace is allowed because the workflow's loop is indented, and entries
  // are compared by basename because it lists `.claude/`-prefixed paths while
  // `fetches` carries bare filenames.
  for (const source of [BOOT_SH, README, ATTEST]) {
    for (const [, body] of source.matchAll(/^\s*(?:#\s*)?for f in ([^;]+); do$/gm)) {
      const listed = new Set(body.trim().split(/\s+/).map((p) => p.replace(/^\.claude\//, "")));
      for (const { file } of fetches) {
        assert.ok(listed.has(file), `a documented loop over "${body.trim()}" omits ${file}`);
      }
    }
  }
});

test("attest-boot signs boot.sh and every file fetch_verified installs", () => {
  // attest-boot.yml enumerates the fetch set TWICE — once as a push path filter,
  // once as attestation subjects — and its comment used to say "if the fetch set
  // grows, add the path here". That is an instruction to a human, and it was not
  // followed: setup-toolpath.sh joined the fetch set in #195 and was missing from
  // both lists until #534 found it. The consequence was not cosmetic. The one
  // fetched artifact that carries an executable digest pin (TOOLPATH_SHA256) was
  // the one with no provenance attestation, and editing it did not even trigger
  // the workflow — so the gap was self-concealing in exactly the way the
  // fetched-file failures in this file's header were.
  //
  // Both lists are now derived from the same source of truth this file already
  // parses, so the next file added to fetch_verified fails here instead of
  // silently going unsigned.
  const WORKFLOW = ATTEST;
  const expected = [".claude/boot.sh", ...fetches.map((f) => `.claude/${f.file}`)];

  const subjectBlock = WORKFLOW.match(/subject-path:\s*\|\n((?:\s+\S+\n)+)/)?.[1];
  assert.ok(subjectBlock, "attest-boot.yml has no subject-path block — nothing is being attested");
  const subjects = subjectBlock.trim().split(/\s+/);
  for (const want of expected) {
    assert.ok(subjects.includes(want), `attest-boot.yml does not attest ${want} — it would ship unsigned`);
  }

  const pathsBlock = WORKFLOW.match(/paths:\s*\n((?:\s+-\s+\S+\n)+)/)?.[1];
  assert.ok(pathsBlock, "attest-boot.yml has no push path filter");
  const paths = [...pathsBlock.matchAll(/-\s+(\S+)/g)].map((m) => m[1]);
  for (const want of expected) {
    assert.ok(paths.includes(want), `attest-boot.yml does not run when ${want} changes — a new version would never be attested`);
  }
});

// ── The one-line field: the only text an operator still hand-types ───────────

test("README's canonical field is channel-based and names no digest", () => {
  // Since #192 the field is WRITE-ONCE: it reads channel/front-desk.json
  // (written only by the OIDC-pinned boot-manifest lane on merge), extracts
  // the payload digest with sed, fetches /<sha>.sh and sha256-checks it
  // against the manifest's value. The field therefore carries NO 64-hex
  // literal — one reappearing means someone pasted the pre-#192 form back,
  // reintroducing the re-paste-per-bump scheme this exists to end. The
  // init-phase constraints stand unchanged: no $ORG_BOOT_SHA256 (UNSET at
  // init, #506), one line, and the sed shape must match what the Worker
  // stores (compact JSON, "boot":"<hex64>" — pinned on the Worker side by
  // infra cloudflare/boot's own suite).
  const line = README.split("\n").find((l) => l.includes("curl") && l.includes("boot.bounded.tools"));
  assert.ok(line, "README's canonical field text no longer fetches from boot.bounded.tools");
  assert.ok(line.includes("channel/front-desk.json"), "the field does not read the channel manifest — the #192 indirection is gone");
  assert.ok(!/[0-9a-f]{64}/.test(line), "the field carries a 64-hex literal — the pre-#192 re-paste-per-bump form is back");
  assert.ok(line.includes("sed -n"), "the field lost its sed extraction — nothing turns the manifest into a digest");
  assert.ok(line.includes("sha256sum -c"), "the field no longer digest-checks the payload against the manifest value");
  assert.ok(!line.includes("$ORG_BOOT_SHA256"), "the field line reads $ORG_BOOT_SHA256 — UNSET during init (#506)");
  assert.ok(!line.includes("$ORG_BOOT_URL"), "the field line reintroduced $ORG_BOOT_URL");
  assert.ok(!line.trim().includes("\n"), "the canonical field text is no longer one line");
});

test("the field verifies before it executes, and logs its run", () => {
  // Ordering is the security property: curl → sha256sum -c → bash, joined by
  // `&&` so a 404 or wrong bytes stop before execution.
  const line = README.split("\n").find((l) => l.includes("curl") && l.includes("boot.bounded.tools")) ?? "";
  const curl = line.indexOf("curl");
  const check = line.indexOf("sha256sum -c");
  const run = line.indexOf("bash");
  assert.ok(curl >= 0 && check > curl && run > check, "the field's curl → sha256sum -c → bash ordering broke");
  const between = line.slice(check, run);
  assert.ok(between.includes("&&"), "the digest check and the execution are not &&-joined — a failed check would not stop the run");
  // Silent fail-open is how a broken bootstrap hid from 2026-08-10 to
  // 2026-08-16 (#506): the field must leave an on-disk record of every run.
  assert.ok(line.includes("/tmp/boot-init.log"), "the field no longer logs to /tmp/boot-init.log — silent fail-open is the #506 failure mode");
});

test("the live pin lives only in boot.sh — README carries no live assignment", () => {
  // The old canonical block held PIN= and SUM_* lines in README. If a live pin
  // reappears there, two documents claim the anchor and the generator only
  // maintains one of them.
  assert.equal(parseBootstrap(README).pin, null, "README grew a live PIN= assignment — the anchor belongs to boot.sh");
});

// ── INTEGRITY: the digests describe the pin ──────────────────────────────────

test("every recorded digest matches the file at the pin", () => {
  // Hard on every branch: a digest that does not describe the pin means the
  // bootstrap refuses a legitimate file TODAY, and the author can fix it here.
  const { integrity } = inspect(BOOT_SH);
  assert.deepEqual(
    integrity,
    [],
    `recorded digests do not match ${integrity.join(", ")} at ${pin?.slice(0, 12)}.\n` +
      `  The bootstrap would REFUSE these files and start without them.\n` +
      `  Fix: node .claude/gen-bootstrap-pin.mjs ${pin}`,
  );
});

// ── FRESHNESS: the pin describes what is here ────────────────────────────────

test("the pin is not stale — it serves what this branch contains", (t) => {
  const { stale } = inspect(BOOT_SH);

  if (stale.length && !JUDGING_MAIN) {
    // Reported, not asserted. See the header: no PR touching a fetched file can
    // satisfy this, so failing here would be an expected-red on every such PR.
    t.diagnostic(
      `pin ${pin.slice(0, 12)} predates ${stale.join(", ")} — expected on this PR. ` +
        `org-defaults.yml will open the bump PR when this merges.`,
    );
    return;
  }

  assert.deepEqual(
    stale,
    [],
    `the recorded PIN (${pin?.slice(0, 12)}) predates changes to: ${stale.join(", ")}.\n` +
      `  A session WITHOUT .github attached would install the older copy, and nothing\n` +
      `  else would report it — the attached checkout always wins locally.\n` +
      `  On main this should self-heal: org-defaults.yml regenerates the pin on push\n` +
      `  and opens the bump PR. Seeing it here means that job did not run or did not\n` +
      `  land. Fix by hand with: node .claude/gen-bootstrap-pin.mjs <this commit>`,
  );
});
