#!/usr/bin/env node
/**
 * SessionStart dispatcher for MULTI-REPO cloud sessions.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Claude Code fires SessionStart hooks from the PROJECT directory's
 * `.claude/settings.json`. A cloud session launched with one repo gets that for
 * free. A session launched with several does not: the session root (e.g.
 * /home/user) is not a repo, CLAUDE_PROJECT_DIR is unset, and no repo's
 * `.claude/settings.json` is ever discovered.
 *
 * Observed 2026-07-31 in a nine-repo session: CLAUDE_CODE_REMOTE=true, yet the
 * hooks in front-desk-scheduler, infra and .github ALL failed to run. The
 * session started with no deno and no node_modules — the exact degraded state
 * front-desk-scheduler's hook was written to prevent — and with none of the
 * org context .github's hook injects. Nothing reported this; it presents as a
 * repo that simply has no dependencies installed.
 *
 * This dispatcher is the missing step. It is installed ONCE at the session root
 * and fans out to every attached repo that declares SessionStart hooks of its
 * own, so each repo keeps owning its provisioning and this file stays policy-free.
 *
 * ── What it does NOT do ──────────────────────────────────────────────────────
 * It contains no per-repo knowledge. It does not know what deno is, which repo
 * needs dolt, or where org context comes from. Adding a repo to a session, or a
 * hook to a repo, requires no edit here. If you find yourself special-casing a
 * repo in this file, the logic belongs in that repo's own hook.
 *
 * ── Install ──────────────────────────────────────────────────────────────────
 * The user settings directory is ephemeral — the container is reclaimed — so the
 * environment's setup script must recreate the pointer on every boot:
 *
 *   mkdir -p "$HOME/.claude"
 *   cat > "$HOME/.claude/settings.json" <<'JSON'
 *   {
 *     "hooks": {
 *       "SessionStart": [
 *         { "matcher": "", "hooks": [ { "type": "command",
 *           "command": "node /home/user/.github/.claude/session-start-dispatch.mjs" } ] }
 *       ]
 *     }
 *   }
 *   JSON
 *
 * NOTE the two directories above are NOT the same one, and `$HOME` names only the
 * first. The session runs as root, so `$HOME/.claude` is `/root/.claude` — correct
 * for the settings file. The repos are checked out under `/home/user`, so the
 * dispatcher path must be spelled literally; `$HOME/.github` would be
 * `/root/.github`, which does not exist. That is the same `$HOME` ≠ session-root
 * confusion recorded against `sessionRootFrom` below, and it fails the same silent
 * way: node cannot find the file, the hook errors, and the session starts
 * unprovisioned — presenting as a broken checkout. Use `$CLAUDE_SESSION_ROOT` (see
 * below) if the repos live somewhere else.
 *
 * That pointer is the only thing living outside version control. Keep it a
 * pointer: logic added there is unreviewable and ungateable (the failure mode
 * infra#122 was filed about — a second copy with no drift gate).
 *
 * The snippet above is the MINIMUM that works, and it assumes `.github` is
 * attached to the session. README.md carries the full script, which additionally
 * falls back to copies fetched from a pinned commit when it is not — and verifies
 * those against recorded SHA-256 digests before executing them, refusing to wire
 * anything up on a mismatch. Prefer that one; this is here so the file explains
 * its own installation without sending the reader elsewhere to understand it.
 *
 * ── Contract ─────────────────────────────────────────────────────────────────
 * Every child hook is best-effort. A hook that fails, hangs or prints garbage
 * degrades its own repo and nothing else: a session that starts slightly wrong
 * beats a session that refuses to start. Failures are reported on stderr, which
 * reaches the session log without becoming model context.
 *
 * stdout is reserved for the merged SessionStart JSON. A child's stdout is
 * treated as context ONLY if it parses as a hookSpecificOutput envelope;
 * anything else (progress prose, warnings) is forwarded to stderr. Concatenating
 * the two would corrupt the envelope — .github's hook emits JSON while
 * front-desk-scheduler's and infra's echo prose, so both shapes are live today.
 */

