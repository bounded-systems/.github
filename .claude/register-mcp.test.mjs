// Tests for user-scope MCP registration.
//
// Two properties carry the weight. First, the merge must not damage
// ~/.claude.json — it is Claude Code's own state file and holds far more than MCP
// config, so a bug here costs a user their session state, not just a tool.
// Second, paths must stop depending on cwd, since that dependence is the whole
// reason a project-scoped .mcp.json fails in a multi-repo session.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  absolutize,
  collectServers,
  findMcpRepos,
  mergeConfig,
  sessionRootFrom,
} from "./register-mcp.mjs";

const dirent = (name) => ({ name, isDirectory: () => true });

// ── Merging into Claude Code's own state file ────────────────────────────────

test("every unrelated key survives the merge", () => {
  const existing = {
    oauthAccount: { id: "x" },
    userID: "u1",
    projects: { "/a": { trust: true } },
    cachedExperimentData: [1, 2, 3],
  };
  const [next] = mergeConfig(existing, { "front-desk": { command: "node" } });
  assert.deepEqual(next.oauthAccount, existing.oauthAccount);
  assert.equal(next.userID, "u1");
  assert.deepEqual(next.projects, existing.projects);
  assert.deepEqual(next.cachedExperimentData, [1, 2, 3]);
});

test("a server we did not add is never removed", () => {
  const existing = { mcpServers: { other: { command: "other-bin" } } };
  const [next] = mergeConfig(existing, { "front-desk": { command: "node" } });
  assert.deepEqual(next.mcpServers.other, { command: "other-bin" });
  assert.ok(next.mcpServers["front-desk"]);
});

test("re-running with no change reports unchanged, so it stays a no-op", () => {
  const server = { command: "node", args: ["/abs/mcp.ts"] };
  const [, changed] = mergeConfig({ mcpServers: { "front-desk": server } }, { "front-desk": { ...server } });
  assert.equal(changed, false);
});

test("a changed server IS rewritten", () => {
  const [next, changed] = mergeConfig(
    { mcpServers: { "front-desk": { command: "node", args: ["/old/mcp.ts"] } } },
    { "front-desk": { command: "node", args: ["/new/mcp.ts"] } },
  );
  assert.equal(changed, true);
  assert.deepEqual(next.mcpServers["front-desk"].args, ["/new/mcp.ts"]);
});

test("an empty config gains mcpServers without inventing anything else", () => {
  const [next] = mergeConfig({}, { fd: { command: "node" } });
  assert.deepEqual(Object.keys(next), ["mcpServers"]);
});

// ── Making paths cwd-independent ─────────────────────────────────────────────

const repo = "/root/front-desk-scheduler";
const existsIn = (p) => p === `${repo}/scripts/mcp.ts` || p === `${repo}/bin/serve`;

test("a path arg becomes absolute; flags and literals do not", () => {
  const out = absolutize(
    { command: "deno", args: ["run", "--allow-net", "scripts/mcp.ts"] },
    repo,
    { exists: existsIn },
  );
  assert.deepEqual(out.args, ["run", "--allow-net", `${repo}/scripts/mcp.ts`]);
  // `run` and `--allow-net` are not files in the repo and must be left alone.
});

test("an interpreter on PATH stays a bare command", () => {
  const out = absolutize({ command: "node", args: ["scripts/mcp.ts"] }, repo, { exists: existsIn });
  assert.equal(out.command, "node");
  assert.equal(out.args[0], `${repo}/scripts/mcp.ts`);
});

test("a wrapper script IN the repo becomes absolute", () => {
  const out = absolutize({ command: "bin/serve" }, repo, { exists: existsIn });
  assert.equal(out.command, `${repo}/bin/serve`);
});

test("cwd defaults to the repo, and a declared cwd is respected", () => {
  assert.equal(absolutize({ command: "node" }, repo, { exists: existsIn }).cwd, repo);
  assert.equal(absolutize({ command: "node", cwd: "/elsewhere" }, repo, { exists: existsIn }).cwd, "/elsewhere");
});

test("an already-absolute arg is left alone", () => {
  const out = absolutize({ command: "node", args: ["/abs/mcp.ts"] }, repo, { exists: () => true });
  assert.deepEqual(out.args, ["/abs/mcp.ts"]);
});

test("env and other fields pass through untouched", () => {
  const out = absolutize({ command: "node", env: { FDS_READS: "dolthub" } }, repo, { exists: existsIn });
  assert.deepEqual(out.env, { FDS_READS: "dolthub" });
});

// ── Discovery ────────────────────────────────────────────────────────────────

test("only repos declaring .mcp.json are registered", () => {
  const fs = {
    readdir: () => ["front-desk-scheduler", "infra"].map(dirent),
    exists: (p) => p === "/root/front-desk-scheduler/.mcp.json",
  };
  assert.deepEqual(findMcpRepos("/root", fs), ["/root/front-desk-scheduler"]);
});

test("the session root's own .claude is not a repo", () => {
  const fs = { readdir: () => [".claude", "infra"].map(dirent), exists: () => true };
  assert.deepEqual(findMcpRepos("/root", fs), ["/root/infra"]);
});

test("the session root is this repo's parent, not the process home", () => {
  assert.equal(sessionRootFrom("file:///home/user/.github/.claude/register-mcp.mjs"), "/home/user");
});

// ── Collection ───────────────────────────────────────────────────────────────

test("a duplicate server name keeps the first and skips the rest", () => {
  // Otherwise which repo wins would depend on directory order.
  const read = () => JSON.stringify({ mcpServers: { dup: { command: "node", args: ["a.ts"] } } });
  const got = collectServers(["/root/one", "/root/two"], { read, exists: () => false });
  assert.deepEqual(Object.keys(got), ["dup"]);
  assert.equal(got.dup.cwd, "/root/one");
});

test("an unreadable .mcp.json is skipped, not fatal", () => {
  const read = (p) => (p.includes("bad") ? "{{{" : JSON.stringify({ mcpServers: { ok: { command: "node" } } }));
  const got = collectServers(["/root/bad", "/root/good"], { read, exists: () => false });
  assert.deepEqual(Object.keys(got), ["ok"]);
});

test("a .mcp.json with no mcpServers block yields nothing", () => {
  const got = collectServers(["/root/x"], { read: () => "{}", exists: () => false });
  assert.deepEqual(got, {});
});
