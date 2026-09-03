#!/usr/bin/env bash
# Cold-start tests for boot.sh's fetch-cache branch — the path a host with NO
# attached checkout takes (#848). Run from the repo root:
#
#   bash .claude/boot-cold-start.test.sh
#
# ── Why this exists ─────────────────────────────────────────────────────────
# That branch had only ever run in a managed session, which runs as ROOT. So
# `mkdir -p /opt/bounded-boot` succeeded there and nowhere else. On the first
# real floor — an exe.dev VM, user `exedev`, 2026-09-02 — it failed, every
# fetch_verified then failed writing into a directory that did not exist, and
# boot.sh printed `bootstrap: ready` and exited 0 having installed NOTHING.
#
# Nothing caught it because nothing ran this branch as anyone but root. That is
# what this file fixes: the environment, not just the code.
#
# ── How it gets a bare host without root ────────────────────────────────────
# A mount namespace — entered unprivileged with `unshare -Urm` where that works,
# or with `sudo -n unshare -m` on a runner where it does not (see the route
# selection below). Two properties make it exactly right, and both were measured
# before relying on them:
#
#   1. a tmpfs over /home/user hides the checkouts, so ROOT's probe falls all
#      the way through and the fetch branch is taken. Setting
#      CLAUDE_SESSION_ROOT is NOT enough — boot.sh probes past an empty root to
#      a hardcoded /home/user, so an env var alone cannot simulate a bare host.
#
#      AND MASKING /home/user IS NOT ENOUGH EITHER. ROOT's chain probes $PWD and
#      ${PWD%/*} before it reaches /home/user, so on a GitHub runner — where the
#      checkout lives at /home/runner/work/.github/.github — ${PWD%/*} finds the
#      repo and the fetch branch is never taken. That is why every bare case
#      `cd`s somewhere neutral first. Caught by CI, by this file's own "did NOT
#      take the fetch branch" assertion: the suite was environment-dependent in
#      precisely the way it exists to prevent, and passed locally for that
#      reason.
#   2. the caller is uid 0 INSIDE the namespace yet /opt stays unwritable,
#      because /opt is owned by a real uid that is not mapped in. So `mkdir -p
#      /opt/bounded-boot` fails with the same Permission denied a floor sees,
#      without this test needing any privilege.
#
# ── This test reaches the network, deliberately ─────────────────────────────
# Case 1 fetches the real artifacts from boot.bounded.tools. The property under
# test is that a host holding NOTHING can bootstrap itself, and a mocked fetch
# would test the mock. Case 3 breaks the fetch on purpose to prove the failure
# is reported rather than swallowed.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_BOOT="$ROOT/.claude/boot.sh"
# BOOT_SH is set after $WORK exists: boot.sh lives UNDER /home/user, and these
# cases mount a tmpfs over that path — which would hide the script itself and
# fail with 127 before testing anything. It is staged outside first. (Found the
# obvious way: the first run of this file was six failures, all exit 127.)
BOOT_SH=""

PASS=0
FAIL=0
ok() {
  echo "  ok   $1"
  PASS=$((PASS + 1))
}
no() {
  echo "  FAIL $1" >&2
  FAIL=$((FAIL + 1))
}

# HOW THE NAMESPACE IS ENTERED, and why there are two ways.
#
# `unshare -Urm` (user + mount namespace, unprivileged) works in a dev container
# and is the preferred route: it needs nothing. It does NOT work on a GitHub
# Actions runner — unprivileged user namespaces are unavailable there, and the
# first version of this file discovered that by going red on its own first CI
# run with `exit 2`. The refusal was correct; the assumption that one route
# generalised was not.
#
# `sudo -n unshare -m` is the runner route. Runners have passwordless sudo, and
# entering as real root is harmless here BECAUSE /opt is masked with a
# read-only mount rather than a chmod — see bare() below. That masking is what
# makes both routes produce the same measurement.
#
# If NEITHER works, this REFUSES. A cold-start check that quietly skips reports
# the same green as one that passed (rule 3), and the whole point of this file
# is that nothing was exercising the branch it covers.
NS=()
if command -v unshare >/dev/null && unshare -Urm true 2>/dev/null; then
  NS=(unshare -Urm)
