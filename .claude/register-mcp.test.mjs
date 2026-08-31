// Tests for user-scope MCP registration.
//
// Two properties carry the weight. First, the merge must not damage
// ~/.claude.json — it is Claude Code's own state file and holds far more than MCP
// config, so a bug here costs a user their session state, not just a tool.
// Second, paths must stop depending on cwd, since that dependence is the whole
// reason a project-scoped .mcp.json fails in a multi-repo session.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BOOT_DIR,
  absolutize,
  collectServers,
  findMcpRepos,
  mcpSources,
  mergeConfig,
  register,
  registrationStatus,
  sessionRootFrom,
  unregistered,
} from "./register-mcp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BOOT_SH = readFileSync(join(HERE, "boot.sh"), "utf8");

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

// ── The boot cache as a second source (#325) ─────────────────────────────────
//
// The gap this closes: a session created WITHOUT `.github` attached has no repo
// to read, so every test above it is about a session shape that one does not
// have. boot.sh fetches the pinned files into /opt/bounded-boot for that case —
// and fetching them was never enough, because this file registers what a
// `.mcp.json` DECLARES and such a session had none. The fetched MCP server was
// on disk with nothing pointing at it, which is indistinguishable, from the
// model's side, from a server that was never shipped.

const bootFixture = (bootDir, { repos = [], bootDeclares = true } = {}) => ({
  readdir: () => repos.map(dirent),
  exists: (p) => (p === join(bootDir, ".mcp.json") ? bootDeclares : p.endsWith("/.mcp.json")),
});

test("the boot cache is a source when it declares something", () => {
  // The no-checkout session: no repos at all, and the verbs still register.
  const bootDir = "/opt/bounded-boot";
  assert.deepEqual(
    mcpSources({ root: "/home/user", bootDir }, bootFixture(bootDir)),
    [bootDir],
  );
});

test("a boot cache that declares nothing is not a source", () => {
  // The fetch may have failed the digest check, or this may be an attached
  // session that never populated a cache. Either way there is nothing to read,
  // and inventing a source would point the session at a server that is not there.
  const bootDir = "/opt/bounded-boot";
  assert.deepEqual(
    mcpSources({ root: "/home/user", bootDir }, bootFixture(bootDir, { bootDeclares: false })),
    [],
  );
});

test("attached repos come FIRST and the boot cache last", () => {
  // Precedence is stated as an order, so it cannot depend on readdir order.
  const bootDir = "/opt/bounded-boot";
  assert.deepEqual(
    mcpSources({ root: "/home/user", bootDir }, bootFixture(bootDir, { repos: [".github", "infra"] })),
    ["/home/user/.github", "/home/user/infra", bootDir],
  );
});

test("a repo's server WINS over the boot cache's copy of the same name", () => {
  // The cache holds a copy of a PINNED commit; main has moved past that commit
  // by construction, and an attached checkout is the same file at least as new.
  // Losing this contest would mean an attached session silently running the
  // older server — the failure the pin gate exists to keep out of the FETCH
  // path, arriving through the other door.
  const bootDir = "/opt/bounded-boot";
  const read = (p) =>
    JSON.stringify({
      mcpServers: {
        "bounded-verbs": { command: "node", args: [p.startsWith(bootDir) ? "verb-server.mjs" : ".claude/verb-server.mjs"] },
      },
    });
  const got = collectServers(["/home/user/.github", bootDir], { read, exists: () => false, bootDir });
  assert.deepEqual(Object.keys(got), ["bounded-verbs"]);
  assert.equal(got["bounded-verbs"].cwd, "/home/user/.github", "the boot cache outranked the checkout");
  assert.deepEqual(got["bounded-verbs"].args, [".claude/verb-server.mjs"]);
});

