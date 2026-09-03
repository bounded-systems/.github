#!/usr/bin/env bash
# CHANNEL SMOKE — does what the channel SERVES actually work on a bare host?
#
# ── Why this exists ──────────────────────────────────────────────────────────
# Every other gate in this repo tests the boot.sh in the WORKING TREE. Nothing
# tested the bytes a real session receives, and those are a different artifact
# reached by a four-step chain -- payload publish, boot-deploy, pin bump,
# boot-manifest -- any link of which can be incomplete while every PR is green.
# It has been incomplete: boot-manifest sat red on main three separate times in
# one day (#354's lap included), each time meaning merged code that reached no
# session at all. "Merging .github is not shipping" was written down on
# infra#584 and then had to be rediscovered.
#
# So this asks the only question that matters at the end of that chain: fetch
# what `channel/front-desk.json` NAMES, run it as a host with no checkout, and
# see whether a session comes out the far side with its settings intact.
#
# ── Why it fetches rather than reading the tree ──────────────────────────────
# Reading .claude/boot.sh would re-test what bootstrap-pin.test.mjs already
# covers and would go green through a broken channel, which is the exact
# failure this exists to catch. The digest check below is the SAME refusal the
# one-line setup field performs, so a channel naming bytes that do not hash to
# it fails here rather than in a session.
#
# LAG IS NOT FAILURE. The channel legitimately trails main between a merge and
# its bump; that is reported, never asserted. What is asserted is that whatever
# it serves WORKS.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHANNEL="${BOOT_CHANNEL_URL:-https://boot.bounded.tools/channel/front-desk.json}"
HOST="${BOOT_HOST:-https://boot.bounded.tools}"

PASS=0
FAIL=0
ok() { echo "  ok   $1"; PASS=$((PASS + 1)); }
no() { echo "  FAIL $1" >&2; FAIL=$((FAIL + 1)); }

# Same two routes, same refusal, as boot-cold-start.test.sh: a bare-host check
# that quietly skips reports the same green as one that passed.
NS=()
if command -v unshare >/dev/null && unshare -Urm true 2>/dev/null; then
  NS=(unshare -Urm)
elif command -v sudo >/dev/null && sudo -n unshare -m true 2>/dev/null; then
  NS=(sudo -n unshare -m)
else
  echo "FATAL: cannot enter a mount namespace — tried 'unshare -Urm' and 'sudo -n unshare -m'." >&2
  exit 1
fi

# WHERE NODE LIVES, and why this is not incidental. boot.sh runs `node` for the
# settings merge and for register-mcp.mjs, and node sits under /opt on both hosts
# this runs on: /opt/node22/bin here, /opt/hostedtoolcache/node/... on a GitHub
# runner. A bare host is simulated by making /opt unwritable -- and masking it
# with a tmpfs takes node with it, silently, so every node-dependent step turns
# into its own fallback path and the suite still reports green.
#
# That is not hypothetical: boot-cold-start.test.sh's bare cases did exactly this
# and had never once executed node (measured 2026-09-03). Bind node's directory
# out of the mask's reach FIRST, and put it on PATH.
command -v node >/dev/null || { echo "FATAL: no node on PATH — this check cannot run" >&2; exit 1; }
NODE_BIN="$(cd "$(dirname "$(readlink -f "$(command -v node)")")" && pwd)"

WORK="$(mktemp -d)"
cleanup() { rm -rf "$WORK" 2>/dev/null; [ -e "$WORK" ] && sudo -n rm -rf "$WORK" 2>/dev/null; return 0; }
trap cleanup EXIT
mkdir -p "$WORK/nodebin"

echo "channel smoke — the bytes the channel serves, run as a bare host"
echo "namespace route: ${NS[*]}"
echo

# ── 1. resolve, fetch, and REFUSE unless it hashes to what was named ─────────
echo "1. the channel names a digest, and the payload hashes to it"
MANIFEST="$(curl -fsSL -H 'cache-control: no-cache' "$CHANNEL?cb=$RANDOM$$" 2>/dev/null)"
DIGEST="$(printf '%s' "$MANIFEST" | sed -n 's/.*"boot":"\([0-9a-f]\{64\}\)".*/\1/p')"
VERSION="$(printf '%s' "$MANIFEST" | sed -n 's/.*"version":\([0-9]\{1,\}\).*/\1/p')"
if [ -z "$DIGEST" ]; then
  no "could not read a boot digest out of $CHANNEL — the field's own sed would fail too"
  echo; echo "channel smoke: $PASS passed, $FAIL failed"; exit 1
fi
ok "channel v${VERSION:-?} names ${DIGEST:0:12}…"

BOOT_SH="$WORK/boot.sh"
if ! curl -fsSL "$HOST/$DIGEST.sh" -o "$BOOT_SH"; then
  no "the channel names a payload the store does not serve — every bare session is broken right now"
  echo; echo "channel smoke: $PASS passed, $FAIL failed"; exit 1
fi
GOT="$(sha256sum "$BOOT_SH" | cut -d' ' -f1)"
if [ "$GOT" = "$DIGEST" ]; then
  ok "served payload is self-addressed (the field's refusal would accept it)"
else
  no "served bytes hash to ${GOT:0:12}…, not ${DIGEST:0:12}… — the field would REFUSE this"
  echo; echo "channel smoke: $PASS passed, $FAIL failed"; exit 1
fi

