#!/usr/bin/env node
/**
 * harness-settings.mjs — compute what `$CLAUDE_CONFIG_DIR/settings.json` should
 * become, WITHOUT destroying what is already in it (#343, fix 1).
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 * boot.sh used to install the SessionStart pointer with `cat > "$CFG/settings.json"`.
 * That is a clobber. It wrote a `hooks` block and nothing else, so every bare boot
 * erased whatever else lived in that file — a user's `env`, their `permissions`,
 * a second SessionStart hook. Nothing reported it, because a clobber leaves a
 * file that parses perfectly.
 *
 * That was already a live bug on its own. It also BLOCKED the fix it stands in
 * front of: #337's posture matrix measured that a checkout-less session cannot
 * reach the report door because the auto-mode classifier refuses `curl` before it
 * runs, and the org's own answer to that is a narrow `permissions.allow` entry —
 * exactly the shape `.claude/settings.json` already uses to pre-approve
 * `org-repair.sh`. An allowlist cannot be installed into a file that is rewritten
 * from scratch every boot.
 *
 * ── Why it PRINTS rather than writes ─────────────────────────────────────────
 * boot.sh keeps the write. The settings file is the one artifact the whole
 * bootstrap is anchored to (it is what invokes the dispatcher, so no fallback can
 * repair it — see IRREDUCIBLE in session-start-dispatch.mjs), and moving the write
 * in here would take that single, enumerated `cat >` step out of the field's
 * parse. This computes; boot.sh installs; bootstrap-steps.test.mjs still sees the
 * step it must see.
 *
 * The corollary is the failure mode: this exits NON-ZERO rather than guessing.
 * boot.sh writes nothing when it does, which leaves an unreadable settings file
 * exactly as it found it. Refusing to merge is recoverable; clobbering is not.
 */

import { existsSync, readFileSync } from "node:fs";

/** The dispatcher's own basename, which is how its hook entry is recognised. */
export const DISPATCHER = "session-start-dispatch.mjs";

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const namesDispatcher = (h) => typeof h?.command === "string" && h.command.includes(DISPATCHER);

/**
 * Put `command` in the SessionStart list exactly once, leaving every other hook
 * alone.
 *
 * The identity of "our" entry is that its command names the dispatcher — not its
 * position and not its exact text, because the text carries `$ROOT` and `$BOOT`
 * as they resolved on THIS boot. A session that moved between the attached
 * checkout and the fetch cache has a stale path in there, and appending would
 * leave both, running the dispatcher twice from two locations.
 */
export function mergeSessionStart(hooks, command) {
  const base = isPlainObject(hooks) ? hooks : {};
  const groups = Array.isArray(base.SessionStart) ? base.SessionStart : [];

  let placed = false;
  const next = [];
  for (const group of groups) {
    const inner = Array.isArray(group?.hooks) ? group.hooks : null;
    if (!inner || !inner.some(namesDispatcher)) {
      next.push(group);
      continue;
    }
    // Rewrite the first dispatcher entry in place and drop any further copies:
    // two of them is a duplicate, never a second step.
    const rewritten = inner.flatMap((h) => {
      if (!namesDispatcher(h)) return [h];
      if (placed) return [];
      placed = true;
      return [{ ...h, type: h.type ?? "command", command }];
    });
    if (rewritten.length) next.push({ ...group, hooks: rewritten });
  }
  if (!placed) next.push({ matcher: "", hooks: [{ type: "command", command }] });

  return { ...base, SessionStart: next };
}

/**
 * Union `rules` into `permissions.allow`, honouring an explicit deny.
 *
 * A rule the user has DENIED is not re-granted here. Claude Code resolves deny
 * over allow anyway, so adding it would change no behaviour — but it would write
 * the org's wish into a file next to the user's refusal of it, and a settings
 * file that contradicts itself is the kind of thing nobody re-reads.
 */
export function mergeAllow(permissions, rules) {
  const base = isPlainObject(permissions) ? permissions : {};
  const have = Array.isArray(base.allow) ? base.allow : [];
  const deny = Array.isArray(base.deny) ? base.deny : [];
  const add = rules.filter((r) => !have.includes(r) && !deny.includes(r));
  if (!add.length) return isPlainObject(permissions) ? permissions : base;
  return { ...base, allow: [...have, ...add] };
}

/** The whole merge: everything in `existing` survives unless it is our own entry. */
export function mergeSettings(existing, { hookCommand = "", allow = [] } = {}) {
  if (!isPlainObject(existing)) throw new Error("settings.json is not a JSON object");
  const next = { ...existing };
  if (hookCommand) next.hooks = mergeSessionStart(existing.hooks, hookCommand);
  if (allow.length) next.permissions = mergeAllow(existing.permissions, allow);
  return next;
}

/**
 * Read the settings file as an object. Absent or empty is `{}` — there is
 * nothing to preserve, so the merge is just the install. Unparseable THROWS:
 * that file holds something we cannot read, and overwriting it is the one
 * outcome this module exists to prevent.
 */
export function readSettings(path, { read = readFileSync, exists = existsSync } = {}) {
  if (!path || !exists(path)) return {};
  const raw = read(path, "utf8");
  if (!raw.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${path} is not valid JSON (${e.message}) — refusing to overwrite it`);
  }
  if (!isPlainObject(parsed)) throw new Error(`${path} is not a JSON object — refusing to overwrite it`);
  return parsed;
}

/** `BOOT_ALLOW` is newline-separated so a rule may contain anything but a newline. */
export function parseAllow(value) {
  return String(value ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function main(argv = process.argv.slice(2), env = process.env, out = process.stdout) {
  const merged = mergeSettings(readSettings(argv[0]), {
    hookCommand: env.BOOT_HOOK_COMMAND ?? "",
    allow: parseAllow(env.BOOT_ALLOW),
  });
  out.write(`${JSON.stringify(merged, null, 2)}\n`);
}

if (process.argv[1] && process.argv[1].endsWith("harness-settings.mjs")) {
  try {
    main();
  } catch (e) {
    process.stderr.write(`harness-settings: ${e.message}\n`);
    process.exit(2);
  }
}
