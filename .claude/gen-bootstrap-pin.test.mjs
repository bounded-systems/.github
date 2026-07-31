// Unit tests for the pin generator.
//
// This tool writes the bootstrap's trust anchor, so the properties worth pinning
// are the ones that would let it write a WRONG anchor confidently: rewriting the
// wrong lines, leaving a digest behind, or silently succeeding when a variable it
// was asked to write does not exist.
//
// Fixtures rather than the real README: these must keep failing the day someone
// reformats the document, and must not start passing because the live file
// happens to be consistent.

import { test } from "node:test";
import assert from "node:assert/strict";

import { digestsAt, inspect, parseBootstrap, renderBootstrap, sha256 } from "./gen-bootstrap-pin.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);
const SUM_A = sha256("dispatcher@A");
const SUM_B = sha256("dispatcher@B");
const SUM_R = sha256("register@A");

/** A README shaped like the real one: prose, a placeholder, and live assignments. */
const fixture = ({ pin = A, dispatch = SUM_A, register = SUM_R } = {}) => `
Some prose about the pin.

\`\`\`sh
PIN=${pin}
SUM_session_start_dispatch_mjs=${dispatch}
SUM_register_mcp_mjs=${register}

fetch_verified session-start-dispatch.mjs "$SUM_session_start_dispatch_mjs"
fetch_verified register-mcp.mjs           "$SUM_register_mcp_mjs"
\`\`\`

To confirm a pin, from a clone:

\`\`\`sh
PIN=<the pin>
for f in session-start-dispatch.mjs register-mcp.mjs; do
  echo "$f"
done
\`\`\`
`;

/** Contents keyed by commit, so a "change" is just a different string. */
const world = {
  [A]: { "session-start-dispatch.mjs": "dispatcher@A", "register-mcp.mjs": "register@A" },
  [B]: { "session-start-dispatch.mjs": "dispatcher@B", "register-mcp.mjs": "register@A" },
};
const read = (commit, file) => {
  const at = world[commit]?.[file];
  if (at === undefined) throw new Error(`no ${file} at ${commit}`);
  return Buffer.from(at);
};

// ── Parsing ──────────────────────────────────────────────────────────────────

test("the fetch set comes from the call sites, not the mangled variable names", () => {
  // `-` and `.` both become `_`, so SUM_session_start_dispatch_mjs cannot be
  // turned back into a filename. Only the call site carries both halves.
  const { fetches } = parseBootstrap(fixture());
  assert.deepEqual(fetches, [
    { file: "session-start-dispatch.mjs", sumVar: "SUM_session_start_dispatch_mjs" },
    { file: "register-mcp.mjs", sumVar: "SUM_register_mcp_mjs" },
  ]);
});

test("the PIN placeholder in the confirm snippet is not mistaken for the pin", () => {
  // `PIN=<the pin>` sits in a copy-paste block below the real assignment. It is
  // not 40 hex, so it neither parses as the pin nor gets rewritten.
  const { pin } = parseBootstrap(fixture());
  assert.equal(pin, A);
});

// ── Rewriting ────────────────────────────────────────────────────────────────

test("a bump rewrites the pin and every digest, and nothing else", () => {
  const source = fixture();
  const out = renderBootstrap(source, {
    pin: B,
    digests: { SUM_session_start_dispatch_mjs: SUM_B, SUM_register_mcp_mjs: SUM_R },
  });
  assert.match(out, new RegExp(`^PIN=${B}$`, "m"));
  assert.match(out, new RegExp(`^SUM_session_start_dispatch_mjs=${SUM_B}$`, "m"));
  // The placeholder and the prose survive verbatim.
  assert.match(out, /^PIN=<the pin>$/m);
  assert.match(out, /Some prose about the pin\./);
  // Exactly two lines differ, and the line COUNT is unchanged. The count is the
  // load-bearing half: the first implementation anchored on `\s*$`, which under
  // the `m` flag matches the newline too, so each rewrite silently ate the blank
  // line following it and shifted the rest of the document up.
  const before = source.split("\n");
  const after = out.split("\n");
  assert.equal(after.length, before.length, "the rewrite changed the line count");
  assert.equal(after.filter((l, i) => l !== before[i]).length, 2);
});

test("rewriting a digest the document does not declare throws instead of no-oping", () => {
  // A silent miss would leave a fetch verified against a stale digest while the
  // generator reported success — the bootstrap would then refuse the file.
  assert.throws(
    () => renderBootstrap(fixture(), { pin: B, digests: { SUM_added_later_mjs: SUM_B } }),
    /SUM_added_later_mjs is not declared/,
  );
});

test("a bump is idempotent", () => {
  const digests = { SUM_session_start_dispatch_mjs: SUM_A, SUM_register_mcp_mjs: SUM_R };
  const once = renderBootstrap(fixture(), { pin: A, digests });
  assert.equal(renderBootstrap(once, { pin: A, digests }), once);
});

// ── Hashing a commit ─────────────────────────────────────────────────────────

test("digests are taken from the file at the commit, keyed by digest variable", () => {
  const { fetches } = parseBootstrap(fixture());
  assert.deepEqual(digestsAt(B, fetches, { read }), {
    SUM_session_start_dispatch_mjs: SUM_B,
    SUM_register_mcp_mjs: SUM_R,
  });
});

// ── The two properties, separated ────────────────────────────────────────────

test("a consistent, current document is clean on both properties", () => {
  const got = inspect(fixture(), { commit: A, read });
  assert.deepEqual(got.integrity, []);
  assert.deepEqual(got.stale, []);
});

test("a changed file with an un-bumped pin is STALE, not an integrity break", () => {
  // The #72 shape, and the one every PR touching a fetched file will show. The
  // digests still describe the pin correctly — only the pin is behind.
  const got = inspect(fixture(), { commit: B, read });
  assert.deepEqual(got.integrity, [], "the recorded digest still describes the pin");
  assert.deepEqual(got.stale, ["session-start-dispatch.mjs"]);
});

test("a digest that does not describe the pin is an INTEGRITY break", () => {
  // The bootstrap refuses this file today: it fetches the pin's bytes and
  // compares them against a digest recorded from somewhere else.
  const got = inspect(fixture({ dispatch: SUM_B }), { commit: A, read });
  assert.deepEqual(got.integrity, ["session-start-dispatch.mjs"]);
  assert.deepEqual(got.stale, []);
});

test("the two properties are reported independently, not collapsed", () => {
  // Both wrong at once must name both, since the fixes differ: integrity is
  // fixable on the branch, staleness only after the merge.
  const got = inspect(fixture({ dispatch: SUM_B }), { commit: B, read });
  assert.deepEqual(got.integrity, ["session-start-dispatch.mjs"]);
  assert.deepEqual(got.stale, ["session-start-dispatch.mjs"]);
});

test("a document with no pin is an error, not a silent pass", () => {
  assert.throws(() => inspect("no pin here", { read }), /lost its pin/);
});

test("a pin with nothing fetched is an error, not a silent pass", () => {
  assert.throws(() => inspect(`PIN=${A}\n`, { read }), /nothing is being pinned/);
});