test("the boot cache's relative arg is absolutized against the cache, not a repo", () => {
  // boot.sh writes `args: ["verb-server.mjs"]` deliberately — the declaration is
  // written before anything knows where it will be read from, and this is what
  // resolves it. A cached server registered with a relative arg starts only when
  // cwd happens to be right, which at user scope it never is.
  const bootDir = "/opt/bounded-boot";
  const out = absolutize({ command: "node", args: ["verb-server.mjs"] }, bootDir, {
    exists: (p) => p === join(bootDir, "verb-server.mjs"),
  });
  assert.deepEqual(out.args, [join(bootDir, "verb-server.mjs")]);
  assert.equal(out.cwd, bootDir);
});

test("the no-checkout session registers the cached verbs, end to end", () => {
  // Real fs, and the shape #325 is about: no repos under the session root, a
  // populated fetch cache, and a config that must come out naming an absolute
  // server that exists.
  const dir = mkdtempSync(join(tmpdir(), "register-mcp-boot-"));
  const root = join(dir, "root");
  const bootDir = join(dir, "bounded-boot");
  mkdirSync(root, { recursive: true });
  mkdirSync(bootDir, { recursive: true });
  writeFileSync(join(bootDir, "verb-server.mjs"), "");
  writeFileSync(
    join(bootDir, ".mcp.json"),
    JSON.stringify({ mcpServers: { "bounded-verbs": { type: "stdio", command: "node", args: ["verb-server.mjs"] } } }),
  );
  const configPath = join(dir, "claude.json");

  const res = register({ root, bootDir, configPath });
  assert.equal(res.outcome, "wrote");
  assert.deepEqual(res.wrote, ["bounded-verbs"]);

  const written = JSON.parse(readFileSync(configPath, "utf8")).mcpServers["bounded-verbs"];
  assert.deepEqual(written.args, [join(bootDir, "verb-server.mjs")]);
  assert.equal(written.cwd, bootDir);
  assert.deepEqual(registrationStatus({ root, bootDir, configPath }).missing, []);
  rmSync(dir, { recursive: true, force: true });
});

test("an attached repo's server is what lands in the config, not the cached one", () => {
  // Same two declarations, against real fs and through the writer rather than
  // through collectServers alone — the precedence has to survive the whole path.
  const dir = mkdtempSync(join(tmpdir(), "register-mcp-boot-"));
  const root = join(dir, "root");
  const repoDir = join(root, ".github");
  const bootDir = join(dir, "bounded-boot");
  mkdirSync(join(repoDir, ".claude"), { recursive: true });
  mkdirSync(bootDir, { recursive: true });
  writeFileSync(join(repoDir, ".claude", "verb-server.mjs"), "");
  writeFileSync(join(bootDir, "verb-server.mjs"), "");
  writeFileSync(
    join(repoDir, ".mcp.json"),
    JSON.stringify({ mcpServers: { "bounded-verbs": { command: "node", args: [".claude/verb-server.mjs"] } } }),
  );
  writeFileSync(
    join(bootDir, ".mcp.json"),
    JSON.stringify({ mcpServers: { "bounded-verbs": { command: "node", args: ["verb-server.mjs"] } } }),
  );
  const configPath = join(dir, "claude.json");

  assert.equal(register({ root, bootDir, configPath }).outcome, "wrote");
  const written = JSON.parse(readFileSync(configPath, "utf8")).mcpServers["bounded-verbs"];
  assert.deepEqual(written.args, [join(repoDir, ".claude", "verb-server.mjs")]);
  assert.equal(written.cwd, repoDir);
  rmSync(dir, { recursive: true, force: true });
});

test("a session with no repos and no cache is still not a fault", () => {
  const dir = mkdtempSync(join(tmpdir(), "register-mcp-boot-"));
  const root = join(dir, "root");
  mkdirSync(root, { recursive: true });
  const res = register({ root, bootDir: join(dir, "nothing-here"), configPath: join(dir, "claude.json") });
  assert.equal(res.outcome, "none");
  assert.equal(existsSync(join(dir, "claude.json")), false);
  rmSync(dir, { recursive: true, force: true });
});

