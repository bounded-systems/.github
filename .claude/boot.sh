#!/usr/bin/env bash
# bounded-systems session bootstrap — stage 1, FETCHED.
#
# The environment's setup-script field is ONE LINE (canonical text in
# README.md): it fetches this file from $ORG_BOOT_URL and refuses to run it
# unless it hashes to the dialog-recorded $ORG_BOOT_SHA256. So this file is
# reviewed, tested and gated in-repo, and the field never carries logic —
# logic in the field is unreviewable and ungateable, infra#122's failure mode.
set -uo pipefail

# Where the repo checkouts land. Not a constant: HOME and the session root are
# unrelated trees on some runners (HOME=/root with checkouts under /home/user was
# measured 2026-08-15), and a self-hosted runner puts checkouts under its own base
# directory. The caller may say (CLAUDE_SESSION_ROOT); otherwise probe, with the
# historical layout as the last resort. Guards + assignments only — parseSteps in
# gen-bootstrap-pin.mjs has no verb for loops, and needs none for this.
ROOT="${CLAUDE_SESSION_ROOT:-}"
[ -d "$ROOT/.github/.claude" ] || ROOT="$PWD"
[ -d "$ROOT/.github/.claude" ] || ROOT="${PWD%/*}"
[ -d "$ROOT/.github/.claude" ] || ROOT=/home/user
BOOT="$ROOT/.github/.claude"                       # preferred: the attached checkout

# --- the trust anchor -------------------------------------------------------
# PIN is a COMMIT SHA (content-addressed, so the URL is immutable). The SHA-256s
# are the second, independent check: pinning the URL only guarantees immutability
# IF the endpoint is honest, because the SHA in the URL is a path component the
# client never verifies. These digests are checked locally, so a wrong-bytes
# response is refused whatever served it.
#
# These digests ARE fetched now — this file arrives via the one-line field —
# and that is sound only because the field refuses this file unless it hashes
# to the dialog-recorded ORG_BOOT_SHA256, the one value that is not fetched.
# The root of trust moved from this block to that dialog pair; these lines are
# the second link of the chain, not its anchor. See "Why the chain has three
# links" in README.md.
#
# PIN and the digests are ONE PAIR — bump them together or the bootstrap refuses
# a legitimate file. Do not hand-edit them; regenerate:
#
#   node .claude/gen-bootstrap-pin.mjs <commit>
#
# On main this is automatic: org-defaults.yml regenerates on push and opens the
# bump PR, because the pin can only name a merge commit once that commit exists.
# The equivalent by hand, against the endpoint rather than the git objects:
#   for f in session-start-dispatch.mjs register-mcp.mjs stop-hook-git-check.sh setup-toolpath.sh; do
#     curl -fsSL "https://raw.githubusercontent.com/bounded-systems/.github/$PIN/.claude/$f" | sha256sum
#   done
PIN=840feed81037a34f357cd4f27aab6d2dab24f83c
SUM_session_start_dispatch_mjs=15808158e7665d703414547b5e6dd9a4859a7a75838f75dbf4e22b684ddbba6e
SUM_register_mcp_mjs=36710119312b6caa9065f9d89c8f661ed750cfc16657528437ad0f60d67418c6
SUM_stop_hook_git_check_sh=52890becf4ddd223ac5331aa302d6fe82bca9c966b15520a6a48700c047d8546
SUM_setup_toolpath_sh=051a13a277bb7b46aa57451c1d5800ae6d9ecec4a532370846df77151d70df52

# Fetch one file and REFUSE it unless it hashes to the pinned digest. Downloads
# to a temp name and only moves it into place after the check, so an unverified
# file never sits at a path something might execute.
fetch_verified() {
  local f="$1" want="$2" got
  curl -fsSL --retry 2 \
    "https://raw.githubusercontent.com/bounded-systems/.github/$PIN/.claude/$f" \
    -o "$BOOT/$f.unverified" || { echo "bootstrap: WARN could not fetch $f"; return 1; }
  got="$(sha256sum "$BOOT/$f.unverified" | cut -d' ' -f1)"
  if [ "$got" != "$want" ]; then
    echo "bootstrap: REFUSING $f — sha256 mismatch, not executing it"
    echo "bootstrap:   expected $want"
    echo "bootstrap:   got      $got"
    rm -f "$BOOT/$f.unverified"
    return 1
  fi
  mv "$BOOT/$f.unverified" "$BOOT/$f"
}

