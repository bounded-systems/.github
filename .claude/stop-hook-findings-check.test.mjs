// Gate tests for the findings buffer pair (#162): findings.sh writes,
// stop-hook-findings-check.sh refuses.
//
// ── Why the refusal itself is asserted ───────────────────────────────────────
// The property that matters is not "the hook runs" — it is "the hook BLOCKS a
// stop when a finding is outstanding". Those are different claims, and only the
// second is the reason the file exists. claude-box#248 is the cautionary case:
// a `&&` guard written to short-circuit a boot did not, because `bun -e` exits 0
// on an uncaught fs error, and nothing had ever observed the guard failing
// closed. docs/agentic-code-hygiene.md rule 3 is the general form — a gate's own
// claim about itself is not evidence — so every exit-2 path below is asserted on
// the status code, not on the message.
//
// ── Why fail-open is tested too ──────────────────────────────────────────────
// A Stop gate that cannot be satisfied is a session that cannot end. The
// broken-check path (no jq) is therefore as load-bearing as the blocking path,
// and is asserted rather than assumed: it is the difference between a gate and
// a trap.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "stop-hook-findings-check.sh");
const FINDINGS = join(HERE, "findings.sh");

const OPEN = (note) => JSON.stringify({ ts: "2026-08-13T00:00:00Z", note, discharged: null });
const DONE = (note, where) => JSON.stringify({ ts: "2026-08-13T00:00:00Z", note, discharged: where });

function withBuffer(lines) {
  const dir = mkdtempSync(join(tmpdir(), "findings-"));
  const file = join(dir, "findings.jsonl");
  if (lines !== null) writeFileSync(file, lines.length ? lines.join("\n") + "\n" : "");
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function runHook(file, { stopHookActive = false, env = {} } = {}) {
  return spawnSync("bash", [HOOK], {
    input: JSON.stringify({ stop_hook_active: stopHookActive }),
    encoding: "utf8",
    env: { ...process.env, FINDINGS_FILE: file, ...env },
  });
}

function runFindings(file, args) {
  return spawnSync("bash", [FINDINGS, ...args], {
    encoding: "utf8",
    env: { ...process.env, FINDINGS_FILE: file },
  });
}

test("no buffer at all: silent, allows the stop", () => {
  const { file, cleanup } = withBuffer(null);
  try {
    const r = runHook(file);
    assert.equal(r.status, 0);
    assert.equal(r.stderr.trim(), "");
  } finally {
    cleanup();
  }
});

test("empty buffer: allows the stop", () => {
  const { file, cleanup } = withBuffer([]);
  try {
    assert.equal(runHook(file).status, 0);
  } finally {
    cleanup();
  }
});

test("every finding discharged: allows the stop", () => {
  const { file, cleanup } = withBuffer([
    DONE("search lies", "https://example.invalid/issues/457"),
    DONE("board unconfirmable", "dropped - folded into #162"),
  ]);
  try {
    const r = runHook(file);
    assert.equal(r.status, 0);
    assert.equal(r.stderr.trim(), "");
  } finally {
    cleanup();
  }
});

// The reason this file exists.
test("an open finding BLOCKS the stop, and names it", () => {
  const { file, cleanup } = withBuffer([
    DONE("already filed", "https://example.invalid/1"),
    OPEN("in:title search returns silent false negatives"),
  ]);
  try {
    const r = runHook(file);
    assert.equal(r.status, 2, "an outstanding finding must block the stop");
    assert.match(r.stderr, /in:title search returns silent false negatives/);
    assert.match(r.stderr, /\[2\]/, "must address the entry by its file line number");
    assert.match(r.stderr, /discharge/, "must name the remedy");
  } finally {
    cleanup();
  }
});

test("blank lines do not count as findings, and do not shift numbering", () => {
  const { file, cleanup } = withBuffer(["", DONE("done", "url"), "", OPEN("still open")]);
  try {
    const r = runHook(file);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /\[4\]/, "line 4 is the open entry in the file");
  } finally {
    cleanup();
  }
});

test("a malformed line is surfaced, not silently dropped", () => {
  const { file, cleanup } = withBuffer(["{not json at all", DONE("fine", "url")]);
  try {
    const r = runHook(file);
    assert.equal(r.status, 2, "an unreadable entry is an uncaptured finding");
    assert.match(r.stderr, /malformed/);
  } finally {
    cleanup();
  }
});