// ── The cache path, and the declaration in it, are boot.sh's ─────────────────

test("the default boot dir is the directory boot.sh actually populates", () => {
  // Two files naming one path in two languages: boot.sh writes it, this reads
  // it, and nothing else connects them. A drift here registers nothing and says
  // nothing, which is the shape of every failure in this file's header.
  assert.match(
    BOOT_SH,
    /^\s*BOOT=\/opt\/bounded-boot$/m,
    "boot.sh no longer fetches into /opt/bounded-boot — BOOT_DIR points at a directory nothing populates",
  );
  if (!process.env.BOUNDED_BOOT_DIR) {
    // The env override exists for tests; the shipped default is the contract.
    assert.equal(BOOT_DIR, "/opt/bounded-boot");
  }
});

test("boot.sh writes its declaration INTO the cache, and only when the server landed", () => {
  // Writing it unconditionally would declare a server that is not there — a tool
  // whose every call fails, which is worse than an absent tool. And writing it
  // outside the fetch branch would drop an untracked file into an attached
  // checkout, in the worktree the Stop hook reports on.
  const write = BOOT_SH.match(/if \[ -f "\$BOOT\/verb-server\.mjs" \]; then\n\s*cat > "\$BOOT\/\.mcp\.json"/);
  assert.ok(write, "boot.sh no longer guards the cached declaration on the fetched server existing");
});

