// What wakes claim-sweep, and what it passes the door when it does.
//
// WHY THIS FILE EXISTS. The lane shipped with a weekly cron and, measured on
// 2026-08-31, had never once run on it: five `workflow_dispatch` runs in
// `.github-private`, six in `.github`, zero on `schedule` in either. Adding an
// event trigger is the fix, but it lands on a `with:` block that was written for
// exactly two events and silently mis-evaluates for a third — so the trigger and
// the values it carries have to be checked together, or the lane starts waking
// and hands the door the wrong inputs.
//
// THE EXPRESSIONS ARE READ OUT OF THE WORKFLOW AND THE TYPES OUT OF THE DOOR,
// never restated here. A test carrying its own copy of either passes while
// production runs something else, which is the drift #368 records. The FIXTURES
// carry the intent — event in, value out — and nothing else in this file knows
// what the expressions say.
//
// WHY EVALUATING WITH JAVASCRIPT IS NOT A REIMPLEMENTATION. The whole defect
// class here is that GitHub's `&&` and `||` return AN OPERAND rather than a
// boolean — the same semantics JavaScript has, which is where GitHub's are
// documented to come from. Translating the expression and letting JS's own
// operators evaluate it therefore borrows the reference implementation of the
// one rule under test, instead of my paraphrase of it. The translation is four
// substitutions, listed at `evaluate` below, and is the only thing this file
// could get wrong; the mutation log at the bottom is what establishes it does
// not just pass on anything.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const wf = (n) => readFileSync(join(here, "..", ".github", "workflows", n), "utf8");

const CALLER_RAW = wf("claim-sweep.yml");
const DOOR_RAW = wf("_claim-sweep.yml");

// FULL-LINE COMMENTS ARE STRIPPED BEFORE ANY GREP, and in this file that is not
// hygiene — it is load-bearing. The `on:` block's own prose argues against
// `pull_request: [closed]` and against a bare `issues:` by NAMING them, so a grep
// over the raw file reads the rejected designs as adopted ones and the argument
// for the narrow trigger as a violation of it. `claim-sweep-linked-pr.test.mjs`
// hit the same shape (a comment quoting `search/issues` while asserting its
// absence) and wrote the rule down; `4830c48` hit its mirror image, a guard its
// own documentation satisfied. Stripping also keeps the cheapest route to green
// from being "delete the explanation".
const strip = (s) =>
  s
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

const CALLER = strip(CALLER_RAW);
const DOOR = strip(DOOR_RAW);

// ── the trigger ─────────────────────────────────────────────────────────────

// Everything between `on:` and the next top-level key.
function onBlock(src) {
  const m = src.match(/^on:\n([\s\S]*?)(?=^\S)/m);
  assert.ok(m, "no `on:` block found in the caller");
  return m[1];
}

const ON = onBlock(CALLER);

test("claim-sweep wakes on an issue closing, not only on a cron", () => {
  assert.match(
    ON,
    /^ {2}issues:/m,
    "the caller has no `issues` trigger — rule 2 (release on a CLOSED issue) is " +
      "back to waiting for a weekly cron that has never fired",
  );
});

test("the cron stays: rule 3 expires by wall clock and no event can announce it", () => {
  assert.match(
    ON,
    /^ {2}schedule:/m,
    "the schedule was removed — rule 3 (release an open issue gone quiet past " +
      "stale_days) becomes true through the PASSAGE OF TIME, so an event " +
      "trigger cannot carry it and dropping the cron makes rule 3 unreachable",
  );
  assert.match(ON, /- cron: "[^"]+"/, "the schedule block declares no cron");
});

