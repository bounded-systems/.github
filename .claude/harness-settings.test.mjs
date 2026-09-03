// What `$CLAUDE_CONFIG_DIR/settings.json` must survive (#343, fix 1).
//
// The bug this file pins is not a crash. boot.sh wrote that file with `cat >`
// carrying a `hooks` block and nothing else, so every bare boot erased whatever
// else lived there and left a file that parses perfectly — no error, no warning,
// nothing to notice. The tests below are therefore mostly PRESERVATION tests:
// each one puts something in the existing document that the org did not write and
// asserts it is still there afterwards.

import { test } from "node:test";
import assert from "node:assert/strict";

import { mergeAllow, mergeSessionStart, mergeSettings, parseAllow, readSettings } from "./harness-settings.mjs";

const CMD = "CLAUDE_SESSION_ROOT=/home/user node /opt/bounded-boot/session-start-dispatch.mjs";

test("an empty file is just the install", () => {
  const out = mergeSettings({}, { hookCommand: CMD });
  assert.deepEqual(out.hooks.SessionStart, [{ matcher: "", hooks: [{ type: "command", command: CMD }] }]);
});

test("everything the org did not write survives", () => {
  const existing = {
    env: { CLAUDE_CODE_ENABLE_TELEMETRY: "1" },
    model: "opus",
    permissions: { allow: ["Bash(bash .claude/org-repair.sh)"], deny: ["Bash(rm:*)"] },
    hooks: { Stop: [{ hooks: [{ type: "command", command: "bash mine.sh" }] }] },
  };
  const out = mergeSettings(existing, { hookCommand: CMD });
  assert.deepEqual(out.env, existing.env);
  assert.equal(out.model, "opus");
  assert.deepEqual(out.permissions, existing.permissions);
  assert.deepEqual(out.hooks.Stop, existing.hooks.Stop);
});

test("a user's own SessionStart hook is not displaced", () => {
  const existing = { hooks: { SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "bash mine.sh" }] }] } };
  const out = mergeSettings(existing, { hookCommand: CMD });
  assert.equal(out.hooks.SessionStart.length, 2, "the org entry should be added beside theirs, not instead of it");
  assert.equal(out.hooks.SessionStart[0].hooks[0].command, "bash mine.sh");
});

test("re-running is idempotent — no second copy of the dispatcher", () => {
  const once = mergeSettings({}, { hookCommand: CMD });
  const twice = mergeSettings(once, { hookCommand: CMD });
  assert.deepEqual(twice, once);
});

test("a stale dispatcher path is REWRITTEN, not appended", () => {
  // The case that makes "append if absent" wrong: a session that moved between the
  // attached checkout and the fetch cache has the other location in there, and two
  // entries would run the dispatcher twice from two roots.
  const stale = { hooks: { SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "node /old/session-start-dispatch.mjs" }] }] } };
  const out = mergeSettings(stale, { hookCommand: CMD });
  const commands = out.hooks.SessionStart.flatMap((g) => g.hooks.map((h) => h.command));
  assert.deepEqual(commands, [CMD]);
});

test("the dispatcher entry is rewritten in place, keeping its neighbours in order", () => {
  const existing = {
    hooks: {
      SessionStart: [
        {
          matcher: "",
          hooks: [
            { type: "command", command: "bash a.sh" },
            { type: "command", command: "node /old/session-start-dispatch.mjs" },
            { type: "command", command: "bash b.sh" },
          ],
        },
      ],
    },
  };
  const out = mergeSettings(existing, { hookCommand: CMD });
  assert.deepEqual(
    out.hooks.SessionStart[0].hooks.map((h) => h.command),
    ["bash a.sh", CMD, "bash b.sh"],
  );
});

test("duplicate dispatcher entries collapse to one", () => {
  const doubled = {
    hooks: {
      SessionStart: [
        { matcher: "", hooks: [{ type: "command", command: "node /a/session-start-dispatch.mjs" }] },
        { matcher: "", hooks: [{ type: "command", command: "node /b/session-start-dispatch.mjs" }] },
      ],
    },
  };
  const out = mergeSessionStart(doubled.hooks, CMD);
  const commands = out.SessionStart.flatMap((g) => g.hooks.map((h) => h.command));
  assert.deepEqual(commands, [CMD]);
  assert.ok(
    !out.SessionStart.some((g) => Array.isArray(g.hooks) && g.hooks.length === 0),
    "collapsing left an empty matcher group behind",
  );
});

test("allow rules union without duplicating, and preserve order", () => {
  const out = mergeAllow({ allow: ["Bash(a)"] }, ["Bash(a)", "Bash(b)"]);
  assert.deepEqual(out.allow, ["Bash(a)", "Bash(b)"]);
});

test("a rule the user has DENIED is not re-granted", () => {
  // Claude Code resolves deny over allow, so adding it would change no behaviour —
  // but it would write the org's wish into the file next to the user's refusal of
  // it, and a settings file that contradicts itself is one nobody re-reads.
  const out = mergeAllow({ deny: ["Bash(b)"] }, ["Bash(b)"]);
  assert.ok(!(out.allow ?? []).includes("Bash(b)"));
});

test("no allow rules means permissions is not touched at all", () => {
  const existing = { permissions: { allow: ["Bash(a)"] } };
  const out = mergeSettings(existing, { hookCommand: CMD, allow: [] });
  assert.equal(out.permissions, existing.permissions, "an empty grant list rewrote the permissions object");
});

test("an unreadable settings file THROWS rather than being replaced", () => {
  // The whole point. boot.sh writes nothing when this throws, which leaves the
  // unreadable file exactly as it was — recoverable. A clobber is not.
  assert.throws(
    () => readSettings("/x/settings.json", { exists: () => true, read: () => "{ not json" }),
    /refusing to overwrite/,
  );
  assert.throws(
    () => readSettings("/x/settings.json", { exists: () => true, read: () => "[]" }),
    /refusing to overwrite/,
  );
});

test("absent or empty reads as {} — there is nothing to preserve", () => {
  assert.deepEqual(readSettings("/x/settings.json", { exists: () => false, read: () => "" }), {});
  assert.deepEqual(readSettings("/x/settings.json", { exists: () => true, read: () => "  \n" }), {});
});

test("BOOT_ALLOW is newline-separated, so a rule may contain spaces and commas", () => {
  assert.deepEqual(parseAllow("Bash(curl a b)\n\n  Bash(x,y)  \n"), ["Bash(curl a b)", "Bash(x,y)"]);
  assert.deepEqual(parseAllow(undefined), []);
});
