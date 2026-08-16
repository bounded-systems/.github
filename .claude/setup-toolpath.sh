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
# every early exit is quiet and 0. The one precondition lives OUTSIDE this
# script — the environment's network allowlist (crates.io, for the install) —
# documented in `.github-private` → docs/handoffs/toolpath-pathbase.md. There
# is NO token lever anymore: sharing goes through the pathbase door, which
# keeps every credential server-side (.github#180).
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
# enforces. `--locked` builds the exact dependency set path-cli's own lockfile
# pins, not whatever the registry resolves to at install time — an unlocked
# install compiled zune-jpeg 0.5.15, broken as published, and failed
# (.github#121). The cost is a multi-minute compile, so the install runs in the
# BACKGROUND and session start never waits on it; the log is the record. A
# digest-pinned prebuilt binary is the follow-up ratchet once egress is open
# and a digest can be captured (.github#112's last checkbox).
set -uo pipefail

LOG="${HOME:-/root}/.claude/toolpath-install.log"

# ── The pathbase DOOR (.github#180) — how a session shares its transcript ────
# The lease-key apparatus that lived here (2026-08-07 → 2026-08-16) is GONE,
# and deliberately: PATHBASE_LEASE_KEY was retired from the dialog outright
# (.github#179 — the redeem host was never on the egress allowlist, so the key
# could not produce a login in any session; rotating it would have replaced one
# exposed shared secret with another). Nothing replaced it IN THE SESSION,
# which is the point of the door: no credential reaches a session in any form.
#
# Sharing now goes through the pathbase-door Worker on pathbase.bounded.tools
# (infra cloudflare/pathbase-door — write-only gateway, claim-gated, the pat
# stays vaulted in the Worker). The claim rides in the base URL, so the recipe
# is per-claim, printed here for the session to use once it holds one:
#
#   path p import claude --project "$PWD" --session "<session-id>"
#   PATHBASE_URL="https://pathbase.bounded.tools/c/<repo>/<issue>" \
#     path p export pathbase --anon --input <doc-id>
#
# --anon is what makes the STOCK CLI hit the door's one route; the door
# upgrades the call with the org credential server-side and the upload lands
# unlisted in the org pathstash — NOT on the vendor's public anonymous
# endpoint. No live Front Desk claim on <repo>#<issue> → 403. The door posts
# the share URL back on the claim thread itself (its own testimony).
PATHBASE_DOOR_URL="${PATHBASE_DOOR_URL:-https://pathbase.bounded.tools}"
echo "toolpath: share through the door — PATHBASE_URL=\"$PATHBASE_DOOR_URL/c/<repo>/<issue>\" path p export pathbase --anon --input <doc-id> (needs a live claim; .github#180)"

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
  if cargo install path-cli --locked; then
    echo "toolpath-install: done — $(path --version 2>/dev/null || echo installed)"
  else
    echo "toolpath-install: FAILED — see the cargo output above"
  fi
' >>"$LOG" 2>&1 &

exit 0