# The attached checkout is NOT digest-checked: it arrives over the session's git
# proxy with git's own integrity, and it may legitimately be NEWER than PIN — so
# comparing it against these digests would fail on every merge. Only the fetched
# copy is verified, because only it is fetched.
if [ ! -f "$BOOT/session-start-dispatch.mjs" ]; then
  echo "bootstrap: .github not attached — fetching pinned copies ($PIN)"
  BOOT=/opt/bounded-boot
  mkdir -p "$BOOT"
  fetch_verified session-start-dispatch.mjs "$SUM_session_start_dispatch_mjs"
  fetch_verified register-mcp.mjs           "$SUM_register_mcp_mjs"
  fetch_verified stop-hook-git-check.sh     "$SUM_stop_hook_git_check_sh"
  # The third SessionStart hook. Unlike the other two files it is not something
  # this script installs or invokes — the dispatcher's MANIFEST runs it — but it
  # is fetched here because it is reachable NO other way on this path: it is
  # declared in this repo's .claude/settings.json, which a session without
  # `.github` attached does not have. Measured 2026-08-16: no script, no install
  # log, no `path`, and nothing saying so, while cargo and the crates.io index
  # were both fine. Absence is the one state a best-effort hook cannot report
  # (#522).
  fetch_verified setup-toolpath.sh          "$SUM_setup_toolpath_sh"
fi

# Both scripts self-locate from their own path, which is correct in the attached
# checkout and WRONG in the fetch cache. Naming the root explicitly is harmless in
# the first case and load-bearing in the second.
#
# The heredoc terminator below is deliberately unquoted: $ROOT and $BOOT must
# interpolate, and nothing else in that JSON is $-shaped. Escape any literal $
# you add. (Spelled out in prose because a literal here-doc operator in this
# comment would trip parseSteps' heredoc detection in gen-bootstrap-pin.mjs.)
CFG="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"          # where the harness reads settings
mkdir -p "$CFG"
if [ -f "$BOOT/session-start-dispatch.mjs" ]; then
  cat > "$CFG/settings.json" <<JSON
{
  "hooks": {
    "SessionStart": [
      { "matcher": "", "hooks": [ { "type": "command",
        "command": "CLAUDE_SESSION_ROOT=$ROOT node $BOOT/session-start-dispatch.mjs" } ] }
    ]
  }
}
JSON
else
  echo "bootstrap: WARN no dispatcher — repo SessionStart hooks will not run"
fi

# Keep this call. The dispatcher re-runs register-mcp.mjs as a fallback (#84), but
# only THIS one is ordered before Claude Code launches and reads the tool list.
if [ -f "$BOOT/register-mcp.mjs" ]; then
  CLAUDE_SESSION_ROOT="$ROOT" node "$BOOT/register-mcp.mjs" || true
else
  echo "bootstrap: WARN register-mcp.mjs missing — MCP tools will not be registered"
fi

# Start the toolpath install (#522). The same shape as the call above and for the
# same reason: this is the ONLY path that reaches a session without `.github`
# attached, because the hook that would otherwise run it is declared in that
# repo's .claude/settings.json. The script backgrounds its own compile, so this
# costs one egress probe, and it is idempotent — the SessionStart hook and the
# dispatcher's manifest both re-enter it and both no-op while a build is in
# flight. The dispatcher is what REPORTS an install that could not happen; this
# line is what makes it possible in the first place.
if [ -f "$BOOT/setup-toolpath.sh" ]; then
  bash "$BOOT/setup-toolpath.sh" || true
else
  echo "bootstrap: WARN setup-toolpath.sh missing — no provenance sharing (path) in this session"
fi

# Replace the platform's Stop hook with the infra#112 fix. The stock one scopes
# its check to `origin/<branch>..HEAD`, which after a squash merge includes
# GitHub's own merge commit — so it warned "Unverified" after EVERY merge and
# advised an --amend that would rewrite already-merged history. Copied rather than
# executed here, but still digest-verified above when fetched, so the fallback
# path installs the same bytes the attached checkout would.
if [ -f "$BOOT/stop-hook-git-check.sh" ] && [ -d "$CFG" ]; then
  cp "$BOOT/stop-hook-git-check.sh" "$CFG/stop-hook-git-check.sh"
  chmod +x "$CFG/stop-hook-git-check.sh"
  echo "bootstrap: stop-hook patched (infra#112)"
fi

echo "bootstrap: ready — dispatcher at $BOOT"