test("the cached declaration names only files boot.sh fetches", () => {
  // The "no named mechanism that does not resolve" rule, machine-checked: the
  // declaration is written by one part of boot.sh and satisfied by another, and
  // a rename on either side would otherwise register a server that cannot start.
  const body = BOOT_SH.match(/cat > "\$BOOT\/\.mcp\.json" <<'JSON'\n([\s\S]*?)\nJSON\n/)?.[1];
  assert.ok(body, "boot.sh's cached .mcp.json heredoc is no longer in a parseable form");
  const declared = JSON.parse(body).mcpServers;
  assert.ok(Object.keys(declared).length > 0, "the cached declaration declares no servers");
  for (const [name, server] of Object.entries(declared)) {
    for (const arg of server.args ?? []) {
      if (arg.startsWith("-")) continue;
      assert.match(
        BOOT_SH,
        new RegExp(`fetch_verified\\s+${arg.replace(/\./g, "\\.")}\\s`),
        `the cached declaration points '${name}' at ${arg}, which boot.sh never fetches`,
      );
    }
  }
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

// ── Reporting drift ──────────────────────────────────────────────────────────
//
// The registration step is invoked from the environment's setup script, which
// lives outside version control — so nothing here can gate whether it RAN. What
// can be gated is that a session notices when it did not, which is the property
// these tests hold. 2026-08-01: it had not run, `~/.claude.json` read
// `mcpServers: null`, and the session went on hand-ranking the board from the
// GitHub API with no indication the `next` tool was absent.

test("missing is exactly what the merge would write", () => {
  // One definition of "not registered". If these two ever disagree, a session can
  // report a clean bill of health for a server the writer still considers stale.
  const servers = { a: { command: "x" }, b: { command: "y" } };
  const existing = { mcpServers: { a: { command: "x" } } };
  const [, changed] = mergeConfig(existing, servers);
  assert.deepEqual(unregistered(servers, existing), ["b"]);
  assert.equal(changed, true);
});

test("nothing declared, nothing missing — an identical config is not drift", () => {
  const servers = { a: { command: "x" } };
  assert.deepEqual(unregistered(servers, { mcpServers: { a: { command: "x" } } }), []);
  assert.deepEqual(unregistered({}, {}), []);
});

/** A session root with one repo declaring `front-desk`, and a config we choose. */
const fixture = (configText, { configExists = true } = {}) => ({
  root: "/home/user",
  configPath: "/root/.claude.json",
  readdir: () => [{ name: "front-desk-scheduler", isDirectory: () => true }],
  exists: (p) => (p === "/root/.claude.json" ? configExists : p === "/home/user/front-desk-scheduler/.mcp.json"),
  read: (p) =>
    p === "/root/.claude.json"
      ? configText
      : JSON.stringify({ mcpServers: { "front-desk": { command: "node", args: ["scripts/mcp.ts"] } } }),
});

test("the observed failure is reported: declared, and the config carries nothing", () => {
  const status = registrationStatus(fixture(JSON.stringify({ userID: "u1" })));
  assert.deepEqual(status.declared, ["front-desk"]);
  assert.deepEqual(status.missing, ["front-desk"]);
});

test("a registered server is not reported missing", () => {
  const registered = {
    mcpServers: {
      "front-desk": { command: "node", args: ["scripts/mcp.ts"], cwd: "/home/user/front-desk-scheduler" },
    },
  };
  assert.deepEqual(registrationStatus(fixture(JSON.stringify(registered))).missing, []);
});

test("a config registering an OLD path still counts as missing", () => {
  // Silently accepting a stale entry would leave the session pointing at a server
  // that no longer starts — indistinguishable, from the model's side, from one
  // that was never registered.
  const stale = { mcpServers: { "front-desk": { command: "node", args: ["/gone/mcp.ts"] } } };
  assert.deepEqual(registrationStatus(fixture(JSON.stringify(stale))).missing, ["front-desk"]);
});

test("an absent config means everything declared is missing", () => {
  assert.deepEqual(registrationStatus(fixture("", { configExists: false })).missing, ["front-desk"]);
});

test("an unreadable config reports missing rather than a clean bill of health", () => {
  assert.deepEqual(registrationStatus(fixture("{{{")).missing, ["front-desk"]);
});

test("no repo declaring .mcp.json is not a fault", () => {
  const status = registrationStatus({
    root: "/home/user",
    configPath: "/root/.claude.json",
    readdir: () => [{ name: "infra", isDirectory: () => true }],
    exists: (p) => p === "/root/.claude.json",
    read: () => "{}",
  });
  assert.deepEqual(status.declared, []);
  assert.deepEqual(status.missing, []);
});

// ── Registering, against real fs ─────────────────────────────────────────────
//
// `register` is now called from two places — the setup script at boot and the
// SessionStart dispatcher as a fallback — so its outcome is a value the caller
// branches on, not just a log line. These run against real fs because the
// property that matters is what ends up in the file.

/**
 * A session root with one repo declaring `front-desk`, plus a config path.
 *
 * `bootDir` is explicit and points nowhere on purpose. These run against real
 * fs, and the default boot cache is a real directory on a real machine — a
 * no-checkout session (the one #325 is about) has a POPULATED /opt/bounded-boot
 * and would register its servers here, so leaving the default in place would
 * make these tests pass or fail depending on which kind of session ran them.
 */
function realFixture(configText) {
  const dir = mkdtempSync(join(tmpdir(), "register-mcp-"));
  const root = join(dir, "root");
  const repoDir = join(root, "front-desk-scheduler");
  mkdirSync(join(repoDir, "scripts"), { recursive: true });
  writeFileSync(join(repoDir, "scripts", "mcp.ts"), "");
  writeFileSync(
    join(repoDir, ".mcp.json"),
    JSON.stringify({ mcpServers: { "front-desk": { command: "node", args: ["scripts/mcp.ts"] } } }),
  );
  const configPath = join(dir, "claude.json");
  if (configText !== undefined) writeFileSync(configPath, configText);
  return { dir, root, repoDir, configPath, bootDir: null, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("the observed failure self-heals: mcpServers absent, and one call fixes it", () => {
  const fx = realFixture(JSON.stringify({ userID: "u1", projects: { "/a": { trust: true } } }));
  const res = register({ root: fx.root, bootDir: fx.bootDir, configPath: fx.configPath });
  assert.equal(res.outcome, "wrote");
  assert.deepEqual(res.wrote, ["front-desk"]);

  const written = JSON.parse(readFileSync(fx.configPath, "utf8"));
  assert.equal(written.userID, "u1", "Claude Code's own state survives");
  assert.deepEqual(written.projects, { "/a": { trust: true } });
  // The whole point of user scope: the path no longer depends on cwd.
  assert.deepEqual(written.mcpServers["front-desk"].args, [join(fx.repoDir, "scripts", "mcp.ts")]);
  assert.equal(written.mcpServers["front-desk"].cwd, fx.repoDir);

  // And the report now agrees with the write — the two must not drift apart.
  assert.deepEqual(registrationStatus({ root: fx.root, bootDir: fx.bootDir, configPath: fx.configPath }).missing, []);
  fx.cleanup();
});

test("a second call is a no-op that reports 'already'", () => {
  const fx = realFixture("{}");
  register({ root: fx.root, bootDir: fx.bootDir, configPath: fx.configPath });
  const before = readFileSync(fx.configPath, "utf8");
  const res = register({ root: fx.root, bootDir: fx.bootDir, configPath: fx.configPath });
  assert.equal(res.outcome, "already");
  assert.deepEqual(res.wrote, []);
  assert.equal(readFileSync(fx.configPath, "utf8"), before);
  fx.cleanup();
});

test("an unreadable config is refused, not overwritten", () => {
  // It holds far more than MCP config; replacing it with a fresh object would
  // cost a user their session state to gain a tool.
  const fx = realFixture("{{{ not json");
  const res = register({ root: fx.root, bootDir: fx.bootDir, configPath: fx.configPath });
  assert.equal(res.outcome, "refused");
  assert.deepEqual(res.wrote, []);
  assert.equal(readFileSync(fx.configPath, "utf8"), "{{{ not json");
  fx.cleanup();
});

test("no config yet is not an error — it is created with only mcpServers", () => {
  const fx = realFixture(undefined);
  assert.equal(register({ root: fx.root, bootDir: fx.bootDir, configPath: fx.configPath }).outcome, "wrote");
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(fx.configPath, "utf8"))), ["mcpServers"]);
  fx.cleanup();
});

test("nothing declared writes nothing at all", () => {
  const dir = mkdtempSync(join(tmpdir(), "register-mcp-"));
  const root = join(dir, "root");
  mkdirSync(join(root, "infra"), { recursive: true });
  const configPath = join(dir, "claude.json");
  const res = register({ root, bootDir: null, configPath });
  assert.equal(res.outcome, "none");
  assert.equal(existsSync(configPath), false, "a config is not conjured for a session with no servers");
  rmSync(dir, { recursive: true, force: true });
});

test("reporting leaves the config byte-identical", () => {
  // Registering from a SessionStart hook cannot help the session doing the
  // checking — servers resolve before hooks run — and `~/.claude.json` is Claude
  // Code's own live state, which it may rewrite from memory after we touched it.
  // Against real fs, so this holds against the actual write path and not a stub.
  const dir = mkdtempSync(join(tmpdir(), "register-mcp-"));
  const root = join(dir, "root");
  const repoDir = join(root, "front-desk-scheduler");
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(join(repoDir, ".mcp.json"), JSON.stringify({ mcpServers: { "front-desk": { command: "node" } } }));

  const configPath = join(dir, "claude.json");
  const before = JSON.stringify({ userID: "u1", projects: { "/a": { trust: true } } });
  writeFileSync(configPath, before);

  assert.deepEqual(registrationStatus({ root, bootDir: null, configPath }).missing, ["front-desk"]);
  assert.equal(readFileSync(configPath, "utf8"), before);
  assert.deepEqual(readdirSync(dir).sort(), ["claude.json", "root"]);
  rmSync(dir, { recursive: true, force: true });
});