elif command -v sudo >/dev/null && sudo -n unshare -m true 2>/dev/null; then
  NS=(sudo -n unshare -m)
else
  echo "FATAL: cannot enter a mount namespace — tried 'unshare -Urm' (unprivileged" >&2
  echo "       user namespaces) and 'sudo -n unshare -m'. The bare-host cases cannot" >&2
  echo "       run, so this REFUSES rather than reporting green." >&2
  exit 2
fi
echo "namespace route: ${NS[*]}"

# WHERE NODE LIVES, and why masking /opt was hiding it (#343 follow-up). boot.sh
# runs `node` for the settings merge and for register-mcp.mjs. node sits under
# /opt on both hosts this runs on -- /opt/node22/bin in the managed image,
# /opt/hostedtoolcache/node/... on a GitHub runner -- so `mount -t tmpfs none
# /opt`, which every bare case below used to do, took node with it. Silently:
# each node step fell through to its own absence branch and the suite still
# reported green. Measured 2026-09-03: `command -v node` inside that mask
# answered nothing, which means the bare cases had never once executed node, and
# case 1's "wrote settings.json" was the fallback write rather than the merge.
#
# Only /opt/bounded-boot is masked now, and node's directory is bound somewhere
# the mask does not reach and put on PATH. The cases are unchanged in intent: a
# host where the shared cache location is not writable.
command -v node >/dev/null || { echo "FATAL: no node on PATH — the bare cases cannot exercise the settings merge" >&2; exit 1; }
NODE_BIN="$(cd "$(dirname "$(readlink -f "$(command -v node)")")" && pwd)"

WORK="$(mktemp -d)"
# The sudo route runs boot.sh as real root, so it leaves root-owned files behind
# that an unprivileged trap cannot remove (CI showed `rm: Permission denied` on
# $HOME/.local/bin/path). Escalate only if the plain removal leaves something.
cleanup() {
  rm -rf "$WORK" 2>/dev/null
  [ -e "$WORK" ] && sudo -n rm -rf "$WORK" 2>/dev/null
  return 0
}
trap cleanup EXIT
mkdir -p "$WORK/nodebin"
BOOT_SH="$WORK/boot.sh"
cp "$SOURCE_BOOT" "$BOOT_SH"

# bare <name> <extra-env...> — run boot.sh on a host with no checkout AND no
# writable /opt, which is what an unprivileged user meets on a real floor.
# Echoes the exit status; output lands in $WORK/<name>.out.
#
# /opt is masked with a READ-ONLY MOUNT, not a chmod. Inside a user namespace
# the caller is uid 0 and holds CAP_DAC_OVERRIDE there, so it can write through
# any mode bits on a directory it owns — a chmod 555 would be ignored and the
# fallback would never be exercised. A read-only mount is enforced regardless of
# capability, so this behaves the same whether the suite is run by root or by an
# ordinary user. (Found by running as root: cases 1 and 2 both passed for the
# wrong reason, with the artifacts quietly landing in /opt.)
bare() {
  local name="$1"
  shift
  local home="$WORK/$name/home" cfg="$WORK/$name/cfg"
  mkdir -p "$home" "$cfg"
  "${NS[@]}" bash -c "
    mount --bind '$NODE_BIN' '$WORK/nodebin'
    mount -t tmpfs none /home/user
    mkdir -p /opt/bounded-boot 2>/dev/null
    mount -t tmpfs -o ro none /opt/bounded-boot
    export PATH='$WORK/nodebin':\$PATH
    cd '$home'
    env HOME='$home' CLAUDE_CONFIG_DIR='$cfg' XDG_CACHE_HOME='$home/.cache' $* \
      bash '$BOOT_SH'
  " >"$WORK/$name.out" 2>&1
  echo $?
}

cached() { ls -A "$WORK/$1/home/.cache/bounded-boot" 2>/dev/null | wc -l; }
said() { grep -q "$2" "$WORK/$1.out"; }

echo "boot.sh cold start — bare hosts in a mount namespace, real artifacts"
echo

