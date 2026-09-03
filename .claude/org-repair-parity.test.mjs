// org-repair parity — this repo's .claude/org-repair.sh against the canonical
// digest (.github#356).
//
// This copy is the one OTHER repos get compared against when a session has
// only `.github` attached, and it drifted three ways from canonical without any
// check noticing (#356): it exited 0 where canonical exits 1 when neither the
// legacy variable nor the manifest resolves — the same fail-OPEN shape as the
// 2026-08-17 incident the canonical header records — resolved the digest
// BEFORE the `cmp` (a network call on every run, and a false "installing
// nothing" instead of `bootstrap in effect` with egress down), and lost the
// incident writeup. Every behavioural assertion passed; only byte parity
// caught it.
//
// The generator lives in .github-private, which this repo's CI cannot read, so
// this pins the DIGEST — infra's shape (infra#595), not .github-private's
// byte-compare (#869). Update CANON_SHA in the same PR that changes the
// canonical script; the census in .github-private (harness-drift.yml, #881)
// reds on the same day if this copy and the generator disagree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLED = join(ROOT, ".claude", "org-repair.sh");
const SETTINGS = join(ROOT, ".claude", "settings.json");

// sha256 of `adopt-claude-harness.sh --print-repair` in bounded-systems/.github-private
// as of .github-private#869.
const CANON_SHA = "2e5136302edc613340751628e5840f3dea4ebbe827e708835b86e875414a47fa";

test("the script CLAUDE.md step 1 names exists", () => {
  assert.ok(existsSync(INSTALLED), ".claude/org-repair.sh is missing, but CLAUDE.md and settings.json both name it");
});

test("org-repair.sh is byte-identical to canonical (digest pin)", () => {
  const got = createHash("sha256").update(readFileSync(INSTALLED)).digest("hex");
  assert.equal(
    got,
    CANON_SHA,
    `DRIFTED from canonical: got ${got}, expected ${CANON_SHA}. Either this copy drifted, or the canonical ` +
      `script changed and CANON_SHA was not updated with it. Regenerate with: ` +
      `bash .github-private/docs/handoffs/scripts/adopt-claude-harness.sh --print-repair > .claude/org-repair.sh`,
  );
});

test("the copy is the post-#192 form: refuses (exit 1) rather than exiting 0 with nothing resolvable", () => {
  const src = readFileSync(INSTALLED, "utf8");
  // The drifted copy's fail-open branch, verbatim. A byte pin catches this too,
  // but a named assertion says WHAT drifted when the pin fails.
  assert.doesNotMatch(src, /nothing to verify against; installing nothing"\n\s*exit 0/, "fail-open early exit is back (#356 §1)");
  assert.match(src, /REFUSED/, "canonical refuses rather than running unverified bytes");
  assert.match(src, /channel\/front-desk\.json/, "resolves the digest from the channel manifest");
  // Checkout-first ordering: `cmp` must appear before the manifest fetch (#356 §2).
  assert.ok(src.indexOf("cmp -s") < src.indexOf("channel/front-desk.json"), "digest is resolved BEFORE the bootstrap check — a network call on every run (#356 §2)");
});

test("settings.json still pre-approves the invocation (.github#491)", () => {
  const s = JSON.parse(readFileSync(SETTINGS, "utf8"));
  const allow = s?.permissions?.allow ?? [];
  assert.ok(allow.includes("Bash(bash .claude/org-repair.sh)"), "Bash(bash .claude/org-repair.sh) is not in permissions.allow");
});