import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const pexecFile = promisify(execFile);

/** Per-hook wall clock. Long enough for a toolchain install, short enough that a
 *  wedged hook cannot hold a session hostage. */
const HOOK_TIMEOUT_MS = Number(process.env.SESSION_START_HOOK_TIMEOUT_MS ?? 10 * 60 * 1000);

/**
 * The directory the session's repos are checked out into.
 *
 * Derived from this file's own location — it lives at
 * `<session root>/<repo>/.claude/session-start-dispatch.mjs`, so three levels up
 * is the root — rather than from `homedir()`. That was the first implementation
 * and it was wrong in the very environment this exists for: the session runs as
 * root, so `homedir()` is `/root` while the repos are in `/home/user`. The
 * dispatcher found nothing, reported "nothing to do", and exited 0 — failing
 * exactly as silently as the problem it was written to fix.
 *
 * Self-locating is correct however the file is invoked, and by whom.
 */
export function sessionRootFrom(fileUrl) {
  return resolve(dirname(fileURLToPath(fileUrl)), "..", "..");
}

const SESSION_ROOT = process.env.CLAUDE_SESSION_ROOT || sessionRootFrom(import.meta.url);

/** Where this file and its siblings actually live — the attached checkout, or the
 *  bootstrap's fetch cache. Both hold the same three files. */
const HERE = dirname(fileURLToPath(import.meta.url));

const log = (msg) => process.stderr.write(`session-start-dispatch: ${msg}\n`);

/** Immediate subdirectories of the session root that look like an attached repo. */
export function findRepos(root, { readdir = readdirSync, exists = existsSync } = {}) {
  let entries;
  try {
    entries = readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && e.name !== ".claude" && e.name !== "node_modules")
    .map((e) => join(root, e.name))
    .filter((dir) => exists(join(dir, ".claude", "settings.json")))
    .sort();
}

/**
 * The SessionStart commands a repo's settings.json declares.
 *
 * Read from settings.json rather than assumed from a filename on purpose: the
 * three hooks in this org today do not agree on one. front-desk-scheduler and
 * infra point at `$CLAUDE_PROJECT_DIR/.claude/hooks/session-start.sh`; .github
 * runs `bash .claude/inject-org-context.sh`, a RELATIVE path that only resolves
 * with cwd set to the repo. Both shapes work if the declaration is the source of
 * truth; neither works if this file guesses.
 */
export function sessionStartCommands(settings) {
  const groups = settings?.hooks?.SessionStart;
  if (!Array.isArray(groups)) return [];
  return groups
    .flatMap((g) => (Array.isArray(g?.hooks) ? g.hooks : []))
    .filter((h) => h?.type === "command" && typeof h.command === "string")
    .map((h) => h.command);
}

/**
 * Merge hook contexts into the one string SessionStart accepts, dropping exact
 * duplicates.
 *
 * Two attached repos legitimately emit the SAME org context. `.github`'s hook
 * resolves `<session root>/.github-private/claude/context.md` when that repo is
 * attached, and `.github-private`'s own hook reads the identical file from its
 * own checkout. Observed live 2026-07-31 in a four-repo session: "2 injected
 * context", 2289 bytes twice, byte-identical, on a file whose own header reads
 * "Keep this LEAN — it counts against the context window every session".
 *
 * Deleting either hook is the wrong fix, because neither is redundant in
 * general: without `.github-private` attached, `.github`'s hook is the only one
 * that can reach the context at all (it falls back to the network); without
 * `.github` attached, `.github-private`'s hook is. They collide only when BOTH
 * are attached — which is exactly the session that verifies the chain. So the
 * duplication is a property of merging, and it is fixed where the merge happens.
 *
 * Compared on the TRIMMED text while the first spelling is what gets kept: the
 * two producers differ in trailing newline (`jq --arg` on `$(cat …)` strips it,
 * a direct read does not), and a newline is not a second copy of the org map.
 * Order is preserved, so dispatch order still determines what the model reads
 * first.
 */