# ── 1. THE REGRESSION, and the positive control for everything below ────────
# Before the fix this installed 0 of 7 and still said `ready`. It is also what
# makes cases 2 and 3 mean something: a boot.sh broken badly enough to install
# nothing anywhere would satisfy both refusal assertions on its own.
echo "1. no checkout, /opt not writable — must fall back and actually install"
rc="$(bare fallback)"
n="$(cached fallback)"
if [ "$rc" -eq 0 ] && [ "$n" -ge 6 ] && [ -f "$WORK/fallback/cfg/settings.json" ]; then
  ok "installed $n artifacts to the user cache, wrote settings.json, exit 0"
else
  no "cold start did not complete (exit $rc, $n artifacts, settings.json $([ -f "$WORK/fallback/cfg/settings.json" ] && echo present || echo absent))"
fi
if said fallback "not attached"; then
  ok "took the fetch branch (so the fallback is what was exercised)"
else
  no "did NOT take the fetch branch — this case proves nothing about it"
fi
if said fallback "ready"; then ok "reported ready"; else no "completed without reporting ready"; fi
echo

# ── 2. nothing writable anywhere ────────────────────────────────────────────
# The old code would carry on and fail every fetch. It must refuse instead, and
# say so: an operator who sees `ready` does not go looking.
echo "2. no writable cache anywhere — must REFUSE, non-zero"
ro="$WORK/readonly"
mkdir -p "$ro"
chmod 500 "$ro"
rc=0
"${NS[@]}" bash -c "
  mount --bind '$NODE_BIN' '$WORK/nodebin'
  mount -t tmpfs none /home/user
  mkdir -p /opt/bounded-boot 2>/dev/null
  mount -t tmpfs -o ro none /opt/bounded-boot
  mount -t tmpfs -o ro none '$ro'
  export PATH='$WORK/nodebin':\$PATH
  cd /tmp
  env HOME='$ro' CLAUDE_CONFIG_DIR='$ro/cfg' XDG_CACHE_HOME='$ro/.cache' bash '$BOOT_SH'
" >"$WORK/refuse.out" 2>&1 || rc=$?
if [ "$rc" -ne 0 ] && said refuse "REFUSED"; then
  ok "refused (exit $rc) and said so"
else
  no "did not refuse a host with nowhere to write (exit $rc)"
fi
if said refuse "ready"; then no "said 'ready' while refusing"; else ok "did not claim ready"; fi
echo

# ── 3. cache fine, fetches fail ─────────────────────────────────────────────
# The exact shape of the exe.dev failure, minus the cause: a writable directory
# and no artifacts in it. The verdict must name what is missing.
echo "3. writable cache but fetches fail — must report INCOMPLETE, non-zero"
rc="$(bare broken CURL_CA_BUNDLE=/nonexistent SSL_CERT_FILE=/nonexistent)"
if [ "$rc" -ne 0 ] && said broken "INCOMPLETE"; then
  ok "reported INCOMPLETE (exit $rc)"
else
  no "a run that installed nothing did not report INCOMPLETE (exit $rc)"
fi
if said broken "session-start-dispatch.mjs"; then
  ok "named the missing artifacts rather than failing vaguely"
else
  no "did not name what was missing"
fi
if said broken "ready"; then no "said 'ready' having installed nothing — #848 unfixed"; else ok "did not claim ready"; fi
echo

# ── 4. control: an attached checkout must NOT take this path ────────────────
# Without this, every case above would still pass if the fetch branch had been
# made unconditional — which would mean a session with a checkout silently
# running pinned copies instead of the tree it was given.
echo "4. control — a checkout present means no fetch branch at all"
fake="$WORK/attached"
mkdir -p "$fake/.github/.claude" "$fake/home" "$fake/cfg"
cp "$ROOT/.claude/session-start-dispatch.mjs" "$fake/.github/.claude/" 2>/dev/null
rc=0
env HOME="$fake/home" CLAUDE_CONFIG_DIR="$fake/cfg" CLAUDE_SESSION_ROOT="$fake" \
  bash "$BOOT_SH" >"$WORK/attached.out" 2>&1 || rc=$?
if said attached "not attached"; then
  no "took the FETCH branch despite a checkout being present"
