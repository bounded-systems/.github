// Drift gate for the bootstrap pin and its digests.
//
// ── Why this exists ──────────────────────────────────────────────────────────
// The setup script in README.md fetches two files from a pinned commit and
// executes them, refusing anything whose SHA-256 does not match a recorded
// digest. Both the pin and the digests are hand-maintained, and BOTH went wrong
// within one afternoon (2026-07-31):
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
// Two independent properties, and they fail for different reasons:
//
//   INTEGRITY — the recorded digest matches the file AT THE PIN. A mismatch means
//     the setup script would refuse a legitimate file (bootstrap dead) or, worse,
//     that a digest was copied from somewhere other than the commit it names.
//
//   FRESHNESS — the file at the pin matches the file on this branch. A mismatch
//     means the fallback still works but installs stale code, silently diverging
//     from what reviewers see here.
//
// Checked against GIT OBJECTS, not the network: hermetic, and it attests to the
// commit rather than to whatever an endpoint happened to return — which is the
// stronger claim, and the one the digests are supposed to encode.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const README = readFileSync(join(HERE, "README.md"), "utf8");

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/**
 * What the setup script says it will fetch and what it will accept.
 *
 * Derived from the `fetch_verified <file> "$SUM_<var>"` calls rather than from the
 * SUM_ variable names, because the name mangling is lossy — both `-` and `.`
 * become `_`, so `SUM_session_start_dispatch_mjs` cannot be turned back into a
 * filename unambiguously. The call site states both halves explicitly.
 */
export function parseBootstrap(source) {
  const pin = source.match(/^PIN=([0-9a-f]{40})\s*$/m)?.[1] ?? null;

  const digests = {};
  for (const [, name, value] of source.matchAll(/^(SUM_\w+)=([0-9a-f]{64})\s*$/gm)) {
    digests[name] = value;
  }

  const fetches = [...source.matchAll(/^\s*fetch_verified\s+(\S+)\s+"\$(SUM_\w+)"/gm)]
    .map(([, file, sumVar]) => ({ file, sumVar }));

  return { pin, digests, fetches };
}

const { pin, digests, fetches } = parseBootstrap(README);

/** Read a path at a commit. Throws a legible error on a shallow clone. */
function fileAtPin(file) {
  try {
    return execFileSync("git", ["show", `${pin}:.claude/${file}`], {
      cwd: HERE,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (e) {
    throw new Error(
      `cannot read ${file} at ${pin?.slice(0, 12)} — if this is CI, the checkout needs ` +
        `fetch-depth: 0, since the pin is usually not the tip commit.\n${e.message}`,
    );
  }
}

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

// ── INTEGRITY: the digests describe the pin ──────────────────────────────────

test("every recorded digest matches the file at the pin", () => {
  for (const { file, sumVar } of fetches) {
    const actual = sha256(fileAtPin(file));
    assert.equal(
      actual,
      digests[sumVar],
      `${sumVar} does not match ${file} at ${pin.slice(0, 12)}.\n` +
        `  recorded ${digests[sumVar]}\n  actual   ${actual}\n` +
        `  The bootstrap would REFUSE this file and start without it.`,
    );
  }
});

// ── FRESHNESS: the pin describes this branch ─────────────────────────────────

test("the pin is not stale — it serves what this branch contains", () => {
  const stale = [];
  for (const { file } of fetches) {
    const atPin = sha256(fileAtPin(file));
    const here = sha256(readFileSync(join(HERE, file)));
    if (atPin !== here) stale.push(file);
  }
  assert.deepEqual(
    stale,
    [],
    `the recorded PIN (${pin?.slice(0, 12)}) predates changes to: ${stale.join(", ")}.\n` +
      `  A session WITHOUT .github attached would install the older copy, and nothing\n` +
      `  else would report it — the attached checkout always wins locally.\n` +
      `  Fix: merge this, then bump PIN to the resulting commit and re-record the\n` +
      `  digests. This test is expected to fail on the PR that changes these files\n` +
      `  and to pass once the follow-up pin bump lands.`,
  );
});