export function mergeContexts(contexts) {
  const seen = new Set();
  const kept = [];
  for (const ctx of contexts) {
    const key = String(ctx ?? "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    kept.push(ctx);
  }
  return { text: kept.join("\n\n---\n\n"), kept: kept.length, dropped: contexts.length - kept.length };
}

/** Does this stdout carry a SessionStart context envelope? */
export function extractContext(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(text);
    const out = parsed?.hookSpecificOutput;
    if (out?.hookEventName !== "SessionStart") return null;
    const ctx = out.additionalContext;
    return typeof ctx === "string" && ctx.trim() ? ctx : null;
  } catch {
    return null;
  }
}

/**
 * The context block emitted when a declared MCP server is STILL absent after
 * `ensureMcpRegistered` has tried to register it.
 *
 * Reached only when the write was refused or did not take — an unreadable
 * `~/.claude.json`, or a config that disagrees with the declaration for a reason
 * re-writing it did not resolve. The ordinary drift case self-heals and produces
 * no context at all, which is deliberate: the org context file's own header says
 * it counts against the window every session, and a block that fires when nothing
 * is wrong is how a warning gets skimmed past.
 *
 * The wording is aimed at the failure that actually follows, not at the missing
 * tool in the abstract. A model told by a repo's CLAUDE.md to ask a tool, finding
 * no such tool, does not stop — it reconstructs the answer by hand from whatever
 * it can reach and reports that reconstruction with the same confidence. So the
 * block says what is unavailable AND what to do instead, because "the tool is
 * missing" on its own is an invitation to improvise.
 *
 * Kept repo-agnostic: which CLI stands in for which server is the declaring
 * repo's knowledge and belongs in its CLAUDE.md, not here.
 */
export function mcpDriftContext(missing) {
  if (!missing?.length) return null;
  return [
    `## Session capability warning: MCP servers declared but NOT registered — ${missing.join(", ")}`,
    "",
    "An attached repo declares these in its `.mcp.json` and `~/.claude.json` does not",
    "carry them, so **their tools may be absent from this session**. Registering them",
    "was attempted at session start and did not take — most likely `~/.claude.json` is",
    "not readable JSON, which is refused rather than overwritten because it is Claude",
    "Code's own state.",
    "",
    "**Do not substitute your own reasoning for a missing tool.** Check whether the",
    "tools are present before relying on them. Where the declaring repo offers the same",
    "verbs on its CLI, use those; where it does not, say the tool was unavailable rather",
    "than answering as though you had consulted it. An answer reconstructed by hand is",
    "not the answer the tool would have given, and nothing downstream can tell the two",
    "apart unless you say which one this is.",
    "",
    "`bounded-systems/.github` → `.claude/README.md` documents the registration path and",
    "the setup-script text it is driven from.",
  ].join("\n");
}

/** What syncing the Stop hook should do, given the two files' bytes (`null` = absent). */
export function stopHookAction(source, installed) {
  if (source == null) return "absent";
  if (installed != null && source.equals(installed)) return "current";
  return "copy";
}

