// Drift gate for the toolpath prebuilt pin (#116).
//
// ── Why this exists ──────────────────────────────────────────────────────────
// `setup-toolpath.sh` fetches a prebuilt `path` from a release asset and refuses
// it unless it hashes to a digest recorded in the script itself. Two files have
// to agree for that to work at all: `toolpath-prebuild.yml` decides what the
// asset is CALLED and where it is published, and `setup-toolpath.sh` decides
// what to ask for. Nothing in either file forces the other to match.
//
// That is exactly the shape of the bootstrap's #71/#72 pair — a pin and the
// thing it names, maintained by hand in two places, both wrong within one
// afternoon — and it fails the same invisible way: whoever has a working `path`
// never notices, because the fallback compile quietly covers for it. The
// symptom is only ever "the ratchet silently stopped ratcheting", which is
// indistinguishable from "it is working" unless something asserts on it.
//
// So the naming is derived from one value on each side and this file holds the
// two sides to the same value.
//
// ── Why an EMPTY digest is allowed ───────────────────────────────────────────
// The digest cannot exist before a build is published, and it must arrive
// through a reviewed diff rather than from the lane that publishes the bytes. So
// "no digest recorded" is a legitimate state — the script goes to the compile —
// and this file checks the SHAPE of the pin, not its presence. What it will not
// allow is a digest that is present and malformed, because that one refuses
// every download while looking configured.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = readFileSync(join(HERE, "setup-toolpath.sh"), "utf8");
const WORKFLOW = readFileSync(join(HERE, "..", ".github", "workflows", "toolpath-prebuild.yml"), "utf8");

/** Read a `NAME=value` assignment from the script's pin block. */
const shVar = (name) => SCRIPT.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1] ?? null;

// ── The pin is well-formed ───────────────────────────────────────────────────

test("the script carries the pin trio", () => {
  for (const name of ["TOOLPATH_VERSION", "TOOLPATH_SHA256", "TOOLPATH_TRIPLE"]) {
    assert.notEqual(shVar(name), null, `${name} is not declared — the prebuilt path has no pin`);
  }
  assert.match(shVar("TOOLPATH_VERSION"), /^[0-9]+(\.[0-9]+)*$/, "TOOLPATH_VERSION is not a plain dotted number");
});

test("a recorded digest is 64 lowercase hex, or absent", () => {
  // Absent = "not published yet", the state this ships in. Present-and-wrong is
  // the dangerous one: it refuses every download while looking configured.
  const sum = shVar("TOOLPATH_SHA256");
  if (sum === "") return;
  assert.match(sum, /^[0-9a-f]{64}$/, `TOOLPATH_SHA256=${sum} is not a sha256 — every prebuilt fetch would be refused`);
});

// ── The two files agree about what is published and fetched ──────────────────

test("the script asks for the asset the workflow publishes", () => {
  // Both sides must DERIVE the name from their version variable. A literal
  // version in either name is the drift this gate exists to stop.
  assert.ok(
    SCRIPT.includes('asset="path-$TOOLPATH_VERSION-$TOOLPATH_TRIPLE"'),
    "the script no longer derives the asset name from its own version/triple",
  );
  assert.ok(
    WORKFLOW.includes('asset="path-$VERSION-$TRIPLE"'),
    "the workflow no longer derives the asset name from its version/triple",
  );
});

test("the script asks for the tag the workflow creates", () => {
  assert.ok(
    SCRIPT.includes("releases/download/toolpath-v$TOOLPATH_VERSION/$asset"),
    "the script's release URL no longer derives its tag from TOOLPATH_VERSION",
  );
  assert.ok(WORKFLOW.includes('tag="toolpath-v$VERSION"'), "the workflow's tag shape changed — the script would 404");
});

test("both sides name the same target triple", () => {
  const workflowTriple = WORKFLOW.match(/^\s*TRIPLE:\s*(\S+)\s*$/m)?.[1];
  assert.equal(
    shVar("TOOLPATH_TRIPLE"),
    workflowTriple,
    "the script and the workflow disagree about the target triple — the asset would never be found",
  );
});

// ── No unverified bytes ──────────────────────────────────────────────────────

test("every download lands on an .unverified path", () => {
  // The boot.sh rule, applied here: a fetched file must not sit at a path
  // something might execute before its digest has been checked.
  //
  // `-o /dev/null` is exempt and must stay exempt: the crates.io reachability
  // probe DISCARDS its bytes, and a discarded body is never executed. Widening
  // this to every curl would force a meaningless digest onto a status check.
  for (const [, target] of SCRIPT.matchAll(/curl[^\n]*-o\s+"?([^\s"]+)"?/g)) {
    if (target === "/dev/null") continue;
    // The destination is normally a variable, so resolve one level rather than
    // insisting on a literal — demanding a literal here would push the download
    // path inline just to satisfy the gate, which is worse code for no gain.
    const name = target.match(/^\$\{?(\w+)\}?$/)?.[1];
    const resolved = name ? shVar(name) ?? SCRIPT.match(new RegExp(`^\\s*${name}="([^"]*)"`, "m"))?.[1] : target;
    assert.ok(
      resolved != null,
      `setup-toolpath.sh curls to ${target}, which this gate cannot resolve — it cannot tell whether the bytes are verified`,
    );
    assert.ok(
      resolved.includes(".unverified"),
      `setup-toolpath.sh curls to ${target} (=${resolved}) — fetched bytes must land on an .unverified path`,
    );
  }
});

test("the binary becomes executable only after the digest check", () => {
  // Ordering is the security property. chmod +x before the comparison would
  // leave runnable unverified bytes on disk even though the mv never happens.
  const check = SCRIPT.indexOf('if [ "$got" != "$TOOLPATH_SHA256" ]');
  const chmod = SCRIPT.indexOf('chmod +x "$tmp"');
  assert.ok(check > 0, "the digest comparison is gone — the prebuilt would be trusted on the endpoint's word");
  assert.ok(chmod > check, "chmod +x runs before the digest comparison — unverified bytes would be made executable");
});

// ── The fallback and the posture both survive ────────────────────────────────

test("the compile is still there as a fallback", () => {
  // A session that cannot reach the release asset — no `.github` attached — must
  // still end up with a working `path`. Removing this turns #116's accepted
  // degradation into an outage.
  assert.ok(
    SCRIPT.includes("cargo install path-cli --locked"),
    "the cargo fallback is gone — a session without .github attached would get no `path` at all",
  );
});

test("the prebuilt is tried before the registry is probed", () => {
  // Prebuilt-FIRST is the whole ratchet: if the common case still touches
  // crates.io, the two dialog domains cannot be retired.
  const prebuilt = SCRIPT.indexOf("if install_prebuilt; then");
  const probe = SCRIPT.indexOf("index.crates.io/config.json");
  assert.ok(prebuilt > 0, "the prebuilt attempt is gone");
  assert.ok(probe > prebuilt, "the crates.io probe runs before the prebuilt attempt — the ratchet is inverted");
});

test("every exit is a quiet success", () => {
  // Best-effort hook: a session without `path` is degraded, not broken, and a
  // non-zero SessionStart hook is a startup error the user has to read.
  const bad = [...SCRIPT.matchAll(/^\s*exit\s+([1-9][0-9]*)\s*$/gm)].map((m) => m[0].trim());
  assert.deepEqual(bad, [], `setup-toolpath.sh exits non-zero (${bad.join(", ")}) — it must fail quiet and open`);
});