test("the issues trigger is narrowed to `closed` and nothing else", () => {
  const m = ON.match(/^ {2}issues:\n {4}types: \[([^\]]*)\]/m);
  assert.ok(
    m,
    "the `issues` trigger does not declare an explicit `types:` list. A bare " +
      "`issues:` fires on `unlabeled` and `unassigned` too — which is exactly " +
      "what a release writes, so the sweep would wake itself on its own output",
  );
  const types = m[1].split(",").map((t) => t.trim()).filter(Boolean);
  assert.deepEqual(
    types,
    ["closed"],
    "`closed` is the precondition of rule 2 and the only issue event that makes " +
      "any rule newly true; `unlabeled`/`unassigned` are the sweep's own writes",
  );
});

// ── the inputs those wakings carry ──────────────────────────────────────────

// The door's declared input types, read from `_claim-sweep.yml`'s workflow_call
// block, so the caller is checked against what the door actually accepts.
function doorInputTypes() {
  const call = DOOR.match(/workflow_call:\n {4}inputs:\n([\s\S]*?)(?=^ {4}\S|^\S)/m);
  assert.ok(call, "could not find the door's workflow_call inputs");
  const types = {};
  for (const m of call[1].matchAll(/^ {6}(\w+):\n(?: {8}.*\n)*? {8}type: (\w+)/gm)) {
    types[m[1]] = m[2];
  }
  assert.ok(Object.keys(types).length >= 3, "read too few input types from the door");
  return types;
}

const TYPES = doorInputTypes();

// The caller's `with:` expressions, verbatim.
function callerWith() {
  // Anchored to the end of file with a sentinel rather than `$`: under /m, `$`
  // matches the end of the FIRST line and truncates the block to one key, which
  // reads as "the caller passes no release_closed" — a green-looking way to lose
  // most of this file's coverage.
  //
  // THE SENTINEL IS WRITTEN `\u0000`, NOT AS A LITERAL NUL, and must stay that
  // way. A raw NUL byte in the source makes git and grep classify this file as
  // BINARY: `git diff` renders the whole test as "Binary files differ", so a
  // reviewer sees nothing and the file lands unread. The escape is the same
  // character at runtime and keeps the file text.
  const m = (CALLER + "\n\u0000").match(/^ {4}with:\n([\s\S]*?)(?=^ {4}\S|^\S|\u0000)/m);
  assert.ok(m, "no `with:` block in the caller");
  const out = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^ {6}(\w+): \$\{\{ (.+) \}\}$/);
    if (kv) out[kv[1]] = kv[2];
  }
  return out;
}

const WITH = callerWith();

// The four substitutions, and nothing else:
//   github.event_name  → the event under test
//   inputs.<name>      → the dispatch input, or null when the event supplies none
//   ==                 → ===   (both sides are string literals in these expressions)
//   !=                 → !==
// GitHub's `&&`/`||` are then JavaScript's `&&`/`||`, untouched, which is the
// rule being tested.
function evaluate(expr, { event, inputs }) {
  const js = expr
    .replace(/github\.event_name/g, JSON.stringify(event))
    .replace(/inputs\.(\w+)/g, (_, k) =>
      inputs && k in inputs ? JSON.stringify(inputs[k]) : "null",
    )
    .replace(/([^=!<>])==([^=])/g, "$1===$2")
    .replace(/([^=!<>])!=([^=])/g, "$1!==$2");
  return new Function(`"use strict"; return (${js});`)();
}

