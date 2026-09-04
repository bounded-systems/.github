// Every test file in this repo is run by some workflow, and every test a workflow
// names exists (#355).
//
// ── Why this exists ──────────────────────────────────────────────────────────
// org-defaults.yml enumerates test files BY HAND, one `node --test <file>` line
// each. Nothing compared that list to what is on disk, so a test file nobody
// typed into it was simply never run -- and the repo reported green. On
// 2026-09-03 that was thirteen files and 300-odd assertions, all passing
// locally, none gating anything; one of them (#360's) landed within the hour
// of #355 being opened. #354's own tests went one commit ungated the same way.
//
// This is the same argument bootstrap-pin.test.mjs makes about an orphan SUM_
// digest and attest-boot's subject list (#534): a list restated by hand drifts,
// a list DERIVED from the source of truth cannot. Here the source of truth is
// the filesystem, and the assertion runs in both directions.
//
// A file that genuinely must not run in CI belongs in UNGATED with a reason --
// the same posture IRREDUCIBLE takes in session-start-dispatch.mjs, where a
// declared "cannot" is distinguishable from an omission. A bare absence is not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Declared exceptions: { file, reason }. Empty is the goal; a reason is the price of an entry. */
export const UNGATED = [];

/** Every *.test.mjs under the repo, skipping dependency and VCS trees. */
export function testFiles(root = ROOT) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".git") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".test.mjs")) out.push(relative(root, p));
    }
  };
  walk(root);
  return out.sort();
}

/** Every path a workflow hands to `node --test`, keyed by the workflow that names it. */
export function gatedFiles(root = ROOT) {
  const dir = join(root, ".github", "workflows");
  const out = new Map();
  for (const wf of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
    const text = readFileSync(join(dir, wf), "utf8");
    // `bun test` counts as a gate for the same reason `node --test` does: a suite
    // that needs Bun.YAML (scripts/repo-standard-conformance.test.mjs) runs
    // under bun, and an ungated suite is the failure this file exists to catch.
    for (const m of text.matchAll(/(?:node\s+--test|bun\s+test)\s+([^\n#]+)/g)) {
      for (const p of m[1].trim().split(/\s+/)) {
        if (!p.endsWith(".test.mjs")) continue;
        if (!out.has(p)) out.set(p, []);
        out.get(p).push(wf);
      }
    }
  }
  return out;
}

const onDisk = testFiles();
const gated = gatedFiles();
const declared = new Map(UNGATED.map((u) => [u.file, u]));

test("this gate is itself gated — otherwise it proves nothing", () => {
  assert.ok(gated.has(".claude/test-coverage.test.mjs"), "test-coverage.test.mjs is not run by any workflow");
});

test("every test file on disk is run by a workflow, or declared ungated with a reason", () => {
  const missing = onDisk.filter((f) => !gated.has(f) && !declared.has(f));
  assert.deepEqual(
    missing,
    [],
    `${missing.length} test file(s) run in no workflow:\n` +
      missing.map((f) => `      ${f}`).join("\n") +
      `\n  Add a \`- run: node --test <file>\` line (org-defaults.yml's schema job is the usual home),\n` +
      `  or an UNGATED entry in .claude/test-coverage.test.mjs saying why nothing can run it.`,
  );
});

test("every test a workflow names exists on disk", () => {
  // The reverse direction, and the one that goes stale quietly: a renamed or
  // deleted test leaves a step that fails on every run -- or, with `|| true`
  // somewhere, one that passes on every run while testing nothing.
  const phantom = [...gated.keys()].filter((f) => !onDisk.includes(f));
  assert.deepEqual(phantom, [], `workflow(s) run test file(s) that do not exist: ${phantom.join(", ")}`);
});

test("a file is gated OR declared ungated, never both", () => {
  const both = [...declared.keys()].filter((f) => gated.has(f));
  assert.deepEqual(both, [], `declared ungated but a workflow runs it anyway: ${both.join(", ")}`);
});

test("every ungated declaration names a real file and carries a reason", () => {
  for (const { file, reason } of UNGATED) {
    assert.ok(onDisk.includes(file), `UNGATED names ${file}, which does not exist`);
    assert.ok(reason?.trim().length > 40, `the UNGATED entry for ${file} has no real reason`);
  }
});
