#!/usr/bin/env bash
# Install the toolpath CLI (`path`) so a session can share its own provenance
# to Pathbase (.github#112): `path share` turns a coding-agent session into a
# stable URL a PR can carry — the conversation, the tool calls and the dead
# ends, everything the diff cannot show. That URL is also candidate material
# for the session↔claim binding check captured in .github#113.
#
# Best-effort SessionStart hook (third in settings.json; the dispatcher fans it
# out to cloud sessions like the other two): a session without `path` is
# degraded, not broken, so every precondition is probed rather than assumed and
# every early exit is quiet and 0. The preconditions live OUTSIDE this script —
# the environment's network allowlist and a Pathbase token are environment-owner
# levers, documented in `.github-private` → docs/handoffs/toolpath-pathbase.md.
#
# Every status line goes to STDOUT, and that is load-bearing: SessionStart
# injects a hook's stdout into the session's context, while stderr goes only to
# the transcript. These lines were written to stderr at first, and the result
# was measured on the first live cloud session to run this hook (2026-08-07):
# the install fired correctly and the session could not see that it had — it
# had to go looking for the process to find out. A status line the session
# cannot read is not a status line. The audience here IS the agent: "your
# `path` is compiling, don't conclude it is missing" is precisely the fact that
# stops the next session from re-deriving this from scratch.
#
# Install is `cargo install path-cli`, not the vendor's `curl | bash`: the
# registry index carries per-crate checksums that cargo verifies locally, which
# keeps the same no-unverified-bytes posture the bootstrap's fetch_verified
# enforces. The cost is a multi-minute compile, so the install runs in the
# BACKGROUND and session start never waits on it; the log is the record. A
# digest-pinned prebuilt binary is the follow-up ratchet once egress is open
# and a digest can be captured (.github#112's last checkbox).
set -uo pipefail

LOG="${HOME:-/root}/.claude/toolpath-install.log"

# ── Pathbase lease (.github#115 step 3: hook wiring) ─────────────────────────
# If the environment carries the two lease levers, redeem them into the
# credentials file a stock `path` reads. Both levers are environment-owner
# config (the environment selector), and their absence is the normal case —
# skip silently, not degraded. The lease endpoint is the broker's /lease/<name>
# tier (infra), whose response IS credentials.json's shape ({url, token, user})
# by design, so this block is a fetch and a 0600 write, no assembly.
#
# Ordering: BEFORE the install/early-exit ladder, so a container whose `path`
# is still compiling in the background redeems now and is authed the moment the
# binary lands — and the already-installed branch below reports the auth state
# this block just established. A REAL login always wins: an existing
# credentials file is never overwritten (report it instead; `path auth logout`
# is the release).
CRED_DIR="${TOOLPATH_CONFIG_DIR:-${HOME:-/root}/.toolpath}"
CRED_FILE="$CRED_DIR/credentials.json"
if [ -n "${PATHBASE_LEASE_URL:-}" ] && [ -n "${PATHBASE_LEASE_KEY:-}" ]; then
  if [ -f "$CRED_FILE" ]; then
    echo "toolpath: lease levers set but credentials already exist — keeping the existing login ($CRED_FILE)"
  else
    # The broker records x-session-id as CLAIMED provenance (explicitly
    # unverified there); send what this runtime knows about itself.
    lease="$(curl -fsS --max-time 10 -X POST \
      -H "Authorization: Bearer $PATHBASE_LEASE_KEY" \
      -H "X-Session-Id: ${CLAUDE_CODE_SESSION_ID:-unknown}" \
      "$PATHBASE_LEASE_URL" 2>/dev/null || true)"
    if [ -n "$lease" ] && printf '%s' "$lease" | grep -q '"token"'; then
      mkdir -p "$CRED_DIR" && chmod 700 "$CRED_DIR"
      printf '%s' "$lease" > "$CRED_FILE" && chmod 600 "$CRED_FILE"
      echo "toolpath: Pathbase lease redeemed — credentials at $CRED_FILE (release: rotate the lease key, or \`path auth logout\`)"
    else
      # Fail soft and SAY so: a refused lease is an environment/broker state
      # the session cannot fix, but silence here is how #117's lesson repeats.
      echo "toolpath: Pathbase lease REFUSED or unreachable ($PATHBASE_LEASE_URL) — sharing will be anonymous. Check the broker's LEASE_KEYS entry and the environment's lease key (.github#115)."
    fi
  fi
fi

# Already present — attached image, a prior container hook, or a future baked
# image. Report rather than reinstall; auth state is the useful part.
if command -v path >/dev/null 2>&1; then
  ver="$(path --version 2>/dev/null || echo 'path (version unknown)')"
  auth="$(path auth status 2>&1 | head -1 || true)"
  echo "toolpath: $ver — auth: ${auth:-unknown}"
  exit 0
fi

# A background install from an earlier hook in this container may still be
# compiling — do not stack a second one on top of it.
if pgrep -f "cargo install path-cli" >/dev/null 2>&1; then
  echo "toolpath: install already running — log: $LOG"
  exit 0
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "toolpath: no cargo in this image — skipping install (see toolpath-pathbase.md)"
  exit 0
fi

# Cheap probe before committing to a compile. index.crates.io is the sparse
# registry endpoint every `cargo install` starts at. Verified OPEN from a live
# cloud session 2026-08-07 (the proxy's allowlist is path-shaped: the crates.io
# API root 403s while cargo's index + download paths pass — probe table on
# .github#112); the probe stays because other environments' policies differ,
# and a closed registry should cost one line, not a hung compile.
if ! curl -fs --max-time 5 -o /dev/null https://index.crates.io/config.json; then
  echo "toolpath: crates.io egress blocked — not installing. The fix is the environment network allowlist, not this script (.github#112)."
  exit 0
fi

mkdir -p "$(dirname "$LOG")"
echo "toolpath: installing path-cli in the background — log: $LOG"
nohup sh -c '
  if cargo install path-cli; then
    echo "toolpath-install: done — $(path --version 2>/dev/null || echo installed)"
  else
    echo "toolpath-install: FAILED — see the cargo output above"
  fi
' >>"$LOG" 2>&1 &

exit 0