else
  ok "used the checkout, did not fetch"
fi
echo

# ── 5. control: where /opt IS writable, it is still preferred ───────────────
# The managed-session shape, and the half of the fix that must NOT change. A
# fallback that always fired would scatter caches into per-user directories on
# hosts that have a perfectly good shared one.
echo "5. control — a writable /opt is still used in preference to the user cache"
mkdir -p "$WORK/optok/home" "$WORK/optok/cfg"
"${NS[@]}" bash -c "
  mount --bind '$NODE_BIN' '$WORK/nodebin'
  mount -t tmpfs none /home/user
  mkdir -p /opt/bounded-boot 2>/dev/null
  mount -t tmpfs none /opt/bounded-boot
  export PATH='$WORK/nodebin':\$PATH
  cd '$WORK/optok/home'
  env HOME='$WORK/optok/home' CLAUDE_CONFIG_DIR='$WORK/optok/cfg' XDG_CACHE_HOME='$WORK/optok/home/.cache' \
    bash '$BOOT_SH'
" >"$WORK/optok.out" 2>&1
if said optok "dispatcher at /opt/bounded-boot"; then
  ok "used /opt when it was writable"
else
  no "did not prefer a writable /opt — the fallback fires unconditionally"
fi
echo

# ── 6. THE CACHE IS READ, NOT JUST WRITTEN (#347) ───────────────────────────
# Every case above is cold by construction, so all five passed against a boot.sh
# whose cache was WRITE-ONLY: case 1's "n >= 6 artifacts present" is satisfied
# identically by a re-fetch and by a reuse. That is why this file could ship with
# #345 and prove nothing about the cache it had just given a second location.
#
# The discriminating move is to run TWICE and BREAK THE NETWORK on the second
# run — the same sabotage case 3 uses. With no network, the only way run 2 can
# reach `ready` is by reusing bytes already on disk. Against the pre-#347 boot.sh
# this fails loudly: every fetch_verified fails, MISSING fills, and it prints
# INCOMPLETE and exits 1.
#
# This works because bare()'s $home is a REAL directory under $WORK — only /opt
# and /home/user are tmpfs — so the user cache survives between invocations.
echo "6. second run with the network DEAD — must reuse the cache, not re-fetch"
rc="$(bare reuse)"
n="$(cached reuse)"
if [ "$rc" -eq 0 ] && [ "$n" -ge 6 ]; then
  ok "run 1 populated the cache ($n artifacts)"
else
  no "run 1 did not populate the cache (exit $rc, $n artifacts) — case 6 proves nothing"
fi
rc="$(bare reuse CURL_CA_BUNDLE=/nonexistent SSL_CERT_FILE=/nonexistent)"
if [ "$rc" -eq 0 ] && said reuse "ready" && ! said reuse "INCOMPLETE"; then
  ok "run 2 completed with no network — the cache was READ (exit $rc)"
else
  no "run 2 could not bootstrap offline from a populated cache (exit $rc) — the cache is write-only"
fi
echo

# ── 7. the hit is DIGEST-gated, not existence-gated ─────────────────────────
# A hit test that only checks `-f` would turn a corrupted or stale-PIN cache into
# a permanently poisoned one, silently — strictly worse than re-fetching. Corrupt
# one artifact, restore the network, and it must come back to its pinned digest.
#
# UNLIKE case 6, this one passes BEFORE the #347 fix as well as after, and that
# is correct rather than a weakness: the pre-fix code re-fetched unconditionally,
# so it could not reuse a corrupted file either. It guards the fix's future — a
# later "optimisation" that drops the sha256 compare for a bare `-f` — not the
# fix itself. Case 6 is the one that discriminates (measured: exit 1 before,
# exit 0 after). Same shape as #535's cache-control guard.
echo "7. a corrupted cached artifact must MISS and be re-fetched, not reused"
printf 'garbage' >> "$WORK/reuse/home/.cache/bounded-boot/register-mcp.mjs" 2>/dev/null
rc="$(bare reuse)"
want="$(sed -n 's/^SUM_register_mcp_mjs=//p' "$SOURCE_BOOT")"
got="$(sha256sum "$WORK/reuse/home/.cache/bounded-boot/register-mcp.mjs" 2>/dev/null | cut -d' ' -f1)"
if [ "$rc" -eq 0 ] && [ -n "$want" ] && [ "$got" = "$want" ]; then
  ok "corrupted artifact was re-fetched and hashes to its pin again"
