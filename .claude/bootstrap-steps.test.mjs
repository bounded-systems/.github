// Drift gate between the canonical bootstrap (boot.sh — fetched by the
// one-line setup-script field, see README.md) and the dispatcher's
// coverage of it (#91 — I1 in docs/session-capability-invariants.md).
//
// ── Why this exists ──────────────────────────────────────────────────────────
// The setup-script field is the one link in this chain living outside version
// control: no reviewer reads it, no gate sees it, and it is retyped into a
// container on every boot. On 2026-08-01 it had been reduced to 264 bytes — the
// `settings.json` heredoc alone — losing three of its four steps. Losing the
// `register-mcp.mjs` call cost Front Desk entirely; losing the
// `stop-hook-git-check.sh` copy reinstated infra#112 silently. Nothing reported
// either, and #85 was found by reading /tmp/env-manager.log by hand.
//
// The dispatcher now re-does both (#84, #88). What was still missing is the
// RELATION: nothing tied the field's contents to that coverage, so the mapping
// lived only as prose in README.md, and a step added to the field with no
// fallback stayed invisible until it went missing in production. This file is
// that relation, machine-checked.
//
// ── Why the parse lives in gen-bootstrap-pin.mjs ─────────────────────────────
// Same argument bootstrap-pin.test.mjs makes in its own header, and the same
// reason: a gate that decides what a "step" is separately from the tool that
// reads the field is one refactor away from disagreeing with it. That generator
// already parses this exact block for PIN and the SUM_* lines, so it is where
// the third reading of it belongs. This file asserts ON the parse; it does not
// reimplement it.
//
// ── Why absence must be DECLARED ─────────────────────────────────────────────
// Two of the field's four steps have no fallback and cannot have one — writing
// the pointer that invokes this dispatcher would have to run before itself. That
// is a decision. A step someone forgot to cover is an omission. Both present as
// silence, and it was an omission wearing a decision's clothes that cost #85, so
// the manifest carries IRREDUCIBLE entries with reasons and this file treats an
// undeclared step as a failure rather than as an implied "cannot".

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseSteps } from "./gen-bootstrap-pin.mjs";
import { IRREDUCIBLE, MANIFEST } from "./session-start-dispatch.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BOOT_SH = readFileSync(join(HERE, "boot.sh"), "utf8");

const steps = parseSteps(BOOT_SH);
const covered = new Map(MANIFEST.map((e) => [e.artifact, e]));
const declared = new Map(IRREDUCIBLE.map((e) => [e.artifact, e]));

// ── The gate ─────────────────────────────────────────────────────────────────

test("the canonical field still parses into steps", () => {
  // If this goes red, the field was reformatted into a shape the parse does not
  // recognise — which means every assertion below is vacuously green. It is
  // first for the same reason workflows.test.mjs runs first in org-defaults.yml:
  // the check that the other checks ran at all.
  assert.ok(steps.length > 0, "no steps found in the canonical setup script — the parse or the field moved");
});

test("every step of the canonical field has a fallback or is declared irreducible", () => {
  // THE point of #91. A step added to the field with no manifest entry fails
  // here, at PR time, instead of in a session six weeks later.
  for (const { artifact, lines } of steps) {
    assert.ok(
      covered.has(artifact) || declared.has(artifact),
      `the canonical setup script installs "${artifact}" and nothing covers it:\n` +
        lines.map((l) => `      ${l}`).join("\n") +
        `\n  Add a MANIFEST entry in session-start-dispatch.mjs so the dispatcher re-does this\n` +
        `  step when the field has not, or an IRREDUCIBLE entry saying why nothing can.\n` +
        `  A step in neither list is exactly the state #85 shipped in.`,
    );
  }
});

test("a step is covered by a fallback OR declared irreducible, never both", () => {
  // Both would mean the manifest repairs something the file also claims is
  // unrepairable. Whichever is stale, the reader cannot tell which to believe.
  for (const { artifact } of steps) {
    assert.ok(
      !(covered.has(artifact) && declared.has(artifact)),
      `"${artifact}" is both repaired by the manifest and declared irreducible`,
    );
  }
});

test("nothing is covered or declared that the field does not actually do", () => {
  // The reverse direction, and the one that goes stale quietly: a step removed
  // from the field leaves an entry here repairing something nobody installs any
  // more. Harmless at runtime, but it is the evidence that the two have drifted,
  // and it is the same argument bootstrap-pin.test.mjs makes about an orphan
  // SUM_ digest.
  const inField = new Set(steps.map((s) => s.artifact));
  for (const artifact of [...covered.keys(), ...declared.keys()]) {
    assert.ok(
      inField.has(artifact),
      `"${artifact}" is covered in session-start-dispatch.mjs but the canonical setup ` +
        `script no longer installs it — remove the entry, or restore the step`,
    );
  }
});

test("every irreducible declaration carries a reason", () => {
  // A bare `irreducible: true` is indistinguishable from the omission it exists
  // to be distinguished from. The reason is the whole content of the claim.
  for (const { artifact, reason } of IRREDUCIBLE) {
    assert.ok(reason?.trim().length > 40, `the irreducible declaration for "${artifact}" has no real reason`);
  }
});

// ── The manifest is well-formed enough to drive ──────────────────────────────

