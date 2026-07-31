// Drift gate for the bootstrap pin and its digests.
//
// ── Why this exists ──────────────────────────────────────────────────────────
// The setup script in README.md fetches files from a pinned commit and executes
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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { inspect, parseBootstrap } from "./gen-bootstrap-pin.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const README = readFileSync(join(HERE, "README.md"), "utf8");

const { pin, digests, fetches } = parseBootstrap(README);

/** True when this run is judging a merged state rather than a proposed one. */
const JUDGING_MAIN = process.env.GITHUB_EVENT_NAME !== "pull_request";

// ── The script says what it does ─────────────────────────────────────────────

test("README carries a pin and at least one verified fetch", () => {
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
  const script = README.match(/```sh\n#!\/usr\/bin\/env bash\n[\s\S]*?\n```/)?.[0] ?? "";
  const rawCurls = [...script.matchAll(/^\s*curl[^\n]*-o\s+(\S+)/gm)].map((m) => m[1]);
  for (const target of rawCurls) {
    assert.ok(
      target.includes(".unverified"),
      `the script curls to ${target} directly — fetched files must land on an ` +
        `.unverified path and be moved only after the digest check`,
    );
  }
});

test("the documented regenerate and confirm loops cover every fetched file", () => {
  // Both snippets enumerate the fetch set by hand, one line away from the
  // `fetch_verified` calls that define it. A file missing from a loop is a file
  // whose digest a maintainer following the docs would never recompute — exactly
  // how #72 shipped a stale digest. Cheap to state, so it is stated.
  for (const [, body] of README.matchAll(/^for f in ([^;]+); do$/gm)) {
    const listed = new Set(body.trim().split(/\s+/));
    for (const { file } of fetches) {
      assert.ok(listed.has(file), `a documented loop over "${body.trim()}" omits ${file}`);
    }
  }
});

// ── INTEGRITY: the digests describe the pin ──────────────────────────────────

test("every recorded digest matches the file at the pin", () => {
  // Hard on every branch: a digest that does not describe the pin means the
  // bootstrap refuses a legitimate file TODAY, and the author can fix it here.
  const { integrity } = inspect(README);
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
  const { stale } = inspect(README);

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
