// Unit tests for the multi-repo SessionStart dispatcher.
//
// The behaviours worth pinning are the ones that made the nine-repo session of
// 2026-07-31 start degraded and silent: repos are found by their DECLARATION
// rather than a guessed filename, prose and JSON stdout are kept apart, and one
// bad hook cannot take the session down.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MANIFEST,
  applyEntry,
  applyManifest,
  childEnv,
  extractContext,
  findRepos,
  mcpDriftContext,
  mergeContexts,
  needsRepair,
  sessionRootFrom,
  sessionStartCommands,
  stopHookAction,
  syncStopHook,
  toolpathContext,
  toolpathOutcome,
} from "./session-start-dispatch.mjs";

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
// boot.sh, not README.md: the canonical install snippet moved into the fetched
// stage-1 bootstrap (#125); README now carries only the one-line field text.
const DOCS = ["session-start-dispatch.mjs", "boot.sh"];

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
  // A probe chain — `[ -d … ] || VAR=value`, repeated — resolves in file order,
  // and its LAST fallback is what a shell produces in the no-env historical
  // layout (`${CLAUDE_SESSION_ROOT:-}` of an unset variable is empty, and the
  // earlier $PWD probes equal the last resort in that layout anyway). The pin
  // below describes exactly that layout, so the last fallback overrides the
  // chain's empty primary.
  for (const [, k, v] of source.matchAll(/\]\s*\|\|\s*(\w+)=["']?([^"'\s#]+)["']?/g)) {
    vars[k] = v;
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

test("the docstring and boot.sh do not drift apart", () => {
  // Two copies of one pointer — and boot.sh's copy is what a session without
  // `.github` attached actually executes, so a stale one runs for real.
  const [fromCode, fromBoot] = DOCS.map((n) => installCommands(read(n)));
  assert.deepEqual(fromCode, fromBoot);
});

// ── Locating the session root ────────────────────────────────────────────────

test("the session root is this repo's PARENT, not the process home directory", () => {
  // Regression: the first version used homedir(). The session runs as root, so
  // that resolved to /root while the repos live in /home/user — the dispatcher
  // found nothing and exited 0 with "nothing to do".
  assert.equal(sessionRootFrom("file:///home/user/.github/.claude/session-start-dispatch.mjs"), "/home/user");
  assert.equal(sessionRootFrom("file:///srv/work/org-defaults/.claude/session-start-dispatch.mjs"), "/srv/work");
});

test("child hooks receive CLAUDE_SESSION_ROOT and a per-repo CLAUDE_PROJECT_DIR", () => {
  // The contract .github-private's check-session-scope.sh gates on (2026-08-08):
  // the variable must reach children even when the invoking command did not set
  // it inline — cloud front-desk sessions rely on self-location, and the floor
  // proved that gating a child hook on a platform variable instead leaves it
  // silently dead. Dropping either substitution here would be equally silent,
  // which is why the seam is pinned rather than trusted.
  const env = childEnv("/root/infra", { base: { PATH: "/bin" }, sessionRoot: "/root" });
  assert.equal(env.CLAUDE_SESSION_ROOT, "/root");
  assert.equal(env.CLAUDE_PROJECT_DIR, "/root/infra");
  assert.equal(env.PATH, "/bin"); // the parent environment still rides along
});

test("a stale inherited CLAUDE_SESSION_ROOT is overwritten, not passed through", () => {
  // Being wrong about the session root is precisely the state the dispatcher
  // corrects (see IRREDUCIBLE) — a child must never see a value the dispatcher
  // itself has rejected.
  const env = childEnv("/root/infra", { base: { CLAUDE_SESSION_ROOT: "/" }, sessionRoot: "/root" });
  assert.equal(env.CLAUDE_SESSION_ROOT, "/root");
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

// ── The MCP capability warning ───────────────────────────────────────────────
//
// Observed 2026-08-01: the environment setup script had stopped calling
// `register-mcp.mjs`. `~/.claude.json` read `mcpServers: null`, so a session that
// had read front-desk-scheduler's CLAUDE.md — whose opening paragraph says to ask
// the `next` tool and NOT to hand-rank issues from the GitHub API — found no such
// tool and hand-ranked issues from the GitHub API. Nothing said the tool was
// absent, and the answer was indistinguishable from one Front Desk had produced.
//
// The dispatcher now registers the missing server itself, so that case leaves no
// trace in context. These tests hold the residue: when registration does NOT take,
// the session is told, and told what to do instead of improvising.

test("nothing missing emits no context, so a healthy session pays nothing", () => {
  // The org context file's own header says it counts against the window every
  // session. A block that fires when nothing is wrong teaches the reader to skim.
  assert.equal(mcpDriftContext([]), null);
  assert.equal(mcpDriftContext(undefined), null);
});

test("a missing server is named, so the reader knows which tools are absent", () => {
  const ctx = mcpDriftContext(["front-desk"]);
  assert.match(ctx, /front-desk/);
  assert.match(ctx, /NOT registered/);
});

test("the warning says what to do instead, not merely that a tool is gone", () => {
  // This is the whole point. "The tool is missing" on its own is an invitation to
  // reconstruct the answer by hand, which is the failure that prompted the file.
  const ctx = mcpDriftContext(["front-desk"]);
  assert.match(ctx, /Do not substitute your own reasoning/);
  assert.match(ctx, /CLI/);
  assert.match(ctx, /say the tool was unavailable/);
});

test("the warning names no repo, so adding one needs no edit here", () => {
  // Which CLI stands in for which server is the declaring repo's knowledge. The
  // dispatcher's contract is that it holds none.
  const ctx = mcpDriftContext(["some-server"]);
  assert.doesNotMatch(ctx, /front-desk-scheduler|fds\.ts|infra|dolt/);
});

test("the warning is a context block, not an envelope", () => {
  // It is merged with the hooks' contexts and wrapped once by main(). Returning a
  // hookSpecificOutput envelope here would nest two of them.
  const ctx = mcpDriftContext(["front-desk"]);
  assert.doesNotMatch(ctx, /hookSpecificOutput/);
  assert.equal(extractContext(ctx), null);
});

test("the warning survives the merge and comes first", () => {
  // It is a statement about what this session CAN do, and it is worth nothing if
  // the model reads it after the instructions telling it to use the missing tool.
  const drift = mcpDriftContext(["front-desk"]);
  const merged = mergeContexts([drift, "org context"]);
  assert.equal(merged.kept, 2);
  assert.ok(merged.text.startsWith(drift));
});

// ── Replacing the platform's Stop hook (infra#112) ───────────────────────────
//
// The second of the setup script's four steps to move in here (#85). Its absence
// is quieter than the MCP one: the stock hook scopes its check to
// `origin/<branch>..HEAD`, so after a squash merge it includes GitHub's own merge
// commit and warns "Unverified" on every successful merge, advising an `--amend`
// that would rewrite already-merged history. Confirmed live on 2026-08-01 — the
// installed hook was 3262 bytes against this repo's 5458, i.e. the stock one.

test("bytes decide, not presence — an identical hook is left alone", () => {
  const same = Buffer.from("#!/bin/bash\necho fixed\n");
  assert.equal(stopHookAction(same, Buffer.from(same)), "current");
});

test("a differing hook is replaced, and a missing one installed", () => {
  assert.equal(stopHookAction(Buffer.from("new"), Buffer.from("stock")), "copy");
  assert.equal(stopHookAction(Buffer.from("new"), null), "copy");
});

test("no source means leave the platform's hook alone, not install nothing", () => {
  // A refused digest leaves the dispatcher fetched and this file not. Overwriting
  // with an empty file would be strictly worse than the stock hook.
  assert.equal(stopHookAction(null, Buffer.from("stock")), "absent");
  assert.equal(stopHookAction(null, null), "absent");
});

/** A source dir holding the hook, and a target dir standing in for `$HOME/.claude`. */
function hookFixture(installed) {
  const dir = mkdtempSync(join(tmpdir(), "stop-hook-"));
  const sourceDir = join(dir, "src");
  const targetDir = join(dir, "home", ".claude");
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(sourceDir, "stop-hook-git-check.sh"), "#!/bin/bash\n# infra#112 fix\n");
  if (installed !== undefined) {
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, "stop-hook-git-check.sh"), installed);
  }
  return { dir, sourceDir, targetDir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("the observed failure self-heals: the stock hook is replaced", () => {
  const fx = hookFixture("#!/bin/bash\n# the stock one\n");
  assert.equal(syncStopHook({ sourceDir: fx.sourceDir, targetDir: fx.targetDir }), "copy");
  assert.equal(
    readFileSync(join(fx.targetDir, "stop-hook-git-check.sh"), "utf8"),
    "#!/bin/bash\n# infra#112 fix\n",
  );
  fx.cleanup();
});

test("the installed hook is executable — a copied-but-unrunnable hook is silently no hook", () => {
  const fx = hookFixture("stale");
  syncStopHook({ sourceDir: fx.sourceDir, targetDir: fx.targetDir });
  assert.ok(statSync(join(fx.targetDir, "stop-hook-git-check.sh")).mode & 0o111);
  fx.cleanup();
});

test("a target directory that does not exist yet is created", () => {
  const fx = hookFixture(undefined); // no targetDir at all
  assert.equal(syncStopHook({ sourceDir: fx.sourceDir, targetDir: fx.targetDir }), "copy");
  assert.ok(existsSync(join(fx.targetDir, "stop-hook-git-check.sh")));
  fx.cleanup();
});

test("re-running is a no-op — it does not rewrite an already-correct hook", () => {
  const fx = hookFixture(undefined);
  syncStopHook({ sourceDir: fx.sourceDir, targetDir: fx.targetDir });
  assert.equal(syncStopHook({ sourceDir: fx.sourceDir, targetDir: fx.targetDir }), "current");
  fx.cleanup();
});

test("a missing source never throws and never truncates what is installed", () => {
  const fx = hookFixture("#!/bin/bash\n# the stock one\n");
  rmSync(join(fx.sourceDir, "stop-hook-git-check.sh"));
  assert.equal(syncStopHook({ sourceDir: fx.sourceDir, targetDir: fx.targetDir }), "absent");
  assert.equal(
    readFileSync(join(fx.targetDir, "stop-hook-git-check.sh"), "utf8"),
    "#!/bin/bash\n# the stock one\n",
    "the platform's hook is left intact rather than replaced with nothing",
  );
  fx.cleanup();
});

// ── The manifest loop (#91) ──────────────────────────────────────────────────
//
// The two repairs above are now entries driven by one loop, so the loop is
// load-bearing for both. What is worth pinning is the shape of its decisions:
// a healthy artifact is not written to, an unrepairable one is not attempted,
// and no entry can take the session down with it.
//
// Fake entries rather than the real MANIFEST: these must keep testing the loop
// the day an entry changes its mind about what "healthy" means, and must not
// start passing because the live manifest happens to be quiet.

/** An entry that records what the loop asked it to do. */
function spy({ compare, repair = () => ({ ok: true, state: "repaired" }), context = null }) {
  const calls = [];
  return {
    artifact: "thing.sh",
    what: "the thing",
    calls,
    compare: (ctx) => (calls.push("compare"), typeof compare === "function" ? compare(ctx) : compare),
    repair: (ctx) => (calls.push("repair"), typeof repair === "function" ? repair(ctx) : repair),
    context,
  };
}

test("a healthy artifact is never written to", async () => {
  // The property that makes it safe to run this on every session start: the
  // dispatcher touches nothing it did not find wrong.
  const e = spy({ compare: { ok: true, state: "current" } });
  const got = await applyEntry(e);
  assert.deepEqual(e.calls, ["compare"], "a healthy entry was repaired anyway");
  assert.equal(got.state, "current");
});

test("a drifted artifact is repaired", async () => {
  const e = spy({ compare: { ok: false, state: "drifted" } });
  const got = await applyEntry(e);
  assert.deepEqual(e.calls, ["compare", "repair"]);
  assert.equal(got.ok, true);
});

test("an unrepairable artifact is reported, not attempted", () => {
  // The Stop hook's "absent" case: a refused digest leaves nothing to install
  // from, and guessing would overwrite the platform's hook with nothing. Stated
  // on the shared predicate so the loop and syncStopHook cannot disagree.
  assert.equal(needsRepair({ ok: false, repairable: false, state: "absent" }), false);
  assert.equal(needsRepair({ ok: false, state: "drifted" }), true);
  assert.equal(needsRepair({ ok: true, state: "current" }), false);
});

test("an unrepairable entry really does skip the repairer", async () => {
  const e = spy({ compare: { ok: false, repairable: false, state: "absent" } });
  await applyEntry(e);
  assert.deepEqual(e.calls, ["compare"]);
});

test("an entry that throws degrades to 'could not check' rather than killing the session", async () => {
  // Same contract the child hooks get. "Could not check" is also a different
  // claim from "nothing is missing", which is why it does not report healthy.
  const e = spy({ compare: () => { throw new Error("boom"); } });
  const got = await applyEntry(e);
  assert.equal(got.ok, false);
  assert.equal(got.state, "unknown");
});

test("a repair that throws is caught too", async () => {
  const e = spy({ compare: { ok: false, state: "drifted" }, repair: () => { throw new Error("nope"); } });
  const got = await applyEntry(e);
  assert.equal(got.state, "unknown");
});

test("only entries that could NOT be repaired contribute session context", async () => {
  // The generalisation of mcpDriftContext (I5). A repaired artifact leaves no
  // trace in the window — the org context file's own header says every byte
  // counts — and a block that fires when nothing is wrong teaches skimming.
  const healed = spy({ compare: { ok: false, state: "drifted" }, context: () => "SHOULD NOT APPEAR" });
  const stuck = spy({ compare: { ok: false, repairable: false, state: "absent" }, context: () => "STILL BROKEN" });
  const { contexts } = await applyManifest([healed, stuck]);
  assert.deepEqual(contexts, ["STILL BROKEN"]);
});

test("an entry with no context block reports on stderr only", async () => {
  // The Stop hook's deliberate choice: it degrades git advice, not the model's
  // willingness to invent an answer, so it does not spend context on itself.
  const stuck = spy({ compare: { ok: false, repairable: false, state: "absent" }, context: null });
  const { contexts } = await applyManifest([stuck]);
  assert.deepEqual(contexts, []);
});

test("the missing list reaches the entry's wording, so the block can name names", async () => {
  const stuck = spy({
    compare: { ok: false, state: "unrepaired", missing: ["front-desk"] },
    repair: { ok: false, state: "unrepaired", missing: ["front-desk"] },
    context: (missing) => `missing: ${missing.join(", ")}`,
  });
  const { contexts } = await applyManifest([stuck]);
  assert.deepEqual(contexts, ["missing: front-desk"]);
});

test("entries run in manifest order, so context order is reproducible", async () => {
  const order = [];
  const mk = (name) => ({
    artifact: name,
    what: name,
    compare: () => (order.push(name), { ok: false, repairable: false, state: "absent" }),
    repair: () => ({ ok: false, state: "absent" }),
    context: () => name,
  });
  const { contexts } = await applyManifest([mk("first"), mk("second")]);
  assert.deepEqual(order, ["first", "second"]);
  assert.deepEqual(contexts, ["first", "second"]);
});

test("this repo's own hook is what would be installed, byte for byte", () => {
  // Guards the wiring, not the logic: if the file were renamed or moved, every
  // test above would still pass against its fixture while the real sync found
  // nothing. That is precisely how the setup script's copy failed.
  assert.equal(stopHookAction(readFileSync(join(HERE, "stop-hook-git-check.sh")), null), "copy");
});

// ── Toolpath: provenance sharing, and SAYING when it is unavailable (#522) ────
//
// The measured failure these cover: a cloud session with no `setup-toolpath.sh`
// on disk, no install log and no `path` — while cargo was present and
// index.crates.io answered 200, so both of the hook's own guards would have
// passed. Nothing reported it, because the thing that would report it is the
// script that is missing.

const TOOLPATH = MANIFEST.find((e) => e.artifact === "setup-toolpath.sh");
const never = async () => ({ ok: false, stdout: "" });

test("the toolpath entry is in the manifest, so it runs at every session start", () => {
  assert.ok(TOOLPATH, "no setup-toolpath.sh entry — the #522 signal would never fire");
});

test("an installed path is healthy, and costs no further probing", async () => {
  const seen = [];
  const probeFn = async (cmd) => (seen.push(cmd), { ok: cmd.includes("command -v path"), stdout: "" });
  const r = await TOOLPATH.compare({ sourceDir: HERE, probeFn });
  assert.equal(r.ok, true);
  assert.equal(r.state, "installed");
  assert.deepEqual(seen, ["command -v path"], "kept probing after already finding `path`");
});

test("a compile still running is healthy — not a missing tool", async () => {
  // The multi-minute build is the normal case, not a fault. Reporting it as
  // missing would train the reader to ignore the warning that matters.
  const probeFn = async (cmd) => ({ ok: cmd.startsWith("pgrep"), stdout: "" });
  const r = await TOOLPATH.compare({ sourceDir: HERE, probeFn });
  assert.equal(r.ok, true);
  assert.equal(r.state, "installing");
});

test("THE #522 CASE: no script beside the dispatcher is reported, and NOT retried", async () => {
  const r = await TOOLPATH.compare({ sourceDir: HERE, probeFn: never, exists: () => false });
  assert.equal(r.ok, false);
  assert.equal(r.state, "absent");
  assert.equal(r.repairable, false, "a script nothing fetched cannot be repaired by retrying it");
  assert.match(r.missing[0], /boot\.sh/, "the reason must name the fetch set that omits the script");
});

test("a script that IS present is repairable, not reported as absent", async () => {
  const r = await TOOLPATH.compare({ sourceDir: HERE, probeFn: never, exists: () => true });
  assert.equal(r.ok, false);
  assert.equal(r.state, "not-installed");
  assert.notEqual(r.repairable, false);
});

test("the installer's own words decide the outcome, not a second copy of its guards", () => {
  assert.deepEqual(toolpathOutcome("toolpath: installing path-cli in the background — log: /x"), {
    ok: true,
    state: "installing",
  });
  assert.equal(toolpathOutcome("toolpath: install already running — log: /x").ok, true);
  assert.equal(toolpathOutcome("toolpath: path 0.16.1 — auth: none").state, "installed");
  assert.equal(toolpathOutcome("toolpath: no cargo in this image — skipping install").state, "no-cargo");
  assert.equal(toolpathOutcome("toolpath: crates.io egress blocked — not installing.").state, "egress-blocked");
  assert.equal(toolpathOutcome("").state, "unknown");
});

test("every unavailable outcome carries a reason a session can actually read", () => {
  // "Unavailable" with no why is the state #522 was already in.
  for (const out of ["toolpath: no cargo in this image", "toolpath: crates.io egress blocked", ""]) {
    const seen = toolpathOutcome(out);
    assert.equal(seen.ok, false);
    assert.ok(seen.why?.length > 20, `no usable reason for ${JSON.stringify(out)}`);
  }
});

test("repair reports blocked egress as unavailable-with-a-reason, not as a retryable failure", async () => {
  const probeFn = async () => ({ ok: true, stdout: "toolpath: crates.io egress blocked — not installing." });
  const r = await TOOLPATH.repair({ sourceDir: HERE, probeFn });
  assert.equal(r.ok, false);
  assert.equal(r.state, "egress-blocked");
  assert.match(r.missing[0], /allowlist/);
});

test("repair treats a backgrounded compile as success — session start never waits on it", async () => {
  const probeFn = async () => ({ ok: true, stdout: "toolpath: installing path-cli in the background — log: /x" });
  const r = await TOOLPATH.repair({ sourceDir: HERE, probeFn });
  assert.equal(r.ok, true);
});

test("a healthy session pays nothing for the warning", () => {
  assert.equal(toolpathContext([]), null);
  assert.equal(toolpathContext(undefined), null);
});

test("the warning names the reason, and forbids inventing a share URL", () => {
  const ctx = toolpathContext(["crates.io egress is blocked"]);
  assert.match(ctx, /crates\.io egress is blocked/);
  assert.match(ctx, /do not invent a Pathbase URL/i);
  assert.ok(!ctx.includes("hookSpecificOutput"), "the warning is a context block, not an envelope");
});

test("an absent script surfaces as an injected context block, end to end", async () => {
  const { contexts } = await applyManifest([TOOLPATH], { sourceDir: HERE, probeFn: never, exists: () => false });
  assert.equal(contexts.length, 1);
  assert.match(contexts[0], /provenance sharing/i);
  assert.match(contexts[0], /boot\.sh/);
});
