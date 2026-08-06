// Behavior tests for status-probe.sh, the SessionStart service-status probe.
//
// The probe's failure modes are all SILENCE — fail open on no network, no
// tools, stale data — and silence is also its healthy state. A probe like
// that can break completely and present exactly like health, which is why
// every path here is pinned: the only thing distinguishing "quiet because
// healthy" from "quiet because broken" is this file.
//
// No network. The probe exposes three URL seams (BOUNDED_STATUS_URL for the
// org snapshot, BOUNDED_STATUS_{GITHUB,ANTHROPIC}_URL for the direct
// Statuspage fallbacks) and every test points them at file:// fixtures.
// curl reads file:// URLs, so the probe runs its real fetch path — the same
// bytes CI and sessions run, not a mock of them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROBE = join(dirname(fileURLToPath(import.meta.url)), "status-probe.sh");
const root = mkdtempSync(join(tmpdir(), "status-probe-test-"));
let n = 0;

/** Write a fixture; returns its file:// URL. */
function fixture(value) {
  const p = join(root, `f${n++}.json`);
  writeFileSync(p, typeof value === "string" ? value : JSON.stringify(value));
  return `file://${p}`;
}

/** A Statuspage base dir: fetch appends /api/v2/summary.json to the base. */
function statuspage(summary) {
  const base = join(root, `sp${n++}`);
  mkdirSync(join(base, "api", "v2"), { recursive: true });
  writeFileSync(
    join(base, "api", "v2", "summary.json"),
    typeof summary === "string" ? summary : JSON.stringify(summary),
  );
  return `file://${base}`;
}

// RFC 3339 UTC at SECOND precision. jq 1.7's fromdateiso8601 rejects
// fractional seconds, so the contract requires this exact shape — see the
// fractional-seconds test below, which pins what happens otherwise.
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString().replace(/\.\d{3}Z$/, "Z");

const HEALTHY_PAGE = { status: { indicator: "none" }, components: [], incidents: [] };
const DEGRADED_PAGE = {
  status: { indicator: "minor" },
  components: [
    { name: "Actions", status: "degraded_performance" },
    { name: "API Requests", status: "operational" },
  ],
  incidents: [{ name: "Disruption with some GitHub services", shortlink: "https://stspg.io/x", status: "investigating" }],
};
// A distinctive marker so tests can tell "the direct probes ran" from "the
// snapshot answered": no snapshot fixture ever mentions DirectMarker.
const MARKER_PAGE = {
  status: { indicator: "major" },
  components: [{ name: "DirectMarker", status: "major_outage" }],
  incidents: [],
};

const UNREACHABLE = "file:///nonexistent-status-probe-test";

/** Run the probe with all three seams controlled; unset seams point nowhere. */
function probe(env = {}) {
  const r = spawnSync("bash", [PROBE], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      BOUNDED_STATUS_URL: "",
      BOUNDED_STATUS_GITHUB_URL: UNREACHABLE,
      BOUNDED_STATUS_ANTHROPIC_URL: UNREACHABLE,
      ...env,
    },
  });
  assert.equal(r.status, 0, `probe must always exit 0 (fail open); got ${r.status}\nstderr: ${r.stderr}`);
  return r.stdout;
}

/** Parse stdout as the SessionStart envelope and return additionalContext. */
function context(stdout) {
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
  const ctx = parsed.hookSpecificOutput.additionalContext;
  assert.ok(typeof ctx === "string" && ctx.length > 0);
  return ctx;
}

test("healthy everywhere → silent (empty stdout, exit 0)", () => {
  const out = probe({
    BOUNDED_STATUS_GITHUB_URL: statuspage(HEALTHY_PAGE),
    BOUNDED_STATUS_ANTHROPIC_URL: statuspage(HEALTHY_PAGE),
  });
  assert.equal(out.trim(), "");
});

test("nothing reachable → silent, not an error", () => {
  assert.equal(probe().trim(), "");
});

test("degraded provider via direct probe → envelope names provider, components, incident", () => {
  const ctx = context(probe({ BOUNDED_STATUS_GITHUB_URL: statuspage(DEGRADED_PAGE) }));
  assert.match(ctx, /\*\*GitHub\*\*: minor/);
  assert.match(ctx, /Actions/);
  assert.doesNotMatch(ctx, /API Requests/); // operational components stay out
  assert.match(ctx, /Disruption with some GitHub services/);
  assert.match(ctx, /incident starting mid-session produces no warning/);
});