test("recursion guard: stop_hook_active short-circuits even with open findings", () => {
  const { file, cleanup } = withBuffer([OPEN("open finding")]);
  try {
    const r = runHook(file, { stopHookActive: true });
    assert.equal(r.status, 0, "must not re-block while its own block is being handled");
  } finally {
    cleanup();
  }
});

test("broken check fails OPEN: no jq means no block", () => {
  const { file, cleanup } = withBuffer([OPEN("open finding")]);
  try {
    const r = runHook(file, { env: { JQ: "/nonexistent/jq" } });
    assert.equal(r.status, 0, "a gate that cannot read its evidence must not trap the session");
  } finally {
    cleanup();
  }
});

test("round trip: add blocks the stop, discharge releases it", () => {
  const { file, cleanup } = withBuffer([]);
  try {
    const added = runFindings(file, ["add", "the board projection is hourly, so placement is unconfirmable"]);
    assert.equal(added.status, 0, added.stderr);

    assert.equal(runHook(file).status, 2, "a freshly recorded finding must block");

    const d = runFindings(file, ["discharge", "1", "https://example.invalid/issues/162"]);
    assert.equal(d.status, 0, d.stderr);

    assert.equal(runHook(file).status, 0, "discharging the only finding must release the stop");

    const stored = JSON.parse(readFileSync(file, "utf8").trim());
    assert.equal(stored.discharged, "https://example.invalid/issues/162");
  } finally {
    cleanup();
  }
});

test("discharge with a reason is a first-class outcome", () => {
  const { file, cleanup } = withBuffer([OPEN("not worth keeping")]);
  try {
    const d = runFindings(file, ["discharge", "1", "dropped - duplicate of #456"]);
    assert.equal(d.status, 0, d.stderr);
    assert.equal(runHook(file).status, 0);
  } finally {
    cleanup();
  }
});

test("discharging a number that addresses nothing fails loudly", () => {
  const { file, cleanup } = withBuffer([OPEN("only entry")]);
  try {
    const d = runFindings(file, ["discharge", "9", "https://example.invalid/x"]);
    assert.notEqual(d.status, 0, "a no-op discharge must not report success");
    assert.equal(runHook(file).status, 2, "the finding is still open");
  } finally {
    cleanup();
  }
});

test("discharging an already-discharged entry fails rather than silently passing", () => {
  const { file, cleanup } = withBuffer([DONE("already done", "url")]);
  try {
    const d = runFindings(file, ["discharge", "1", "https://example.invalid/y"]);
    assert.notEqual(d.status, 0);
  } finally {
    cleanup();
  }
});

// Without this path a single stray keystroke in the buffer is a session that
// can never stop: the hook counts a malformed line as outstanding, so if it
// could not be discharged the gate would be a trap rather than a gate.
test("a malformed entry can be discharged, keeping its raw text as the note", () => {
  const { file, cleanup } = withBuffer(["{not json at all"]);
  try {
    assert.equal(runHook(file).status, 2, "precondition: malformed blocks");

    const d = runFindings(file, ["discharge", "1", "dropped - stray keystroke"]);
    assert.equal(d.status, 0, d.stderr);

    assert.equal(runHook(file).status, 0, "discharging the malformed entry must release the stop");

    const stored = JSON.parse(readFileSync(file, "utf8").trim());
    assert.equal(stored.note, "{not json at all", "the raw text must be preserved, not lost");
    assert.equal(stored.discharged, "dropped - stray keystroke");
  } finally {
    cleanup();
  }
});

test("discharge does not accumulate blank lines across passes", () => {
  const { file, cleanup } = withBuffer([OPEN("first"), OPEN("second")]);
  try {
    assert.equal(runFindings(file, ["discharge", "1", "url-1"]).status, 0);
    assert.equal(runFindings(file, ["discharge", "2", "url-2"]).status, 0);

    const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "");
    assert.equal(lines.length, 2, "the buffer must still hold exactly two entries");
    assert.equal(runHook(file).status, 0);
  } finally {
    cleanup();
  }
});

test("a note containing shell metacharacters survives the round trip intact", () => {
  const { file, cleanup } = withBuffer([]);
  const nasty = `'"; rm -rf /; echo "$(whoami)" \`id\` {"k":"v"}`;
  try {
    assert.equal(runFindings(file, ["add", nasty]).status, 0);
    const stored = JSON.parse(readFileSync(file, "utf8").trim());
    assert.equal(stored.note, nasty, "the buffer must store the note byte-for-byte");
    const r = runHook(file);
    assert.equal(r.status, 2);
  } finally {
    cleanup();
  }
});