# Reported, never asserted — see the header.
HERE="$(sha256sum "$ROOT/.claude/boot.sh" | cut -d' ' -f1)"
if [ "$HERE" = "$DIGEST" ]; then
  echo "  note the channel serves exactly this tree's boot.sh"
else
  echo "  note the channel trails this tree (${DIGEST:0:12}… vs ${HERE:0:12}…) — normal between a merge and its bump"
fi
echo

# bare <name> — a host with NO checkout and an UNWRITABLE /opt/bounded-boot,
# which is what an unprivileged user meets on a real floor. Only that one
# directory is masked, so the rest of /opt (node) stays readable.
bare() {
  local name="$1" home="$WORK/$1/home" cfg="$WORK/$1/cfg"
  mkdir -p "$home" "$cfg"
  "${NS[@]}" bash -c "
    mount --bind '$NODE_BIN' '$WORK/nodebin'
    mount -t tmpfs none /home/user
    mkdir -p /opt/bounded-boot 2>/dev/null
    mount -t tmpfs -o ro none /opt/bounded-boot
    export PATH='$WORK/nodebin':\$PATH
    cd /tmp
    env HOME='$home' CLAUDE_CONFIG_DIR='$cfg' XDG_CACHE_HOME='$home/.cache' bash '$BOOT_SH'
  " >"$WORK/$name.out" 2>&1
  echo $?
}
said() { grep -q "$2" "$WORK/$1.out"; }
settings() { echo "$WORK/$1/cfg/settings.json"; }

# The document a real user has: an env value full of shell-hostile characters, a
# model, both halves of a permissions block, and their own SessionStart hook.
mine() {
  cat > "$1" <<'JSON'
{
  "env": { "MY_VAR": "cost is $5 and `date` and \\ backslash" },
  "model": "opus",
  "permissions": { "allow": ["Bash(bash .claude/org-repair.sh)"], "deny": ["Bash(rm:*)"] },
  "hooks": { "SessionStart": [ { "matcher": "", "hooks": [ { "type": "command", "command": "bash my-own-hook.sh" } ] } ] }
}
JSON
}

# ── 2. THE REGRESSION (#343) ─────────────────────────────────────────────────
echo "2. an existing settings.json survives a bare boot"
mkdir -p "$WORK/keep/cfg"
mine "$(settings keep)"
rc="$(bare keep)"
if [ "$rc" -eq 0 ] && said keep "not attached"; then
  ok "took the fetch branch and completed (exit 0)"
else
  no "did not complete on the fetch branch (exit $rc) — cases below prove nothing"
fi
# One node call: it prints a line per property and exits non-zero if any failed,
# so the report and the verdict cannot disagree.
node -e '
  const d = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const cmds = (d.hooks?.SessionStart ?? []).flatMap((g) => (g.hooks ?? []).map((h) => h.command));
  const checks = [
    ["the env value survived byte-for-byte", d.env?.MY_VAR === "cost is $5 and `date` and \\ backslash"],
    ["model survived", d.model === "opus"],
    ["permissions.allow survived", (d.permissions?.allow ?? []).includes("Bash(bash .claude/org-repair.sh)")],
    ["permissions.deny survived", (d.permissions?.deny ?? []).includes("Bash(rm:*)")],
    ["the user own SessionStart hook survived", cmds.includes("bash my-own-hook.sh")],
    ["the dispatcher hook was installed", cmds.some((c) => c.includes("session-start-dispatch.mjs"))],
  ];
  for (const [what, held] of checks) console.log(`${held ? "  ok  " : "  FAIL"} ${what}`);
  process.exit(checks.every(([, held]) => held) ? 0 : 1);
' "$(settings keep)"
if [ $? -eq 0 ]; then
  ok "the served boot.sh MERGED rather than clobbered"
else
  no "the served boot.sh did not preserve the document — #343 is live on the channel"
fi
echo

# ── 3. idempotence ───────────────────────────────────────────────────────────
echo "3. a second boot changes nothing"
cp "$(settings keep)" "$WORK/keep.after1"
bare keep >/dev/null
if cmp -s "$WORK/keep.after1" "$(settings keep)"; then
  ok "byte-identical after a second boot"
else
  no "a second boot rewrote the file"
fi
n="$(grep -c 'session-start-dispatch.mjs' "$(settings keep)")"
[ "$n" = 1 ] && ok "exactly one dispatcher entry" || no "$n dispatcher entries — the merge appends instead of rewriting"
echo

# ── 4. nothing to preserve ───────────────────────────────────────────────────
echo "4. no settings.json at all — the hook is still installed"
rc="$(bare fresh)"
if [ "$rc" -eq 0 ] && grep -q 'session-start-dispatch.mjs' "$(settings fresh)" 2>/dev/null; then
  ok "wrote the pointer on a host that had none"
else
  no "a host with no settings file did not get the SessionStart hook (exit $rc)"
fi
echo

# ── 5. the fail direction ────────────────────────────────────────────────────
# The half that keeps case 2 from being a worse bug than the one it fixes: a
# document that cannot be parsed must be left alone, not replaced.
echo "5. an unreadable settings.json is left untouched"
mkdir -p "$WORK/broken/cfg"
printf '{ not json' > "$(settings broken)"
cp "$(settings broken)" "$WORK/broken.before"
bare broken >/dev/null
if cmp -s "$WORK/broken.before" "$(settings broken)"; then
  ok "left it exactly as found"
else
  no "overwrote a settings file it could not read"
fi
said broken "could not merge" && ok "and said so" || no "left the hook uninstalled without reporting it"
echo

echo "channel smoke: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
