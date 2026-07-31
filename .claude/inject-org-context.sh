#!/usr/bin/env bash
# SessionStart hook — inject the bounded-systems canonical Claude context.
# Canonical source: bounded-systems/.github-private -> claude/context.md
# Fail OPEN: anything that goes wrong yields no context, never a blocked session.
set -uo pipefail
command -v jq >/dev/null 2>&1 || exit 0

path='repos/bounded-systems/.github-private/contents/claude/context.md'
ctx=""

# 0) An ATTACHED checkout, if the session has one. Free: no network, no
#    credential, no clone. This is first because it is the only source that works
#    in a cloud session at all — sources 1-3 were all measured failing there on
#    2026-07-31 (gh absent; the clone unauthenticated, "could not read Password
#    for http://local_proxy@127.0.0.1"; the curl fallback presenting the
#    proxy-local GH_TOKEN to api.github.com, which rejects it). The hook failed
#    open every time, so the org context has silently never loaded in the cloud.
#
#    Attaching .github-private to the session is what makes this reachable, and
#    without this block attaching it changes nothing — the hook would still go
#    to the network for a file already sitting next door.
#
#    Resolved from this script's own path (<root>/.github/.claude/…), so it does
#    not depend on cwd, and overridable for a checkout that lives elsewhere.
local_ctx="${ORG_CONTEXT_FILE:-$(cd "$(dirname "$0")/../.." 2>/dev/null && pwd)/.github-private/claude/context.md}"
if [ -r "$local_ctx" ]; then
  ctx="$(cat "$local_ctx" 2>/dev/null || true)"
fi

# 1) gh API — local dev, or cloud only if gh is installed AND a token is present.
if [ -z "$ctx" ] && command -v gh >/dev/null 2>&1; then
  ctx="$(gh api "$path" -H 'Accept: application/vnd.github.raw' 2>/dev/null || true)"
fi

# 2) Cloud-native (Claude Code on the web): no token lives in the container and
#    gh isn't pre-installed, so clone via the GitHub proxy. Access follows the
#    session's GitHub auth — maintainers succeed, outside contributors fail open.
if [ -z "$ctx" ] && command -v git >/dev/null 2>&1; then
  d="$(mktemp -d 2>/dev/null || echo "/tmp/orgctx.$$")"
  if git clone --depth 1 --filter=blob:none --sparse \
       https://github.com/bounded-systems/.github-private.git "$d" >/dev/null 2>&1; then
    git -C "$d" sparse-checkout set claude/context.md >/dev/null 2>&1 || true
    [ -f "$d/claude/context.md" ] && ctx="$(cat "$d/claude/context.md")"
  fi
  rm -rf "$d" 2>/dev/null || true
fi

# 3) curl fallback if a PAT is provided out-of-band (e.g. GH_TOKEN in env config).
if [ -z "$ctx" ]; then
  tok="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
  if [ -n "$tok" ] && command -v curl >/dev/null 2>&1; then
    ctx="$(curl -fsSL -H "Authorization: Bearer $tok" -H 'Accept: application/vnd.github.raw' \
            "https://api.github.com/$path" 2>/dev/null || true)"
  fi
fi

[ -z "$ctx" ] && exit 0   # fail open
jq -n --arg c "$ctx" \
  '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$c}}'