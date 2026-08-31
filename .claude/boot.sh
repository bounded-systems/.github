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
# PIN is a COMMIT SHA. The SHA-256s are the second, independent check: naming a
# commit in the URL only guarantees immutability IF the endpoint is honest,
# because that SHA is a path component the client never verifies. These digests
# are checked locally, so a wrong-bytes response is refused whatever served it.
#
# That property is why the artifacts can be proxied at all. Since
# .github-private#492 the fetch goes to boot.bounded.tools/artifact/$PIN/$f,
# which fetches raw.githubusercontent server-side and streams the bytes through
# — moving that egress off every session and onto one owned Worker. The Worker
# holds no pins and performs no digest check, deliberately: a second pin source
# is a second thing that can disagree with git, and the refusal below is the one
# that must stay authoritative. Nothing about the trust argument changes with the
# host, which is precisely the point — this client never trusted the host.
#
# These digests ARE fetched now — this file arrives via the one-line field —
# and that is sound only because the field refuses this file unless it hashes to
# the digest the channel manifest names (channel/front-desk.json, written only by
# the OIDC-pinned boot-manifest lane on main; since #192 there is no
# ORG_BOOT_SHA256 in the dialog at all). The root of trust moved from this block
# to that manifest; these lines are the second link of the chain, not its anchor.
# See "Why the chain has three links" in README.md.
#
# PIN and the digests are ONE PAIR — bump them together or the bootstrap refuses
# a legitimate file. Do not hand-edit them; regenerate:
#
#   node .claude/gen-bootstrap-pin.mjs <commit>
#
# On main this is automatic: org-defaults.yml regenerates on push and opens the
# bump PR, because the pin can only name a merge commit once that commit exists.
# The equivalent by hand, against the endpoint rather than the git objects:
#   for f in session-start-dispatch.mjs register-mcp.mjs stop-hook-git-check.sh setup-toolpath.sh chat-fetch.sh verb-server.mjs; do
#     curl -fsSL "https://boot.bounded.tools/artifact/$PIN/$f" | sha256sum
#   done
PIN=e44409bf093ef0920d5d49f0a990db98ece092f1
SUM_session_start_dispatch_mjs=f97ebc15b19a77bd21308229a355fbd5a0f767984063c13ded470dd3e0d40125
SUM_register_mcp_mjs=40197da6e3dc5c771856a437b6a9e944ce530bb69f2b2724bd2513c281b84c1b
SUM_stop_hook_git_check_sh=712c2a8041bbbec27b05e7c702a5654d0b882c4545288b065550276fc5c77562
SUM_setup_toolpath_sh=dabcd89df0467f9361c0c51d72cd2989aa8b91dfa1762e7c0f6a170a72a9ffa2
SUM_chat_fetch_sh=ef4a577aadb27bca3b76859024acc31184c33e1896b3c469a71b80ff5afc78d5
SUM_verb_server_mjs=258baba3b156a5939c72c38e539d47d415d2e3014e2c16d7954b134d17cabcb1

# Fetch one file and REFUSE it unless it hashes to the pinned digest. Downloads
# to a temp name and only moves it into place after the check, so an unverified
# file never sits at a path something might execute.
fetch_verified() {
  local f="$1" want="$2" got
  curl -fsSL --retry 2 \
    "https://boot.bounded.tools/artifact/$PIN/$f" \
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
  # The verbs (#325). These two are the same shape of gap as setup-toolpath.sh
  # above and a step further: they are not just DECLARED nowhere a detached
  # session can see, they do not EXIST there. `verb-server.mjs` is the MCP stdio
  # server this org's .mcp.json names, and `chat-fetch.sh` is what its read_chat
  # tool shells out to — fetching the server without the script would register a
  # tool that fails on first use, which is worse than no tool.
  fetch_verified chat-fetch.sh              "$SUM_chat_fetch_sh"
  fetch_verified verb-server.mjs            "$SUM_verb_server_mjs"

  # Make the cache a REGISTRATION SOURCE, not just a pile of files (#325).
  # Fetching verb-server.mjs does not make it reachable: register-mcp.mjs
  # registers what an attached repo's .mcp.json DECLARES, and a session without
  # `.github` has no such file — so before this the fetched server sat on disk
  # with nothing pointing at it. This is the declaration, written into the cache
  # so register-mcp.mjs finds it there exactly as it finds a repo's.
  #
  # Written ONLY when the fetch actually landed: a declaration naming a server
  # that is not there registers a tool whose every call fails, and a named
  # mechanism that does not resolve is worse than an absent one.
  #
  # Inside this branch, never after it: on the ATTACHED path $BOOT is the
  # checkout's .claude/, where this would drop an untracked file into the very
  # worktree the Stop hook reports on — and be redundant besides, since the repo
  # already declares this server in its own .mcp.json (which WINS over this copy;
  # register-mcp.mjs states that precedence).
  #
  # The terminator is QUOTED, unlike the settings heredoc below: `args` is
  # deliberately relative, and register-mcp.mjs absolutizes it against the
  # directory the declaration was found in.
  if [ -f "$BOOT/verb-server.mjs" ]; then
    cat > "$BOOT/.mcp.json" <<'JSON'
{
  "mcpServers": {
    "bounded-verbs": {
      "type": "stdio",
      "command": "node",
      "args": ["verb-server.mjs"]
    }
  }
}
JSON
  else
    echo "bootstrap: WARN verb-server.mjs missing — the bounded-verbs tools will not be registered"
  fi
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
