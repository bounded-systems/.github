// Unit tests for the multi-repo SessionStart dispatcher.
//
// The behaviours worth pinning are the ones that made the nine-repo session of
// 2026-07-31 start degraded and silent: repos are found by their DECLARATION
// rather than a guessed filename, prose and JSON stdout are kept apart, and one
// bad hook cannot take the session down.

import { test } from "node:test";
import assert from "node:assert/strict";

import { extractContext, findRepos, sessionRootFrom, sessionStartCommands } from "./session-start-dispatch.mjs";

// ── Locating the session root ────────────────────────────────────────────────

test("the session root is this repo's PARENT, not the process home directory", () => {
  // Regression: the first version used homedir(). The session runs as root, so
  // that resolved to /root while the repos live in /home/user — the dispatcher
  // found nothing and exited 0 with "nothing to do".
  assert.equal(sessionRootFrom("file:///home/user/.github/.claude/session-start-dispatch.mjs"), "/home/user");
  assert.equal(sessionRootFrom("file:///srv/work/org-defaults/.claude/session-start-dispatch.mjs"), "/srv/work");
});

// ── Which repos get dispatched to ────────────────────────────────────────────

const dirent = (name) => ({ name, isDirectory: () => true });
const fakeFs = (names, withSettings) => ({
  readdir: () => names.map(dirent),
  exists: (p) => withSettings.some((n) => p === `/root/${n}/.claude/settings.json`),
});

test("only repos declaring hooks are dispatched to", () => {
  const fs = fakeFs(["infra", "site", "mint"], ["infra"]);
  assert.deepEqual(findRepos("/root", fs), ["/root/infra"]);
});

test("the session root's own .claude is never treated as a repo (no recursion)", () => {
  const fs = fakeFs([".claude", "infra"], [".claude", "infra"]);
  assert.deepEqual(findRepos("/root", fs), ["/root/infra"]);
});

test("node_modules is not a repo", () => {
  const fs = fakeFs(["node_modules", "infra"], ["node_modules", "infra"]);
  assert.deepEqual(findRepos("/root", fs), ["/root/infra"]);
});

test("dispatch order is stable, so session start is reproducible", () => {
  const names = ["site", "infra", "cas"];
  const fs = fakeFs(names, names);
  assert.deepEqual(findRepos("/root", fs), ["/root/cas", "/root/infra", "/root/site"]);
});

test("an unreadable root is empty, not a crash", () => {
  assert.deepEqual(findRepos("/nope", { readdir: () => { throw new Error("ENOENT"); }, exists: () => true }), []);
});

// ── Reading the declaration rather than guessing a path ──────────────────────

test("the two hook shapes live in this org today both parse", () => {
  // front-desk-scheduler / infra: absolute, via $CLAUDE_PROJECT_DIR
  const viaProjectDir = {
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: "$CLAUDE_PROJECT_DIR/.claude/hooks/session-start.sh" }] }] },
  };
  // .github: RELATIVE — only resolves with cwd set to the repo
  const relative = {
    hooks: { SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "bash .claude/inject-org-context.sh" }] }] },
  };
  assert.deepEqual(sessionStartCommands(viaProjectDir), ["$CLAUDE_PROJECT_DIR/.claude/hooks/session-start.sh"]);
  assert.deepEqual(sessionStartCommands(relative), ["bash .claude/inject-org-context.sh"]);
});

test("multiple groups and multiple hooks per group are all collected", () => {
  const settings = {
    hooks: {
      SessionStart: [
        { hooks: [{ type: "command", command: "a" }, { type: "command", command: "b" }] },
        { hooks: [{ type: "command", command: "c" }] },
      ],
    },
  };
  assert.deepEqual(sessionStartCommands(settings), ["a", "b", "c"]);
});

test("non-command hooks and malformed settings yield nothing, not a throw", () => {
  assert.deepEqual(sessionStartCommands({ hooks: { SessionStart: [{ hooks: [{ type: "prompt" }] }] } }), []);
  assert.deepEqual(sessionStartCommands({ hooks: { SessionStart: "nope" } }), []);
  assert.deepEqual(sessionStartCommands({}), []);
  assert.deepEqual(sessionStartCommands(null), []);
});

// ── Keeping prose out of the context envelope ────────────────────────────────

test("a valid envelope is extracted", () => {
  const out = JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "org context here" },
  });
  assert.equal(extractContext(out), "org context here");
});

test("hook progress prose is NOT context", () => {
  // Every line front-desk-scheduler's hook prints on a normal run.
  assert.equal(extractContext("session-start: installing deno ..."), null);
  assert.equal(extractContext("session-start: ready — dolt, deno, lean"), null);
  assert.equal(extractContext(""), null);
  assert.equal(extractContext(undefined), null);
});

test("malformed or foreign JSON is not context", () => {
  assert.equal(extractContext('{"hookSpecificOutput":'), null);
  assert.equal(extractContext(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "x" } })), null);
  assert.equal(extractContext(JSON.stringify({ some: "other" })), null);
});

test("an empty additionalContext is dropped rather than merged as a blank section", () => {
  const blank = JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "   " } });
  assert.equal(extractContext(blank), null);
});
