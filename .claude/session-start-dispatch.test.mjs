// Unit tests for the multi-repo SessionStart dispatcher.
//
// The behaviours worth pinning are the ones that made the nine-repo session of
// 2026-07-31 start degraded and silent: repos are found by their DECLARATION
// rather than a guessed filename, prose and JSON stdout are kept apart, and one
// bad hook cannot take the session down.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { extractContext, findRepos, mergeContexts, sessionRootFrom, sessionStartCommands } from "./session-start-dispatch.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(HERE, name), "utf8");

// ── The install snippet, which is documentation and therefore untested by ─────
// ── everything else in this file ──────────────────────────────────────────────
//
// The pointer in $HOME/.claude/settings.json is the one piece of this machinery
// outside version control: nobody reviews it, no drift gate sees it, and it is
// retyped from a snippet on every container boot. A wrong snippet is therefore a
// permanently wrong pointer, and it fails silently — node cannot find the file,
// the hook errors, and the session starts unprovisioned, presenting as a broken
// checkout. That is precisely the misreading this dispatcher exists to prevent.
//
// It shipped wrong once (#69 merged with `$HOME/.github/...` in the docstring
// while README.md had `/home/user/.github/...`), so it is pinned here.

const SNIPPET_PATH = "/home/user/.github/.claude/session-start-dispatch.mjs";
const DOCS = ["session-start-dispatch.mjs", "README.md"];

/**
 * Every `"command": "node …session-start-dispatch.mjs"` a doc actually tells the
 * reader to install.
 *
 * Scoped to the command line rather than grepping the whole file, because both
 * documents legitimately DISCUSS the wrong path in prose in order to warn about
 * it. A blanket ban cannot tell an instruction from a cautionary example, and
 * would make the warning unwritable.
 */
function installCommands(source) {
  // Allow leading `VAR=value ` assignments before `node`: the documented command
  // sets CLAUDE_SESSION_ROOT inline, which is load-bearing when the dispatcher was
  // fetched to a cache dir instead of read from an attached checkout (its
  // self-location resolves to `/` there). Matching only a bare `node …` would make
  // the correct command invisible to this gate rather than wrong.
  return [...source.matchAll(/"command":\s*"(?:\w+=\S+\s+)*node ([^"]*session-start-dispatch\.mjs)"/g)]
    .map((m) => resolveShellVars(m[1], source));
}

/**
 * Expand `$VAR` / `${VAR}` using the `VAR=value` assignments in the same document.
 *
 * The snippet is a shell script, so its path is assembled from variables rather
 * than written literally — asserting on the raw string would only pin the spelling.
 * Resolving first pins what the reader's shell actually produces, which is the
 * thing that has to equal the session root.
 *
 * FIRST assignment wins: the fallback branch reassigns BOOT to a cache directory,
 * and the install path being checked is the preferred one.
 */
function resolveShellVars(value, source) {
  const vars = {};
  for (const [, k, v] of source.matchAll(/^\s*(\w+)=["']?([^"'\s#]+)["']?\s*(?:#.*)?$/gm)) {
    if (!(k in vars)) vars[k] = v;
  }
  let out = value;
  for (let i = 0; i < 5 && /\$/.test(out); i++) {
    out = out.replace(/\$\{(\w+)\}|\$(\w+)/g, (m, a, b) => vars[a ?? b] ?? m);
  }
  return out;
}

test("every documented install command points at the session root, not $HOME", () => {
  // $HOME is /root — the session runs as root — while the repos are checked out
  // under /home/user. `$HOME/.claude` is right for the settings file and
  // `$HOME/.github` is wrong for the dispatcher, one line apart in the snippet.
  // Same variable, two different roles; that adjacency is what made the mistake
  // easy, and it shipped in #69.
  for (const name of DOCS) {
    const commands = installCommands(read(name));
    assert.ok(commands.length > 0, `${name} no longer carries an install command to check`);
    for (const cmd of commands) {
      assert.equal(cmd, SNIPPET_PATH, `${name} installs the dispatcher from ${cmd}`);
    }
  }
});

test("the docstring and the README do not drift apart", () => {
  // Two copies of one pointer, and the pointer lives outside version control —
  // so a stale copy is retyped into a real session on the next boot.
  const [fromCode, fromReadme] = DOCS.map((n) => installCommands(read(n)));
  assert.deepEqual(fromCode, fromReadme);
});

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

// ── Merging without paying for the same context twice ────────────────────────

test("the same org context from two repos is injected once", () => {
  // The live case, 2026-07-31: a session with BOTH .github and .github-private
  // attached ran 4 hooks and logged "2 injected context" — the identical 2289-byte
  // context.md, because .github's hook resolves the .github-private checkout next
  // door and .github-private's own hook reads the very same path.
  const org = "# bounded-systems — Claude context\n\nThe door is the unit of bounded authority.";
  const merged = mergeContexts([org, org]);
  assert.equal(merged.kept, 1);
  assert.equal(merged.dropped, 1);
  assert.equal(merged.text, org);
});

test("a trailing-newline difference is the same context, not a second one", () => {
  // `jq -n --arg c "$(cat f)"` strips the trailing newline; reading the file
  // directly keeps it. Comparing raw strings would let one byte double the cost.
  const merged = mergeContexts(["org context\n", "org context"]);
  assert.equal(merged.kept, 1);
  assert.equal(merged.text, "org context\n", "the first spelling is the one kept");
});

test("genuinely different contexts are all kept, in dispatch order", () => {
  // Dedup must not become "one repo may contribute context". Order is preserved
  // because it decides what the model reads first.
  const merged = mergeContexts(["alpha", "beta", "gamma"]);
  assert.equal(merged.kept, 3);
  assert.equal(merged.dropped, 0);
  assert.equal(merged.text, "alpha\n\n---\n\nbeta\n\n---\n\ngamma");
});

test("merging nothing yields nothing, so no empty envelope is written", () => {
  assert.deepEqual(mergeContexts([]), { text: "", kept: 0, dropped: 0 });
});