else
  no "a corrupted cache was reused (exit $rc, got ${got:-none}, want ${want:-unknown})"
fi
echo

# ── 8. THE CLOBBER REGRESSION (#343) ────────────────────────────────────────
# boot.sh wrote $CFG/settings.json with `cat >` carrying a `hooks` block and
# nothing else, so every run erased whatever else that file held -- a user's
# `env`, their `permissions`, a second SessionStart hook -- and left a document
# that parses perfectly, which is why nothing ever reported it.
#
# Run against an ATTACHED checkout rather than a bare host on purpose: the fetch
# path cannot serve harness-settings.mjs until the pin names a commit containing
# it, so only the checkout exercises the MERGE itself rather than the refusal
# below. Both halves must hold, and they fail in opposite directions -- a merge
# that drops the user's keys, and a merge that forgets to install the hook.
echo "8. an existing settings.json must be MERGED, not overwritten"
keep="$WORK/keep"
mkdir -p "$keep/.github/.claude" "$keep/home" "$keep/cfg"
cp "$ROOT/.claude/session-start-dispatch.mjs" "$keep/.github/.claude/" 2>/dev/null
cp "$ROOT/.claude/harness-settings.mjs" "$keep/.github/.claude/" 2>/dev/null
cat > "$keep/cfg/settings.json" <<'SETTINGS'
{ "env": { "MINE": "cost is $5 and `date`" },
  "permissions": { "allow": ["Bash(bash .claude/org-repair.sh)"] },
  "hooks": { "SessionStart": [ { "matcher": "", "hooks": [ { "type": "command", "command": "bash mine.sh" } ] } ] } }
SETTINGS
env HOME="$keep/home" CLAUDE_CONFIG_DIR="$keep/cfg" CLAUDE_SESSION_ROOT="$keep" \
  bash "$BOOT_SH" >"$WORK/keep.out" 2>&1
merged="$keep/cfg/settings.json"
if grep -q 'cost is [$]5 and `date`' "$merged" && grep -q 'org-repair.sh' "$merged" && grep -q 'bash mine.sh' "$merged"; then
  ok "the user's env, permissions and own SessionStart hook all survived"
else
  no "the settings write clobbered content it did not put there"
fi
if grep -q 'session-start-dispatch.mjs' "$merged"; then
  ok "and the dispatcher hook was still installed"
else
  no "merged without installing the dispatcher hook -- preserved everything, achieved nothing"
fi
echo

# ── 9. the fail direction: no merger means DO NOT WRITE ─────────────────────
# The half that keeps case 8 from being a worse bug than the one it fixes. When
# harness-settings.mjs is absent -- a failed fetch, or the window between this
# landing and the pin bump -- the old code would still have clobbered. Refusing
# to merge is recoverable; a clobber is not, so the bytes must be untouched.
echo "9. no merger and an existing settings.json — must leave it byte-identical"
gone="$WORK/gone"
mkdir -p "$gone/.github/.claude" "$gone/home" "$gone/cfg"
cp "$ROOT/.claude/session-start-dispatch.mjs" "$gone/.github/.claude/" 2>/dev/null
printf '{ "env": { "MINE": "1" } }\n' > "$gone/cfg/settings.json"
cp "$gone/cfg/settings.json" "$WORK/gone.before"
env HOME="$gone/home" CLAUDE_CONFIG_DIR="$gone/cfg" CLAUDE_SESSION_ROOT="$gone" \
  bash "$BOOT_SH" >"$WORK/gone.out" 2>&1
if cmp -s "$WORK/gone.before" "$gone/cfg/settings.json"; then
  ok "left the file exactly as found"
else
  no "overwrote a settings file it had no way to merge"
fi
if said gone "could not merge"; then
  ok "and said so rather than failing silently"
else
  no "left the hook uninstalled without reporting it"
fi
echo

echo "boot cold start: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
