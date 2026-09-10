// Every SessionStart hook this repo DECLARES is either delivered to a cold
// session or declared undelivered, with a reason (.github-private#958, #960).
//
// ── The edge nothing covered ─────────────────────────────────────────────────
// bootstrap-steps.test.mjs relates boot.sh to {MANIFEST, IRREDUCIBLE}, in both
// directions. test-coverage.test.mjs relates test files to the workflow that
// runs them, in both directions. Nothing related THIS repo's
// `.claude/settings.json` -- the list of hooks a session is supposed to run --
// to whether a session without this repo attached gets them at all.
//
// It could not have been noticed from either existing gate. `sessionStartCommands`
// reads settings.json out of an ATTACHED checkout, so on the cold path the whole
// declaration is invisible: `findRepos` returns [], the dispatcher logs "nothing
// to do", and every count in that line is correct. Two of the three declared
// hooks have been undelivered cold for as long as anyone has looked --
// inject-org-context.sh (#958), which is the one the entire org-context chain
// depends on, and status-probe.sh (#960), which exists to stop a session burning
// retries into an outage it cannot see. Add a fourth hook tomorrow and it
// inherits the same gap silently. That is what this file stops.
//
// ── Why a fetch line is NOT delivery, which is the trap ──────────────────────
// The obvious fix -- add the hook to boot.sh's fetch set -- does nothing on its
// own, and bootstrap-steps.test.mjs says why in its own words: "the fetch cache
// is staging, not installing". Staged files are exempt from parseSteps, so such
// a line is invisible to that gate too: an inert change that keeps the suite
// green. Delivery needs something to RUN the bytes, and on the cold path only
// the dispatcher runs at all.
//
// So COLD_DELIVERED is checked against boot.sh's fetch set rather than trusted:
// claiming to deliver bytes that nothing fetches is the same defect wearing the
// opposite mask.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MANIFEST, sessionStartCommands } from "./session-start-dispatch.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SETTINGS = JSON.parse(readFileSync(join(HERE, "settings.json"), "utf8"));
const BOOT_SH = readFileSync(join(HERE, "boot.sh"), "utf8");

/**
 * Hooks the dispatcher runs on behalf of a repo that is not attached.
 *
 * Empty today, which is the finding rather than an oversight: nothing in the
 * cold path runs a SessionStart hook of this repo's. #958's patch adds
 * `deliverOrgContext` and the first entry here.
 */
export const COLD_DELIVERED = [];

/**
 * Declared NOT delivered cold, each with the issue that will remove it.
 *
 * This is a ratchet, not an exemption list. An entry is a defect someone has
 * written down, and the assertions below make it impossible to (a) add a hook
 * without landing in one of the three classes, or (b) leave an entry here once
 * the hook IS delivered. Emptying it is the goal; IRREDUCIBLE's posture, with
 * the opposite intent -- there a "cannot", here a "not yet".
 */
export const UNDELIVERED_COLD = [
  {
    artifact: "inject-org-context.sh",
    reason:
      "Not in boot.sh's fetch set and not run by the dispatcher, so a session that cannot attach " +
      "a dot-named repo gets no org context and no warning -- measured cold as `ran 1 hook(s) " +
      "across 1 repo(s); 0 injected context`, a line that reads as health. .github-private#958.",
  },
  {
    artifact: "status-probe.sh",
    reason:
      "Same gap, different cost: the hook that tells a session a provider incident was already " +
      "open at check-in never reaches the sessions with the least context to spare. It already " +
      "emits a correct hookSpecificOutput envelope, so only delivery is missing. .github-private#960.",
  },
];

/** The artifact each declared SessionStart command runs, e.g. "bash .claude/foo.sh" -> "foo.sh". */
export function declaredHookArtifacts(settings = SETTINGS) {
  return sessionStartCommands(settings).map((cmd) => {
    const m = cmd.match(/(?:^|[/\s])\.claude\/([A-Za-z0-9._-]+)\s*$/);
    assert.ok(m, `SessionStart command does not name a .claude/ script: ${cmd}`);
    return m[1];
  });
}

/** Artifacts boot.sh fetches. Derived from the file, never restated. */
export function fetchedArtifacts(bootSh = BOOT_SH) {
  return [...bootSh.matchAll(/^\s*fetch_verified\s+(\S+)/gm)].map((m) => m[1]);
}

const declared = declaredHookArtifacts();
const covered = new Set(MANIFEST.map((e) => e.artifact));
const delivered = new Set(COLD_DELIVERED);
const undelivered = new Map(UNDELIVERED_COLD.map((e) => [e.artifact, e]));

