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
 * ── The second source: the boot cache (#325) ─────────────────────────────────
 * A session created WITHOUT `.github` attached has no checkout to read at all.
 * boot.sh fetches the pinned files into /opt/bounded-boot for exactly that case,
 * and fetching them is not enough: this script registers what a `.mcp.json`
 * DECLARES, and such a session has none, so a fetched MCP server sat there with
 * nothing pointing at it. boot.sh now writes a declaration into that directory
 * and `mcpSources` reads it — after the attached repos, which win (see there).
 *
 * ── What it does NOT do ──────────────────────────────────────────────────────
 * No per-repo knowledge. It reads whatever `.mcp.json` each source declares and
 * rewrites only what has to become absolute. A repo changes its own server by
 * editing its own `.mcp.json`; the boot cache is just one more directory that
 * carries one, not a special case in this file.
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

/**
 * The bootstrap's fetch cache — boot.sh's $BOOT when `.github` is NOT attached.
 *
 * A second registration source, for the session that has no repos to read
 * (#325). Overridable so a test can point it at a temp directory; the default is
 * the one path boot.sh writes, and the two must not drift.
 */
export const BOOT_DIR = process.env.BOUNDED_BOOT_DIR || "/opt/bounded-boot";

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
 * Every place a server can be DECLARED, in PRECEDENCE ORDER — first wins.
 *
 * ── Why the boot cache is a source at all (#325) ─────────────────────────────
 * A session created without `.github` attached has no checkout to read. boot.sh
 * fetches the pinned files into /opt/bounded-boot for exactly that case — but
 * fetching a file is not making a capability reachable: this script registers
 * what a `.mcp.json` DECLARES, and that session has no `.mcp.json` at all, so
 * the fetched verb server sat on disk with nothing pointing at it. boot.sh now
 * writes a declaration beside it, and this is what finds it.
 *
 * ── Why the repos come first ─────────────────────────────────────────────────
 * The cache is a copy of a PIN — a commit that main has, by construction, moved
 * past (the pin is bumped after a merge, so it always trails). An attached
 * checkout is that same file at least as new. So when both declare a name, the
 * checkout is the one to run, and this order is what says so; `collectServers`
 * keeps the first declaration of a name and this puts the newer one there.
 * Stated as an ORDER rather than left to `readdirSync` — which is how the
 * duplicate rule below already refuses to let directory order decide anything.
 *
 * The cache is skipped entirely unless it declares something, so on the normal
 * attached path this adds one `existsSync` and nothing else.
 */
export function mcpSources(
  { root = SESSION_ROOT, bootDir = BOOT_DIR } = {},
  { readdir = readdirSync, exists = existsSync } = {},
) {
  const repos = findMcpRepos(root, { readdir, exists });
  const boot = bootDir && !repos.includes(bootDir) && exists(join(bootDir, ".mcp.json")) ? [bootDir] : [];
  return [...repos, ...boot];
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

/**
 * Collect every declared server, keyed by name, already absolutized.
 *
 * `sourceDirs` is in precedence order (see `mcpSources`) and the FIRST
 * declaration of a name wins. `bootDir` names the one source that is expected to
 * lose that contest, so the log can say which of the two things happened.
 */
export function collectServers(
  sourceDirs,
  { read = (p) => readFileSync(p, "utf8"), exists = existsSync, bootDir = null } = {},
) {
  const servers = {};
  for (const repoDir of sourceDirs) {
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
        if (repoDir === bootDir) {
          // Not a conflict: the boot cache carries a copy of a PINNED commit and
          // an attached checkout is that file at least as new, so a repo
          // declaring the same name is SUPPOSED to win (#325). Reported anyway,
          // because "the cache stood down" and "the cache was never read" look
          // identical from the outside and only one of them is a bug.
          log(`'${name}' is declared by an attached repo — the boot-cache copy stands down`);
        } else {
          // Two repos claiming one name would make which-one-wins depend on
          // directory order. Say so rather than silently picking.
          log(`WARN duplicate MCP server name '${name}' — keeping the first, skipping ${repoDir}`);
        }
        continue;
      }
      servers[name] = absolutize(server, repoDir, { exists });
    }
  }
  return servers;
}

/**
 * Declared servers the live config does not already carry identically.
 *
 * ONE definition, used twice: `mergeConfig` writes exactly these, and
 * `registrationStatus` reports exactly these. A drift report that decided
 * "missing" separately from what the writer decides is "changed" would be one
 * refactor away from disagreeing with it — the same argument
 * `bootstrap-pin.test.mjs` makes about a gate that reimplements its generator.
 */
export function unregistered(servers, existing) {
  const live = existing?.mcpServers ?? {};
  return Object.keys(servers).filter((name) => JSON.stringify(live[name]) !== JSON.stringify(servers[name]));
}

/** Merge into the existing config, preserving everything else. Returns [next, changed]. */
export function mergeConfig(existing, servers) {
  const next = { ...existing, mcpServers: { ...(existing.mcpServers ?? {}) } };
  const missing = unregistered(servers, existing);
  for (const name of missing) next.mcpServers[name] = servers[name];
  return [next, missing.length > 0];
}

/**
 * Report — WITHOUT writing — whether boot-time registration actually happened.
 *
 * This exists because the registration step is the one link in the chain that
 * nothing observes. The setup script that calls this file lives outside version
 * control, so no reviewer and no CI gate can see it; when the call was dropped
 * from that field the only symptom was a session whose `~/.claude.json` read
 * `mcpServers: null` while every repo's CLAUDE.md went on telling the model to
 * ask for tools that were not there. Observed 2026-08-01: the model did as the
 * instruction said, found no `next` tool, and hand-ranked the board from the
 * GitHub API instead — the one thing front-desk-scheduler's CLAUDE.md forbids in
 * its opening paragraph. Nothing in the session said the tool was missing.
 *
 * Read-only because it is the REPORT: `register()` is the write, and a caller
 * that wants both calls both. Splitting them is what lets the dispatcher say
 * "still missing after we tried", which is a different and more useful claim than
 * either half alone.
 *
 * Returns `{ repos, declared, missing }`. Empty `declared` means no attached repo
 * asked for anything, which is not a fault.
 */
export function registrationStatus({
  root = SESSION_ROOT,
  bootDir = BOOT_DIR,
  configPath = CONFIG_PATH,
  read = (p) => readFileSync(p, "utf8"),
  exists = existsSync,
  readdir = readdirSync,
} = {}) {
  const repos = mcpSources({ root, bootDir }, { readdir, exists });
  const servers = collectServers(repos, { read, exists, bootDir });
  const declared = Object.keys(servers);

  let existing = {};
  if (exists(configPath)) {
    try {
      existing = JSON.parse(read(configPath));
    } catch {
      // Unreadable: every declared server is unverifiable. Report them all
      // missing rather than issuing a clean bill of health we cannot support.
      return { repos, declared, missing: declared };
    }
  }
  return { repos, declared, missing: unregistered(servers, existing) };
}

/**
 * Do the registration. Returns `{ declared, wrote, outcome }` and never throws.
 *
 * `outcome` is one of `none` (nothing declared), `already` (config agrees),
 * `wrote`, or `refused` (the config is not readable JSON, so writing would
 * discard Claude Code's own state).
 *
 * Extracted from what used to be `main` so the SessionStart dispatcher can call
 * it in-process. The comment this file used to carry — that registering after
 * launch cannot help, because servers resolve before hooks run — is only half
 * true, and the wrong half was load-bearing. Verified live 2026-08-01 on Claude
 * Code 2.1.42: a session that started with `mcpServers: null` picked up
 * `front-desk`'s five tools **within the same session**, seconds after this file
 * ran, with no relaunch. The launch-time resolution is real; it is just not the
 * only door — the config is watched.
 *
 * So run it late as well as at boot. Boot is still the right primary call site
 * (it is ordered before anything reads the tool list); this is the fallback for
 * when that call is not made, which is the failure that actually happened.
 */
export function register({ root = SESSION_ROOT, bootDir = BOOT_DIR, configPath = CONFIG_PATH } = {}) {
  const repos = mcpSources({ root, bootDir });
  const servers = collectServers(repos, { bootDir });
  const declared = Object.keys(servers);
  if (declared.length === 0) return { declared, wrote: [], outcome: "none" };

  let existing = {};
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(readFileSync(configPath, "utf8"));
    } catch (e) {
      // Refuse rather than overwrite: this file is Claude Code's own state, and
      // replacing an unparseable one with a fresh object would discard it.
      log(`FATAL ${configPath} is not readable JSON (${e.message}) — refusing to overwrite it.`);
      return { declared, wrote: [], outcome: "refused" };
    }
  }

  const wrote = unregistered(servers, existing);
  if (wrote.length === 0) return { declared, wrote, outcome: "already" };

  const [next] = mergeConfig(existing, servers);
  // Temp file and rename: an interrupted write cannot truncate the real config.
  const tmp = `${configPath}.register-mcp.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2));
  renameSync(tmp, configPath);
  return { declared, wrote, outcome: "wrote" };
}

function main() {
  const { declared, wrote, outcome } = register();
  if (outcome === "none") {
    log(`neither ${SESSION_ROOT}'s repos nor ${BOOT_DIR} declares a usable MCP server — nothing to do.`);
  }
  else if (outcome === "already") log(`already registered: ${declared.join(", ")}`);
  else if (outcome === "wrote") log(`registered at user scope: ${wrote.join(", ")}`);
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