/**
 * Replace the platform's Stop hook with this repo's copy (infra#112).
 *
 * The same move as the MCP registration below, prompted by the same failure. The
 * copy is one line of the environment's setup script — the part of the chain no
 * reviewer and no gate can read — and on 2026-08-01 it had gone missing along
 * with the `register-mcp.mjs` call (#85). Nothing reported either.
 *
 * This one fails quietly rather than loudly, which is why it went unnoticed
 * longer: the stock hook scopes its check to `origin/<branch>..HEAD`, which after
 * a squash merge includes GitHub's own merge commit. So it warns "Unverified"
 * after EVERY merge and advises an `--amend` that would rewrite already-merged
 * history. A hook that cries wolf on every successful merge is worse than no
 * hook, because it trains you to ignore the one time it is right.
 *
 * Only the SCRIPT is replaced. `launcher-settings.json` declares the Stop hook
 * and is platform-managed and rewritten, so it is left alone — we swap the file
 * it already points at. The hook is invoked per Stop event, so a copy written
 * during SessionStart is in force from the first Stop of the session onward,
 * which is what makes doing it here worth anything.
 *
 * NOTE `homedir()` is right here and wrong for the session root. The session runs
 * as root, so this resolves `/root/.claude` — which IS where the user settings
 * live — while the repos are under `/home/user`. That asymmetry is exactly what
 * `sessionRootFrom` above exists for. Do not "fix" one to match the other.
 *
 * Returns the action taken, and never throws: a session that starts with the
 * stock Stop hook beats one that fails to start.
 */
export function syncStopHook({ sourceDir = HERE, targetDir = join(homedir(), ".claude") } = {}) {
  const name = "stop-hook-git-check.sh";
  const read = (p) => {
    try {
      return readFileSync(p);
    } catch {
      return null;
    }
  };

  const source = read(join(sourceDir, name));
  const action = stopHookAction(source, read(join(targetDir, name)));
  // "absent" is a real case, not a bug: the bootstrap verifies each fetched file
  // independently, so a refused digest leaves the dispatcher present and this one
  // not. Nothing to install from — say so rather than guessing.
  if (action === "absent") {
    log(`WARN no ${name} beside this file — leaving the platform's Stop hook in place`);
    return action;
  }
  if (action === "current") return action;

  try {
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, name), source);
    chmodSync(join(targetDir, name), 0o755);
    log(`WARN installed the Stop hook the setup script did not (infra#112) — see .claude/README.md`);
  } catch (e) {
    log(`WARN could not install ${name} — ${e?.message ?? e}`);
    return "failed";
  }
  return action;
}