test("the declaration still parses into hooks", () => {
  // Guard the guard: a settings.json that stopped declaring SessionStart hooks,
  // or a command shape this regex no longer recognises, would make every
  // assertion below vacuously green.
  assert.ok(declared.length > 0, "no SessionStart hooks found in settings.json — the parse or the file moved");
});

test("every declared SessionStart hook exists on disk", () => {
  for (const artifact of declared) {
    assert.ok(existsSync(join(HERE, artifact)), `settings.json declares .claude/${artifact}, which is not there`);
  }
});

test("every declared hook is manifest-covered, cold-delivered, or declared undelivered", () => {
  for (const artifact of declared) {
    assert.ok(
      covered.has(artifact) || delivered.has(artifact) || undelivered.has(artifact),
      `"${artifact}" is declared in .claude/settings.json but nothing says whether a session ` +
        `WITHOUT this repo attached gets it.\n` +
        `  Add it to COLD_DELIVERED (and make the dispatcher run it), or to UNDELIVERED_COLD ` +
        `with the issue that will fix it.\n` +
        `  A hook nobody classified is the #958/#960 defect arriving again.`,
    );
  }
});

test("a hook is in exactly one class, never two", () => {
  for (const artifact of declared) {
    const n = [covered.has(artifact), delivered.has(artifact), undelivered.has(artifact)].filter(Boolean).length;
    assert.equal(n, 1, `"${artifact}" is in ${n} classes — manifest-covered, cold-delivered and undelivered are exclusive`);
  }
});

test("nothing is classified that settings.json does not declare", () => {
  // The reverse direction, and the one that goes stale quietly: an entry for a
  // hook the declaration dropped is a defect recorded against nothing, and it
  // keeps this file's numbers wrong. Same argument bootstrap-steps.test.mjs
  // makes about a manifest entry the field no longer installs.
  const isDeclared = new Set(declared);
  for (const artifact of [...delivered, ...undelivered.keys()]) {
    assert.ok(
      isDeclared.has(artifact),
      `"${artifact}" is classified here but .claude/settings.json no longer declares it — remove the entry`,
    );
  }
});

test("every undelivered entry carries a real reason naming an issue", () => {
  for (const { artifact, reason } of UNDELIVERED_COLD) {
    assert.ok(reason?.trim().length > 40, `the UNDELIVERED_COLD entry for "${artifact}" has no real reason`);
    assert.match(reason, /#\d+/, `the UNDELIVERED_COLD entry for "${artifact}" names no issue — an entry with no issue never leaves`);
  }
});

test("a cold-delivered hook is one boot.sh actually fetches", () => {
  // The half that makes COLD_DELIVERED more than a claim. The dispatcher can only
  // run bytes that reached the cache, so an entry with no fetch line is a hook
  // that is delivered on paper and absent in the session.
  const fetched = new Set(fetchedArtifacts());
  for (const artifact of COLD_DELIVERED) {
    assert.ok(
      fetched.has(artifact),
      `COLD_DELIVERED names "${artifact}" but boot.sh has no fetch_verified line for it — ` +
        `the dispatcher would look for a file that never arrives`,
    );
  }
});

test("a fixed hook cannot stay on the undelivered list", () => {
  // The ratchet. Without this, #958 could land its delivery and leave the entry,
  // and this file would go on reporting a defect that no longer exists — which is
  // how a gate stops being read.
  for (const artifact of undelivered.keys()) {
    assert.ok(
      !delivered.has(artifact) && !covered.has(artifact),
      `"${artifact}" is delivered now — remove its UNDELIVERED_COLD entry`,
    );
  }
});

test("a newly declared hook fails this gate until it is classified", () => {
  // Proves the gate bites, rather than asserting over a set that happens to be
  // fully classified today. Same shape as bootstrap-steps.test.mjs's own
  // "a step added to the field with no fallback fails this gate".
  const withNew = structuredClone(SETTINGS);
  withNew.hooks.SessionStart[0].hooks.push({ type: "command", command: "bash .claude/some-new-hook.sh" });
  const found = declaredHookArtifacts(withNew);
  assert.ok(found.includes("some-new-hook.sh"), "the parse did not notice a new SessionStart hook");
  assert.ok(
    !covered.has("some-new-hook.sh") && !delivered.has("some-new-hook.sh") && !undelivered.has("some-new-hook.sh"),
    "a hook nobody classified was treated as covered",
  );
});
