#!/usr/bin/env node
/**
 * Register every attached repo's `.mcp.json` servers at USER scope.
 *
 * ── Why ──────────────────────────────────────────────────────────────────────
 * `.mcp.json` is PROJECT-scoped. It is discovered from the project directory —
 * the same mechanism `.claude/settings.json` uses, and so it fails in exactly the
 * same way in a multi-repo session: the session root is not a repo, and a
 * `.mcp.json` sitting in a subdirectory is never found.
 *
 * `session-start-dispatch.mjs` fixes that for hooks. It cannot fix it for MCP:
 * servers are resolved when Claude Code launches, before any SessionStart hook
 * runs, and from a different config surface.
 *
 * Two further reasons user scope is the right target rather than a workaround:
 *
 *   1. Project `.mcp.json` servers require an approval prompt before first use.
 *      That prompt currently fails with `-32003` (bounded-systems/.github#65),
 *      observed four times on 2026-07-31 — so even a DISCOVERED project server
 *      may be unusable. User-scope servers carry no such prompt.
 *   2. A project `.mcp.json` records a RELATIVE command (`node scripts/mcp.ts`),
 *      which only resolves with cwd set to that repo. At user scope the path has
 *      to be absolute, which is also what makes it work from any cwd.
 *
 * Observed 2026-07-31: a session that had read front-desk-scheduler's CLAUDE.md —
 * which says "the verbs are registered as MCP tools, so ask the `next` tool" —
 * shelled out to `node scripts/fds.ts next` instead. `~/.claude.json` had
 * `mcpServers: {}` and `projects: {}`: nothing had been registered or discovered.
 * The instruction was correct and the tool was not there.
 *
 * ── What it does NOT do ──────────────────────────────────────────────────────
 * No per-repo knowledge. It reads whatever `.mcp.json` each repo declares and
 * rewrites only what has to become absolute. A repo changes its own server by
 * editing its own `.mcp.json`.
 *
 * ── Safety ───────────────────────────────────────────────────────────────────
 * `~/.claude.json` is Claude Code's own state file and holds far more than MCP
 * config. This MERGES: it reads, sets `mcpServers[<name>]`, and writes back with
 * every other key preserved, via a temp file and rename so an interrupted write
 * cannot truncate it. It never removes a server it did not add, and re-running is
 * a no-op when nothing changed.
 */

import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repos live beside this repo; resolved from our own path, never from cwd. */
export function sessionRootFrom(fileUrl) {
  return resolve(dirname(fileURLToPath(fileUrl)), "..", "..");
}

const SESSION_ROOT = process.env.CLAUDE_SESSION_ROOT || sessionRootFrom(import.meta.url);
const CONFIG_PATH = process.env.CLAUDE_CONFIG_PATH || join(homedir(), ".claude.json");

const log = (msg) => process.stderr.write(`register-mcp: ${msg}\n`);

/** Immediate subdirectories of the session root that declare MCP servers. */
export function findMcpRepos(root, { readdir = readdirSync, exists = existsSync } = {}) {
  let entries;
  try {
    entries = readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && e.name !== ".claude" && e.name !== "node_modules")
    .map((e) => join(root, e.name))
    .filter((dir) => exists(join(dir, ".mcp.json")))
    .sort();
}

/**
 * Rewrite one server entry so it works with no cwd assumption.
 *
 * Only path-shaped args are made absolute — an arg is a path if it names a file
 * that exists inside the repo. Flags and literal values are left alone, so a
 * server declaring `["run", "--allow-net", "scripts/mcp.ts"]` keeps its flags and
 * gets one absolute path.
 */
export function absolutize(server, repoDir, { exists = existsSync } = {}) {
  const out = { ...server };
  if (Array.isArray(server.args)) {
    out.args = server.args.map((a) =>
      typeof a === "string" && !isAbsolute(a) && exists(join(repoDir, a)) ? join(repoDir, a) : a,
    );
  }
  // A command that names a file in the repo (a wrapper script) becomes absolute;
  // a bare interpreter on PATH (`node`, `deno`, `npx`) is left as-is.
  if (typeof server.command === "string" && !isAbsolute(server.command) && exists(join(repoDir, server.command))) {
    out.command = join(repoDir, server.command);
  }
  // cwd makes any residual relative path in the server's own code resolve.
  out.cwd = server.cwd ?? repoDir;
  return out;
}

/** Collect every declared server, keyed by name, already absolutized. */
export function collectServers(repoDirs, { read = (p) => readFileSync(p, "utf8"), exists = existsSync } = {}) {
  const servers = {};
  for (const repoDir of repoDirs) {
    let declared;
    try {
      declared = JSON.parse(read(join(repoDir, ".mcp.json")))?.mcpServers;
    } catch (e) {
      log(`WARN ${repoDir}: unreadable .mcp.json — ${e.message}`);
      continue;
    }
    if (!declared || typeof declared !== "object") continue;
    for (const [name, server] of Object.entries(declared)) {
      if (!server || typeof server !== "object") continue;
      if (servers[name]) {
        // Two repos claiming one name would make which-one-wins depend on
        // directory order. Say so rather than silently picking.
        log(`WARN duplicate MCP server name '${name}' — keeping the first, skipping ${repoDir}`);
        continue;
      }
      servers[name] = absolutize(server, repoDir, { exists });
    }
  }
  return servers;
}

/** Merge into the existing config, preserving everything else. Returns [next, changed]. */
export function mergeConfig(existing, servers) {
  const next = { ...existing, mcpServers: { ...(existing.mcpServers ?? {}) } };
  let changed = false;
  for (const [name, server] of Object.entries(servers)) {
    if (JSON.stringify(next.mcpServers[name]) !== JSON.stringify(server)) {
      next.mcpServers[name] = server;
      changed = true;
    }
  }
  return [next, changed];
}

function main() {
  const repos = findMcpRepos(SESSION_ROOT);
  if (repos.length === 0) {
    log(`no attached repo under ${SESSION_ROOT} declares .mcp.json — nothing to register.`);
    return;
  }

  const servers = collectServers(repos);
  const names = Object.keys(servers);
  if (names.length === 0) {
    log("found .mcp.json but no usable server entries.");
    return;
  }

  let existing = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      existing = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    } catch (e) {
      // Refuse rather than overwrite: this file is Claude Code's own state, and
      // replacing an unparseable one with a fresh object would discard it.
      log(`FATAL ${CONFIG_PATH} is not readable JSON (${e.message}) — refusing to overwrite it.`);
      return;
    }
  }

  const [next, changed] = mergeConfig(existing, servers);
  if (!changed) {
    log(`already registered: ${names.join(", ")}`);
    return;
  }

  const tmp = `${CONFIG_PATH}.register-mcp.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2));
  renameSync(tmp, CONFIG_PATH);
  log(`registered at user scope: ${names.join(", ")} (from ${repos.length} repo(s))`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (e) {
    // Never block a session from starting.
    log(`FATAL ${e?.message ?? e} — starting without MCP registration`);
  }
  process.exit(0);
}
