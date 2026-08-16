#!/usr/bin/env bash
# bounded-systems org bootstrap check/repair — the org CLAUDE.md step-1 block
# as a committed file, so .claude/settings.json can pre-approve exactly this
# invocation: `bash .claude/org-repair.sh` (#491). Canonical logic lives in
# bounded-systems/.github-private CLAUDE.md; adopt-claude-harness keeps this
# copy in sync.
#
# Where the expected digest comes from (#192, 2026-08-16): the CHANNEL MANIFEST
# — boot.bounded.tools/channel/front-desk.json, written only by the OIDC-pinned
# boot-manifest lane on main — with the legacy dialog variable ORG_BOOT_SHA256
# honored FIRST while it still exists, because a dialog that pins a digest is a
# deliberate hold on a specific version and must not be silently outvoted.
# Either way every byte is verified against the resolved digest before
# execution, and this script REFUSES rather than running anything unverified.
set -uo pipefail
FETCH="curl -fsSL --retry 3 --retry-connrefused --retry-max-time 60 --connect-timeout 5 --max-time 30"
S="${ORG_BOOT_SHA256:-}"
[ -n "$S" ] || S="$($FETCH https://boot.bounded.tools/channel/front-desk.json 2>/dev/null \
  | sed -n 's/.*"boot":"\([0-9a-f]\{64\}\)".*/\1/p')"
[ -n "$S" ] || {
  echo "org-repair: no ORG_BOOT_SHA256 in the environment and the channel manifest is unreachable — nothing to verify against; installing nothing"
  exit 0
}
R="${CLAUDE_SESSION_ROOT:-}"                     # resolve the checkout root — never assume /home/user
[ -f "$R/.github/.claude/boot.sh" ] || R="$PWD"
[ -f "$R/.github/.claude/boot.sh" ] || R="${PWD%/*}"
[ -f "$R/.github/.claude/boot.sh" ] || R=/home/user
C="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
if cmp -s "$C/stop-hook-git-check.sh" "$R/.github/.claude/stop-hook-git-check.sh"; then
  echo "bootstrap in effect"
  exit 0
fi
B="$R/.github/.claude/boot.sh"   # attached checkout — same bytes, no egress
echo "$S  $B" | sha256sum -c --status - 2>/dev/null || {
  B=""
  $FETCH "https://boot.bounded.tools/$S.sh" -o /tmp/boot.sh \
    && echo "$S  /tmp/boot.sh" | sha256sum -c --status - && B=/tmp/boot.sh; }
if [ -n "$B" ]; then
  CLAUDE_SESSION_ROOT="$R" bash "$B"
  D="$R/.github/.claude/session-start-dispatch.mjs"
  [ -f "$D" ] || D=/opt/bounded-boot/session-start-dispatch.mjs
  CLAUDE_SESSION_ROOT="$R" node "$D"
else
  echo "org-repair: REFUSED — no copy matched the expected digest $S; installing nothing"
  exit 1
fi