test("every manifest entry can detect, repair, and be identified", () => {
  for (const entry of MANIFEST) {
    assert.ok(entry.artifact, "a manifest entry has no artifact — the gate keys on it");
    assert.equal(typeof entry.compare, "function", `${entry.artifact} has no detector`);
    assert.equal(typeof entry.repair, "function", `${entry.artifact} has no repairer`);
    // `context` is optional and MAY be null — the Stop hook reports on stderr
    // only, deliberately — but a non-null one has to be callable.
    assert.ok(
      entry.context === null || typeof entry.context === "function",
      `${entry.artifact} has a context field that is neither null nor a function`,
    );
  }
});

test("the two artifacts that broke on 2026-08-01 are both still covered", () => {
  // Pins the specific regressions rather than only the general property: #85 lost
  // the register-mcp.mjs call and the stop-hook copy, and a manifest that
  // silently stopped naming either would satisfy every test above by also
  // dropping out of the field.
  assert.ok(covered.has("register-mcp.mjs"), "nothing re-runs register-mcp.mjs (#84)");
  assert.ok(covered.has("stop-hook-git-check.sh"), "nothing re-copies the Stop hook (#88/infra#112)");
});

// ── The parse refuses what it does not understand ────────────────────────────

test("a step added to the field with no fallback fails this gate", () => {
  // The NEGATIVE test, and the reason to believe any of the above. A gate nobody
  // has watched go red is a gate nobody knows is wired up: this adds a line to a
  // copy of the canonical text and asserts the step surfaces uncovered.
  const withNewStep = BOOT_SH.replace(
    'echo "bootstrap: ready — dispatcher at $BOOT"',
    'cp "$BOOT/some-new-thing.sh" "$HOME/.claude/some-new-thing.sh"\necho "bootstrap: ready — dispatcher at $BOOT"',
  );
  assert.notEqual(withNewStep, BOOT_SH, "the anchor line moved — this test is no longer exercising anything");

  const found = parseSteps(withNewStep).map((s) => s.artifact);
  assert.ok(found.includes("some-new-thing.sh"), "the parse did not notice a new install step");
  assert.ok(
    !covered.has("some-new-thing.sh") && !declared.has("some-new-thing.sh"),
    "the new step is somehow already covered — this test proves nothing",
  );
});

test("an unclassifiable command refuses to parse rather than being skipped", () => {
  // The failure mode this parse must not have: a verb it does not know silently
  // dropping out of the enumeration, which would make the gate above green for a
  // step nothing covers — the exact invisibility #91 is about.
  const withMystery = BOOT_SH.replace(
    'echo "bootstrap: ready — dispatcher at $BOOT"',
    'systemctl restart something\necho "bootstrap: ready — dispatcher at $BOOT"',
  );
  assert.throws(() => parseSteps(withMystery), /unrecognized command/);
});

test("the fetch cache is staging, not installing", () => {
  // `fetch_verified` writes into $BOOT and the mv lands there too. Those are not
  // steps: the files are staged, and what makes them live is the settings.json
  // write and the node/cp lines that follow — which ARE steps and are covered.
  // Counting them would demand a fallback for the dispatcher fetching itself.
  assert.ok(!steps.some((s) => s.artifact.endsWith(".unverified")), "the .unverified staging path parsed as a step");

  // Same rule, second writer (#325). boot.sh writes the `.mcp.json` that
  // DECLARES the fetched verb server into the cache, beside the fetched files —
  // content, not an install. What makes it live is `node $BOOT/register-mcp.mjs`
  // further down, which is a step and is covered. The rule was written once per
  // verb (cp/mv had it, cat did not), so this pins the shared one.
  assert.ok(!steps.some((s) => s.artifact === ".mcp.json"), "a heredoc into the fetch cache parsed as an install step");
});

test("the cache exemption is scoped to the cache, not to the verb", () => {
  // The thing that must NOT have happened when `cat` gained the exemption above:
  // a blanket "heredocs are content" rule would have silently un-covered the
  // settings.json write — the single step that makes every SessionStart hook run
  // — and this suite would have gone green with the field's most load-bearing
  // line no longer enumerated at all.
  assert.ok(
    steps.some((s) => s.artifact === "settings.json"),
    "the settings.json heredoc stopped counting as a step — the cache exemption leaked past $BOOT",
  );

  const outsideCache = BOOT_SH.replace(
    'echo "bootstrap: ready — dispatcher at $BOOT"',
    'cat > "$CFG/some-new-thing.json" <<EOF\n{}\nEOF\necho "bootstrap: ready — dispatcher at $BOOT"',
  );
  assert.notEqual(outsideCache, BOOT_SH, "the anchor line moved — this test is no longer exercising anything");
  assert.ok(
    parseSteps(outsideCache).some((s) => s.artifact === "some-new-thing.json"),
    "a heredoc landing OUTSIDE the fetch cache stopped being a step",
  );
});

test("a heredoc BODY is content, not a command", () => {
  // The settings.json heredoc contains a `node …session-start-dispatch.mjs`
  // command STRING. Enumerating it would ask for a fallback for the dispatcher
  // installing itself — which is the declared-irreducible case, not a step of
  // its own, and the `settings.json` write already covers that line.
  assert.ok(
    !steps.some((s) => s.artifact === "session-start-dispatch.mjs"),
    "the dispatcher's own path inside the settings heredoc parsed as a step",
  );
});
