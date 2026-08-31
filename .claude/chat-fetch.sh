#!/usr/bin/env bash
# chat-fetch.sh — one-command direct access to a shared Claude chat (#313).
#
# A Claude mobile/web chat never touches a filesystem session tooling can see,
# and a session cannot reach claude.ai at all — the bounded.tools relay
# (bounded.tools#50/#56/#59) closes that from the one place with the egress.
# This script is the session-side last inch: share link in, readable transcript
# (or toolpath Graph JSON, or an incepted on-disk session) out.
#
#   chat-fetch.sh <https://claude.ai/share/UUID>            # transcript (path p render md)
#   chat-fetch.sh <url> --json                              # raw toolpath Graph JSON
#   chat-fetch.sh <url> --incept [project-dir]              # land it in ~/.claude/projects
#
# Bearer: $CLAUDE_RELAY_BEARER, else ~/.relay-lease-bearer — the file the
# machine-to-machine grant loop leaves behind (bounded.tools deploy.yml,
# grant_relay_lease, age-encrypted hand-off). No bearer is a refusal that names
# the grant path, never a bare error.
#
# CHAT_RELAY_URL exists for the tests' stub server only — the default is the
# deployed relay and sessions should never need to set it.
set -euo pipefail

RELAY_URL="${CHAT_RELAY_URL:-https://hooks.bounded.tools/claude/sessions}"

usage() {
  echo "usage: chat-fetch.sh <claude.ai share URL> [--json | --incept [project-dir]]" >&2
  exit 2
}

[ $# -ge 1 ] || usage
SHARE_URL="$1"
shift
MODE="render"
PROJECT=""
case "${1:-}" in
  "") ;;
  --json) MODE="json"; shift ;;
  --incept)
    MODE="incept"
    shift
    if [ $# -ge 1 ]; then PROJECT="$1"; shift; fi
    ;;
  *) usage ;;
esac
# Surplus arguments refuse like a bad flag does (#318): silently ignoring
# them made `--json extra` and `--frobnicate` behave differently for the
# same class of caller error.
[ $# -eq 0 ] || usage

# The relay validates for real, but this check is also what makes the JSON
# body construction below injection-proof (#318): the FULL match — scheme,
# host, /share/, a bare UUID, optional trailing slash — admits no quote,
# backslash, or brace, so interpolating the URL into the body cannot alter
# its structure. Loosen this only together with how the body is built.
printf '%s' "$SHARE_URL" | grep -Eq '^https://claude\.ai/share/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/?$' || {
  echo "chat-fetch: not a claude.ai share URL: $SHARE_URL" >&2; exit 2; }

BEARER="${CLAUDE_RELAY_BEARER:-}"
if [ -z "$BEARER" ] && [ -r "$HOME/.relay-lease-bearer" ]; then
  BEARER="$(cat "$HOME/.relay-lease-bearer")"
fi
if [ -z "$BEARER" ]; then
  echo "chat-fetch: no relay bearer. Set CLAUDE_RELAY_BEARER or write ~/.relay-lease-bearer —" >&2
  echo "  grant one machine-to-machine: dispatch bounded.tools deploy.yml with" >&2
  echo "  grant_relay_lease=<name> and an ephemeral age recipient, approve the Face ID," >&2
  echo "  decrypt the run's output with the ephemeral identity (bounded.tools#62)." >&2
  exit 1
fi

if [ "$MODE" != "json" ] && ! command -v path >/dev/null 2>&1; then
  echo "chat-fetch: \`path\` is not on PATH (setup-toolpath.sh installs it in the background" >&2
  echo "  at session start — it may still be compiling). Meanwhile --json works without it." >&2
  exit 1
fi

# Body and status in one round-trip; the status rides the last line so the
# relay's own refusal sentence (unknown lease, withdrawn share, door refusal)
# reaches the user verbatim instead of a bare exit code.
GRAPH="$(mktemp)"
trap 'rm -f "$GRAPH"' EXIT
# The bearer rides a header FILE via -H @-, never argv (#318): a -H
# "authorization: Bearer ..." argument is visible to every same-user process
# for the duration of the request. stdin is already spoken for by nothing
# here, so the heredoc-fed @- form costs nothing.
HTTP_CODE="$(curl -sS --max-time 60 -o "$GRAPH" -w '%{http_code}' -X POST "$RELAY_URL" \
  -H @- \
  -H 'content-type: application/json' \
  -d "{\"share_url\":\"$SHARE_URL\"}" <<EOF
authorization: Bearer $BEARER
EOF
)"
if [ "$HTTP_CODE" != "200" ]; then
  echo "chat-fetch: relay answered HTTP $HTTP_CODE:" >&2
  cat "$GRAPH" >&2
  echo >&2
  exit 1
fi

case "$MODE" in
  json) cat "$GRAPH" ;;
  render) path p render md --input "$GRAPH" ;;
  incept)
    if [ -n "$PROJECT" ]; then
      path p incept claude --input "$GRAPH" --project "$PROJECT"
    else
      path p incept claude --input "$GRAPH"
    fi
    ;;
esac