test("fresh degraded snapshot answers alone — direct probes not consulted", () => {
  const ctx = context(
    probe({
      BOUNDED_STATUS_URL: fixture({
        generated_at: iso(),
        providers: {
          GitHub: {
            indicator: "minor",
            components: ["Actions"],
            incidents: [{ name: "Snapshot incident", url: "https://example.test/i" }],
          },
        },
      }),
      // Both direct sources scream; if either line appears, the snapshot
      // failed to end the probe and we double-reported.
      BOUNDED_STATUS_GITHUB_URL: statuspage(MARKER_PAGE),
      BOUNDED_STATUS_ANTHROPIC_URL: statuspage(MARKER_PAGE),
    }),
  );
  assert.match(ctx, /\*\*GitHub\*\*: minor/);
  assert.match(ctx, /Snapshot incident/);
  assert.doesNotMatch(ctx, /DirectMarker/);
});

test("fresh healthy snapshot suppresses direct probes entirely", () => {
  const out = probe({
    BOUNDED_STATUS_URL: fixture({ generated_at: iso(), providers: { GitHub: { indicator: "none" } } }),
    BOUNDED_STATUS_GITHUB_URL: statuspage(MARKER_PAGE),
  });
  assert.equal(out.trim(), "");
});

// The review finding on #107, pinned: a reachable-but-stale snapshot must be
// UNANSWERED, never "healthy". Each variant below must fall through to the
// direct probes (DirectMarker appears) instead of ending the probe.
for (const [what, snapshot] of [
  ["stale (30 min old)", { generated_at: iso(30 * 60 * 1000), providers: { GitHub: { indicator: "none" } } }],
  ["missing generated_at", { providers: { GitHub: { indicator: "none" } } }],
  ["fractional-seconds generated_at (jq fromdateiso8601 rejects it)", { generated_at: new Date().toISOString(), providers: { GitHub: { indicator: "none" } } }],
  ["malformed JSON", "not json {"],
  ["wrong shape (no providers key)", { generated_at: iso(), status: "fine" }],
]) {
  test(`snapshot ${what} → falls through to direct probes`, () => {
    const ctx = context(
      probe({
        BOUNDED_STATUS_URL: fixture(snapshot),
        BOUNDED_STATUS_GITHUB_URL: statuspage(MARKER_PAGE),
      }),
    );
    assert.match(ctx, /DirectMarker/);
  });
}

test("snapshot just inside the 10-minute window still answers", () => {
  const out = probe({
    BOUNDED_STATUS_URL: fixture({ generated_at: iso(9 * 60 * 1000), providers: { GitHub: { indicator: "none" } } }),
    BOUNDED_STATUS_GITHUB_URL: statuspage(MARKER_PAGE),
  });
  assert.equal(out.trim(), "");
});

test("mock incident carries the [MOCK] label through, and the warning explains it", () => {
  const ctx = context(
    probe({
      BOUNDED_STATUS_URL: fixture({
        generated_at: iso(),
        providers: {
          FrontDeskDemo: { indicator: "major", components: ["Actions"], incidents: [], mock: true },
          GitHub: { indicator: "minor", components: ["Actions"], incidents: [] },
        },
      }),
    }),
  );
  assert.match(ctx, /\*\*FrontDeskDemo\*\*: major \[MOCK\]/);
  assert.doesNotMatch(ctx, /\*\*GitHub\*\*: minor \[MOCK\]/); // real entries unlabeled
  assert.match(ctx, /say it is a mock anywhere else/);
});

test("byte-identity claim: the copy in .github-private must match this one", () => {
  // The dispatcher dedupes the two probes' output only if the scripts stay
  // identical. Cross-repo bytes can't be asserted from one repo's CI, but a
  // multi-repo session (where this test can see both checkouts) can — and
  // skipping silently elsewhere would report a green that checked nothing,
  // so the skip is loud in the test name via the diagnostic below.
  const sibling = join(dirname(PROBE), "..", "..", ".github-private", ".claude", "status-probe.sh");
  if (!existsSync(sibling)) {
    console.log(`# .github-private not attached at ${sibling} — byte-identity not checked in this run`);
    return;
  }
  assert.equal(readFileSync(PROBE, "utf8"), readFileSync(sibling, "utf8"));
});
