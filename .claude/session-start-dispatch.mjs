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
 * ── The other half: repairing the setup script's steps ───────────────────────
 * Before fanning out it re-does the steps of the canonical setup-script field
 * that the field itself may have stopped doing — see THE REPAIR MANIFEST below.
 * That is per-ARTIFACT knowledge, not per-repo, and it is data plus one loop
 * rather than a function per artifact, because the mapping from the field's
 * steps to what is covered here is gated by a test (#91).
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
 * registration has been attempted.
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

/* ─────────────────────────────────────────────────────────────────────────────
 * THE REPAIR MANIFEST
 *
 * ── Why a manifest and not more functions (#91, I1) ───────────────────────────
 * The two repairs below were written a few hours apart as two bespoke
 * implementations of one idea, and a third would have been a third. That is the
 * smaller half of the problem. The larger half: nothing related the canonical
 * setup-script field's CONTENTS to what this file re-does when the field has not,
 * so a step added to the field with no fallback was invisible until it went
 * missing in production — which is exactly how #85 happened.
 *
 * So each entry names the `artifact` it covers, and `parseSteps` in
 * gen-bootstrap-pin.mjs enumerates the steps of the canonical bootstrap in
 * `.claude/boot.sh` (fetched by the one-line setup-script field — see
 * README.md). bootstrap-steps.test.mjs asserts the two agree: every step
 * of the field maps to an entry here or to an IRREDUCIBLE declaration. Adding a
 * line to the field with no fallback now fails `node --test .claude/` instead of
 * failing silently in a session six weeks later.
 *
 * ── The entries are deliberately NOT symmetric ────────────────────────────────
 * The comparison is per-entry because the failures differ in kind: the Stop hook
 * broke as a WRONG file, so presence proves nothing and only bytes decide; the
 * MCP config broke as a config that disagrees with a declaration, which is a
 * predicate over JSON, not a byte compare. A manifest that forced one comparison
 * on both would have to pick, and either pick reinstates a failure that has
 * already happened here. Entry shape:
 *
 *   artifact    the step of the canonical field this covers — the gate's key
 *   what        a human label for the log line
 *   compare     the DETECTOR: (ctx) => { ok, state, repairable?, missing?, log? }
 *   repair      the REPAIRER: (ctx) => the same shape, after trying
 *   context     failure wording: (missing) => a session-context block, or null
 *
 * `compare` and `repair` may be sync or async; the loop awaits either.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Steps of the canonical field that NOTHING here can re-do, with the reason.
 *
 * Declared rather than merely absent, which is the whole point of the gate: an
 * omission and a decision are indistinguishable from silence, and it was an
 * omission presenting as a decision that cost #85. A step that appears in the
 * field and in neither list fails the test.
 *
 * Both entries below are the same irreducibility. Something outside the repos
 * must name the entry point, because the hook that would self-heal a missing
 * hook is the thing being installed. Verified 2026-08-01 against the
 * cloud-environment docs: environments are editable only in the selector at
 * claude.ai/code — "There's no settings page or direct URL" — and `/remote-env`
 * "can't add or edit environments". No API, no CLI, no repo-committed form.
 *
 * So the target is not elimination. It is ONE line that fails loudly rather than
 * four steps where losing any one is silent.
 */
export const IRREDUCIBLE = [
  {
    artifact: "settings.json",
    reason:
      "This writes the pointer that invokes this dispatcher. A fallback would have to run " +
      "before itself. It is also the one file that must live outside version control, so it " +
      "is the thing the rest of this machinery is anchored to rather than something the " +
      "machinery can hold up.",
  },
  {
    artifact: "CLAUDE_SESSION_ROOT",
    reason:
      "An environment prefix on that same command, not a file. It is load-bearing only on " +
      "the fallback path, where the dispatcher was fetched to a cache directory and its " +
      "self-location resolves to `/` — see `sessionRootFrom`. Nothing running INSIDE the " +
      "dispatcher can supply it, because being wrong about the session root is precisely " +
      "the state it corrects.",
  },
];

/** What syncing the Stop hook should do, given the two files' bytes (`null` = absent). */
export function stopHookAction(source, installed) {
  if (source == null) return "absent";
  if (installed != null && source.equals(installed)) return "current";
  return "copy";
}

const readBytes = (p) => {
  try {
    return readFileSync(p);
  } catch {
    return null;
  }
};

/**
 * Replace the platform's Stop hook with this repo's copy (infra#112).
 *
 * The same move as the MCP entry above, prompted by the same failure. The copy is
 * one line of the environment's setup script — the part of the chain no reviewer
 * and no gate can read — and on 2026-08-01 it had gone missing along with the
 * `register-mcp.mjs` call (#85). Nothing reported either.
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
 * Sync, unlike the MCP entry: it is two file reads and a copy, and `syncStopHook`
 * below is the seam its tests drive.
 */
const STOP_HOOK_ENTRY = {
  artifact: "stop-hook-git-check.sh",
  what: "the Stop hook",

  // BYTES, not presence. The failure was a *wrong* file — 3262 stock bytes
  // against this repo's 5458 — so a hook that is merely THERE reports health
  // while advising an `--amend` over already-merged history.
  compare({ sourceDir = HERE, targetDir = join(homedir(), ".claude") } = {}) {
    const name = "stop-hook-git-check.sh";
    const state = stopHookAction(readBytes(join(sourceDir, name)), readBytes(join(targetDir, name)));
    // "absent" is a real case, not a bug: the bootstrap verifies each fetched
    // file independently, so a refused digest leaves the dispatcher present and
    // this one not. Nothing to install from — say so rather than guessing, and
    // never overwrite the platform's hook with nothing.
    if (state === "absent") {
      return {
        ok: false,
        repairable: false,
        state,
        log: `WARN no ${name} beside this file — leaving the platform's Stop hook in place`,
      };
    }
    return { ok: state === "current", state };
  },

  repair({ sourceDir = HERE, targetDir = join(homedir(), ".claude") } = {}) {
    const name = "stop-hook-git-check.sh";
    try {
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(join(targetDir, name), readBytes(join(sourceDir, name)));
      // Executable, because a copied-but-unrunnable hook is silently no hook.
      chmodSync(join(targetDir, name), 0o755);
    } catch (e) {
      return { ok: false, state: "failed", log: `WARN could not install ${name} — ${e?.message ?? e}` };
    }
    return {
      ok: true,
      state: "copy",
      log: "WARN installed the Stop hook the setup script did not (infra#112) — see .claude/README.md",
    };
  },

  // Deliberately no session-context block, unlike MCP. A stock Stop hook
  // degrades advice the model gives about git; a missing tool makes the model
  // fabricate an answer nothing downstream can distinguish from the real one.
  // Only the second is worth what a context block costs — the org context file's
  // own header says it counts against the window every session, and a block that
  // fires for the milder case teaches the reader to skim past both.
  context: null,
};

/**
 * Register any declared MCP server the config is missing, and report what is
 * STILL missing afterwards.
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
 * doing the rest of its job too — hence the warning on success, not just on
 * failure.
 *
 * Dynamic import, not a top-level one: the two files sit beside each other in the
 * attached checkout AND in the fetch cache, but the bootstrap verifies each
 * fetched file independently, so a refused digest can leave one present and the
 * other not. A missing register-mcp.mjs must degrade this dispatcher to what it
 * did before, never take the hooks down with it.
 */
const MCP_ENTRY = {
  artifact: "register-mcp.mjs",
  what: "MCP registration",

  // A PREDICATE over JSON, not a byte compare: the question is whether the
  // config agrees with what the attached repos declare, and `~/.claude.json`
  // legitimately holds much more than MCP config.
  async compare({ root = SESSION_ROOT } = {}) {
    let mod;
    try {
      mod = await import("./register-mcp.mjs");
    } catch (e) {
      // "Could not check" is a different claim from "nothing is missing", and
      // the log is the only place that distinction can be made. Not repairable
      // and no context block: an unverifiable state must not be reported to the
      // session as a confirmed missing tool.
      return { ok: false, repairable: false, state: "unknown", log: `WARN could not check MCP registration — ${e?.message ?? e}` };
    }
    const { missing } = mod.registrationStatus({ root });
    return { ok: missing.length === 0, state: missing.length ? "drifted" : "current", missing };
  },

  async repair({ root = SESSION_ROOT } = {}) {
    let mod;
    try {
      mod = await import("./register-mcp.mjs");
      const { wrote, outcome } = mod.register({ root });
      // Reached only when the config disagreed, so the write is the interesting
      // case; `register` is a no-op when it agrees.
      const wroteLog =
        outcome === "wrote"
          ? `WARN registered MCP server(s) the setup script did not: ${wrote.join(", ")} — see .claude/README.md`
          : null;
      const { missing } = mod.registrationStatus({ root });
      if (missing.length) {
        return {
          ok: false,
          state: "unrepaired",
          missing,
          log: `WARN MCP servers declared but NOT registered: ${missing.join(", ")}`,
        };
      }
      return { ok: true, state: "repaired", missing, log: wroteLog };
    } catch (e) {
      return { ok: false, state: "failed", missing: [], log: `WARN MCP registration failed — ${e?.message ?? e}` };
    }
  },

  context: (missing) => mcpDriftContext(missing),
};

export const MANIFEST = [MCP_ENTRY, STOP_HOOK_ENTRY];

/**
 * Should the repairer run, given what the detector saw?
 *
 * One line, factored out because it is the only decision the loop makes and it is
 * shared with `syncStopHook` below. `repairable: false` is how an entry says
 * "wrong, and nothing here can fix it" — distinct from healthy, and distinct from
 * a repair that was tried and failed.
 */
export const needsRepair = (seen) => !seen.ok && seen.repairable !== false;

/**
 * Run one entry: compare, repair if that is worth attempting, report either way.
 *
 * Never throws. An entry that blows up degrades to "could not check" — the same
 * contract the child hooks get, and for the same reason: a session that starts
 * slightly wrong beats a session that refuses to start.
 */
export async function applyEntry(entry, ctx = {}) {
  let result;
  try {
    result = await entry.compare(ctx);
    if (needsRepair(result)) result = await entry.repair(ctx);
  } catch (e) {
    result = { ok: false, state: "unknown", log: `WARN ${entry.what}: could not check — ${e?.message ?? e}` };
  }
  if (result.log) log(result.log);
  return { ...result, artifact: entry.artifact, what: entry.what, entry };
}

/**
 * The loop that replaced the two hand-written call sites in `main`.
 *
 * Returns the context blocks contributed by entries that could NOT be repaired —
 * the generalisation of what `mcpDriftContext` did for one artifact (I5). An
 * entry with `context: null` reports on stderr only.
 */
export async function applyManifest(entries = MANIFEST, ctx = {}) {
  const results = [];
  for (const entry of entries) results.push(await applyEntry(entry, ctx));
  const contexts = results
    .filter((r) => !r.ok)
    .map((r) => r.entry.context?.(r.missing ?? []))
    .filter(Boolean);
  return { results, contexts };
}

/**
 * Sync convenience for the Stop-hook entry, and the seam its tests drive.
 *
 * Kept because the entry is sync all the way down while `applyManifest` is not,
 * and a test that has to await to assert on a file copy is a test that will one
 * day pass because it forgot to. Shares `needsRepair` with the loop, so the two
 * cannot disagree about when a repair runs.
 *
 * Returns the action taken, and never throws.
 */
export function syncStopHook({ sourceDir = HERE, targetDir = join(homedir(), ".claude") } = {}) {
  const ctx = { sourceDir, targetDir };
  const seen = STOP_HOOK_ENTRY.compare(ctx);
  const result = needsRepair(seen) ? STOP_HOOK_ENTRY.repair(ctx) : seen;
  if (result.log) log(result.log);
  return result.state;
}

/**
 * The environment contract every child hook runs under.
 *
 * CLAUDE_PROJECT_DIR is what each repo's hook expects to point at ITSELF. The
 * session root's value (unset, or the root) is wrong for every child, so it is
 * rebound per repo — this is the substitution that makes the existing hooks work
 * unmodified.
 *
 * CLAUDE_SESSION_ROOT is exported unconditionally (2026-08-08): the dispatcher
 * already knows the session root — env override or self-location, see
 * `sessionRootFrom` — but children only saw it when the invoking command
 * happened to set it inline, which the devcontainer floor's settings do and
 * cloud front-desk sessions do not. That asymmetry is what let
 * .github-private's check-session-scope.sh gate on CLAUDE_CODE_REMOTE instead —
 * a platform variable the platform silently dropped on the floor, leaving the
 * detector dead there. Passing the root down makes "was I fanned out by this
 * dispatcher, and over what root" an org-owned fact a child can gate on and
 * read, instead of a platform variable nothing here controls.
 */
export function childEnv(repoDir, { base = process.env, sessionRoot = SESSION_ROOT } = {}) {
  return { ...base, CLAUDE_PROJECT_DIR: repoDir, CLAUDE_SESSION_ROOT: sessionRoot };
}

async function runHook(repoDir, command) {
  const label = `${command.split("/").pop()} (${repoDir.split("/").pop()})`;
  const env = childEnv(repoDir);
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
  // Every fallback the manifest declares, before fanning out. One loop; the two
  // call sites that used to sit here are now entries in MANIFEST above, and a
  // third fallback is a third entry rather than a third call site (#91).
  const { contexts: repairContexts } = await applyManifest();

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
  // First, deliberately: these are statements about what this session CAN do, and
  // they are worth nothing if the model reads them after the instructions telling
  // it to use the tool that is missing.
  const merged = mergeContexts([...repairContexts, ...contexts]);
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