async function runHook(repoDir, command) {
  const label = `${command.split("/").pop()} (${repoDir.split("/").pop()})`;
  // CLAUDE_PROJECT_DIR is what each repo's hook expects to point at ITSELF. The
  // session root's value (unset, or the root) is wrong for every child, so it is
  // rebound per repo — this is the substitution that makes the existing hooks work
  // unmodified.
  const env = { ...process.env, CLAUDE_PROJECT_DIR: repoDir };
  try {
    const { stdout, stderr } = await pexecFile("bash", ["-lc", command], {
      cwd: repoDir,
      env,
      timeout: HOOK_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (stderr?.trim()) log(`${label}: ${stderr.trim().split("\n").slice(-3).join(" | ")}`);
    const context = extractContext(stdout);
    if (!context && stdout?.trim()) log(`${label}: ${stdout.trim().split("\n").slice(-3).join(" | ")}`);
    return { label, ok: true, context };
  } catch (e) {
    // Non-zero exit, timeout, or a missing interpreter. Report and continue —
    // one repo's broken hook must not take the session down with it.
    const why = e.killed ? `timed out after ${HOOK_TIMEOUT_MS}ms` : (e.shortMessage ?? e.message);
    log(`WARN ${label}: ${why}`);
    // A hook can fail AFTER emitting a valid envelope; keep it if so.
    return { label, ok: false, context: extractContext(e.stdout) };
  }
}

/**
 * Register any declared MCP server the config is missing, and report what is
 * STILL missing afterwards — `[]` if nothing is, or if it could not be checked.
 *
 * The primary call site for registration is the environment's setup script,
 * before Claude Code launches. This is the fallback for when that call is not
 * made — which is not hypothetical: that script is the one link in the chain
 * living outside version control, where no reviewer and no gate can see it, and
 * on 2026-08-01 it had silently stopped making the call. A session ran with
 * `mcpServers: null` while every repo's CLAUDE.md went on telling the model to
 * ask for tools that were not there, and the model did the predictable thing —
 * it reconstructed the answer by hand from the GitHub API, which is the one move
 * front-desk-scheduler's CLAUDE.md forbids in its opening paragraph.
 *
 * Registering this late does work: verified live on Claude Code 2.1.42, a session
 * that started with nothing registered gained the server's tools seconds after
 * the write, with no relaunch. It is a fallback rather than the fix because it
 * cannot be ordered before whatever already read the tool list, and because a
 * setup script that has stopped calling `register-mcp.mjs` has probably stopped
 * doing the rest of its job too — hence the warning below even on success.
 *
 * Dynamic import, not a top-level one: the two files sit beside each other in the
 * attached checkout AND in the fetch cache, but the bootstrap verifies each
 * fetched file independently, so a refused digest can leave one present and the
 * other not. A missing register-mcp.mjs must degrade this dispatcher to what it
 * did before, never take the hooks down with it.
 */
async function ensureMcpRegistered() {
  let mod;
  try {
    mod = await import("./register-mcp.mjs");
  } catch (e) {
    // "Could not check" is a different claim from "nothing is missing", and the
    // log is the only place that distinction can be made.
    log(`WARN could not check MCP registration — ${e?.message ?? e}`);
    return [];
  }
  try {
    const { wrote, outcome } = mod.register({ root: SESSION_ROOT });
    if (outcome === "wrote") {
      log(`WARN registered MCP server(s) the setup script did not: ${wrote.join(", ")} — see .claude/README.md`);
    }
    const { missing } = mod.registrationStatus({ root: SESSION_ROOT });
    if (missing.length) log(`WARN MCP servers declared but NOT registered: ${missing.join(", ")}`);
    return missing;
  } catch (e) {
    log(`WARN MCP registration failed — ${e?.message ?? e}`);
    return [];
  }
}

async function main() {
  const missingMcp = await ensureMcpRegistered();
  syncStopHook();

  const repos = findRepos(SESSION_ROOT);
  if (repos.length === 0) {
    log(`no attached repo under ${SESSION_ROOT} declares SessionStart hooks — nothing to do.`);
  }

  const contexts = [];
  const ran = [];
  for (const repoDir of repos) {
    let commands;
    try {
      commands = sessionStartCommands(JSON.parse(readFileSync(join(repoDir, ".claude", "settings.json"), "utf8")));
    } catch (e) {
      log(`WARN ${repoDir}: unreadable .claude/settings.json — ${e.message}`);
      continue;
    }
    // Sequential, not parallel: these hooks install toolchains and append to the
    // shared CLAUDE_ENV_FILE. Racing them would interleave PATH exports.
    for (const command of commands) {
      const res = await runHook(repoDir, command);
      ran.push(res);
      if (res.context) contexts.push(res.context);
    }
  }

  const failed = ran.filter((r) => !r.ok).map((r) => r.label);
  // First, deliberately: it is a statement about what this session CAN do, and it
  // is worth nothing if the model reads it after the instructions telling it to
  // use the tool that is missing.
  const drift = mcpDriftContext(missingMcp);
  const merged = mergeContexts(drift ? [drift, ...contexts] : contexts);
  log(
    `ran ${ran.length} hook(s) across ${repos.length} repo(s); ` +
      `${merged.kept} injected context` +
      // Reported rather than silently absorbed: a duplicate means two repos are
      // serving the same file, which is worth seeing in the session log even
      // though it is now harmless.
      (merged.dropped ? ` (${merged.dropped} duplicate dropped)` : "") +
      (failed.length ? `; FAILED: ${failed.join(", ")}` : ""),
  );

  if (merged.kept > 0) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: merged.text,
        },
      }),
    );
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  // Never let the dispatcher itself be the reason a session fails to start.
  main().catch((e) => {
    log(`FATAL ${e?.message ?? e} — starting without hooks`);
    process.exit(0);
  });
}