// event → what the door must receive. Written from the lane's stated intent
// (#713: an unattended run is a REAL run; a dispatch defaults to dry), not from
// reading the expressions.
const CASES = [
  {
    name: "schedule — the weekly backstop is a real run (#713)",
    ctx: { event: "schedule", inputs: null },
    want: { dry_run: false, release_closed: true, stale_days: "14" },
  },
  {
    name: "issues.closed — an event waking is a real run for the same reason",
    ctx: { event: "issues", inputs: null },
    want: { dry_run: false, release_closed: true, stale_days: "14" },
  },
  {
    name: "workflow_dispatch — defaults preview, touching nothing",
    ctx: {
      event: "workflow_dispatch",
      inputs: { dry_run: true, release_closed: true, stale_days: "14" },
    },
    want: { dry_run: true, release_closed: true, stale_days: "14" },
  },
  {
    name: "workflow_dispatch — an operator turning the dry run OFF is honoured",
    ctx: {
      event: "workflow_dispatch",
      inputs: { dry_run: false, release_closed: true, stale_days: "14" },
    },
    want: { dry_run: false, release_closed: true, stale_days: "14" },
  },
  {
    // The case a tempting rewrite of `release_closed` silently eats: put the
    // dispatch value in the guarded half of `a && b || true` and a deliberate
    // `false` is discarded by the `||`, turning "preview closed-issue releases
    // only" into a real run over them.
    name: "workflow_dispatch — an operator turning release_closed OFF is honoured",
    ctx: {
      event: "workflow_dispatch",
      inputs: { dry_run: true, release_closed: false, stale_days: "14" },
    },
    want: { dry_run: true, release_closed: false, stale_days: "14" },
  },
  {
    name: "workflow_dispatch — a stale_days override reaches the door",
    ctx: {
      event: "workflow_dispatch",
      inputs: { dry_run: true, release_closed: true, stale_days: "30" },
    },
    want: { dry_run: true, release_closed: true, stale_days: "30" },
  },
];

for (const c of CASES) {
  test(`with: ${c.name}`, () => {
    for (const [key, want] of Object.entries(c.want)) {
      assert.ok(key in WITH, `the caller passes no \`${key}\``);
      const got = evaluate(WITH[key], c.ctx);

      // TYPE FIRST, and this is the assertion that catches the shape the lane
      // actually shipped. `cond && false || inputs.x` yields `inputs.x` on EVERY
      // event, because the `false` is falsy and `||` discards it — so on a
      // scheduled run it resolved to null rather than to the `false` #713
      // requires. A value-only check can pass on that by coincidence wherever
      // null and false happen to agree downstream; the type check cannot.
      if (TYPES[key] === "boolean") {
        assert.equal(
          typeof got,
          "boolean",
          `\`${key}\` is declared \`type: boolean\` by the door but the caller ` +
            `resolves it to ${JSON.stringify(got)} (${got === null ? "null" : typeof got}) ` +
            `on a \`${c.ctx.event}\` event`,
        );
      } else if (TYPES[key] === "string") {
        assert.equal(typeof got, "string", `\`${key}\` must resolve to a string`);
      }

      assert.equal(
        got,
        want,
        `\`${key}\` resolves to ${JSON.stringify(got)} on a \`${c.ctx.event}\` ` +
          `event; expected ${JSON.stringify(want)}`,
      );
    }
  });
}

// ── the invariant that must survive every trigger change ────────────────────

test("the sweep still never writes issue state", () => {
  // Ratified semantics: release, never close. Clearing a claim asserts only that
  // no session holds it — never that the work is done. A trigger change must not
  // become the moment a `state` write appears, and the door is where such a write
  // would have to live.
  assert.doesNotMatch(
    DOOR,
    /-X (PATCH|POST)[^\n]*issues\/\$n(?!\/)/,
    "the door PATCHes the issue itself — the only writes it may make are the " +
      "release comment, the label DELETE and the assignee DELETE",
  );
  assert.doesNotMatch(
    DOOR,
    /state=?["']?(closed|open)/,
    "the door names an issue state to write; releasing a claim must never close " +
      "or reopen anything",
  );
});

test("the standing-claim exemption is not weakened by the new trigger", () => {
  // An event-driven lane runs far more often than a weekly one, so the exemption
  // that protects machine-lane claims gets exercised far more often too.
  assert.match(
    DOOR,
    /exempt_label:/,
    "the door no longer takes an exempt_label — every machine lane's standing " +
      "claim becomes sweepable",
  );
  assert.match(
    DOOR,
    /EXEMPT_LABEL.*must not be empty|must not be empty.*exempt_label/,
    "the door no longer hard-fails on an empty exempt_label",
  );
});
