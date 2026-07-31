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
import { existsSync, readFileSync, readdirSync } from "node:fs";
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

async function main() {
  const repos = findRepos(SESSION_ROOT);
  if (repos.length === 0) {
    log(`no attached repo under ${SESSION_ROOT} declares SessionStart hooks — nothing to do.`);
    return;
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
  const merged = mergeContexts(contexts);
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
