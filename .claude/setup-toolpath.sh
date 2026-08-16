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
# BACKGROUND and session start never waits on it; the log is the record.
#
# That compile is now the FALLBACK, not the plan (#116). A digest-pinned
# prebuilt binary is tried first — see "The prebuilt ratchet" below — which is
# what lets `index.crates.io` and `static.crates.io` leave the cloud-environment
# dialog. The compile stays because a session that cannot reach the release
# asset must still end up with a working `path`, and because the day the pinned
# version is wrong, "slow" is a far better failure than "absent".
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

# ── The prebuilt ratchet (#116) ──────────────────────────────────────────────
# Tried BEFORE the compile, because it is the whole point: a session gets `path`
# in one download instead of minutes of cargo, and — the reason this outranks
# convenience — the two crates.io domains in the cloud-environment dialog exist
# for nothing but that compile (.github-private#439). Retiring them needs the
# common case to stop touching the registry at all.
#
# Same posture as the bootstrap's fetch_verified, for the same reason: the bytes
# are fetched from a release asset, and the digest that can refuse them is
# recorded HERE, in git, where they are not fetched from. A digest served beside
# the bytes it describes would prove nothing. So an asset that does not hash to
# TOOLPATH_SHA256 is deleted unexecuted and the compile takes over.
#
# TOOLPATH_SHA256 EMPTY is a normal state, not a defect: the digest cannot exist
# until a build has been published, and it must arrive through a reviewed diff
# rather than from the lane that publishes the bytes. Empty simply means "no
# prebuilt recorded yet" and the script goes straight to the compile — the
# arrival state this file ships in. Dispatch `toolpath-prebuild.yml`, then record
# the pair it prints. VERSION and SHA256 are ONE PAIR — move them together.
# A 4th version component counts republishes of the same path-cli version:
# .github has immutable releases, so a tag that published wrong is burned
# forever and the fix is a fresh tag (0.16.1.2 = second publish of 0.16.1;
# toolpath-v0.16.1 is the standing tombstone — see toolpath-prebuild.yml).
TOOLPATH_VERSION=0.16.1.2
TOOLPATH_SHA256=92587827c244751209a7d193ac054bbcd0a7c3741932292a316812c669cd8809
TOOLPATH_TRIPLE=x86_64-unknown-linux-gnu
# ~/.local/bin, not ~/.cargo/bin: the prebuilt path must not depend on cargo
# existing, and this directory is already first on the front-desk image's PATH
# (measured 2026-08-16). Overridable so a test can point it somewhere harmless.
TOOLPATH_BIN_DIR="${TOOLPATH_BIN_DIR:-$HOME/.local/bin}"

# Fetch the pinned binary and REFUSE it unless it hashes to the recorded digest.
# Downloads to an .unverified name and only becomes executable AFTER the check,
# so unverified bytes never sit at a path something might run.
install_prebuilt() {
  local asset url tmp got
  [ -n "$TOOLPATH_SHA256" ] || {
    echo "toolpath: no prebuilt digest recorded for $TOOLPATH_VERSION — using the compile (dispatch toolpath-prebuild.yml to record one, #116)"
    return 1
  }
  case "$(uname -s)/$(uname -m)" in
    Linux/x86_64) ;;
    *)
      echo "toolpath: no prebuilt for $(uname -s)/$(uname -m) — using the compile"
      return 1
      ;;
  esac

  asset="path-$TOOLPATH_VERSION-$TOOLPATH_TRIPLE"
  url="https://github.com/bounded-systems/.github/releases/download/toolpath-v$TOOLPATH_VERSION/$asset"
  mkdir -p "$TOOLPATH_BIN_DIR" 2>/dev/null || return 1
  tmp="$TOOLPATH_BIN_DIR/path.unverified"

  # Release assets of an ATTACHED repo are served by the session proxy (measured
  # 2026-08-16: this URL shape 404s rather than 403s from a live cloud session).
  # A session without `.github` attached cannot reach them and falls through to
  # the compile — #116's accepted degradation, stated rather than hidden.
  curl -fsSL --retry 2 --max-time 120 "$url" -o "$tmp" 2>/dev/null || {
    echo "toolpath: prebuilt $TOOLPATH_VERSION not reachable — using the compile"
    rm -f "$tmp"
    return 1
  }

  got="$(sha256sum "$tmp" | cut -d' ' -f1)"
  if [ "$got" != "$TOOLPATH_SHA256" ]; then
    echo "toolpath: REFUSING the prebuilt — sha256 mismatch, not executing it"
    echo "toolpath:   expected $TOOLPATH_SHA256"
    echo "toolpath:   got      $got"
    rm -f "$tmp"
    return 1
  fi

  chmod +x "$tmp" && mv "$tmp" "$TOOLPATH_BIN_DIR/path"
}

if install_prebuilt; then
  echo "toolpath: $("$TOOLPATH_BIN_DIR/path" --version 2>/dev/null || echo "path $TOOLPATH_VERSION") — prebuilt, digest-verified (#116)"
  case ":$PATH:" in
    *":$TOOLPATH_BIN_DIR:"*) ;;
    *) echo "toolpath: NOTE $TOOLPATH_BIN_DIR is not on PATH — 'path' is installed but not callable" ;;
  esac
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

# Cheap probe before committing to a compile. A closed registry should cost one
# line, not a failed build in a log nobody reads.
#
# BOTH hosts are probed, and that is the whole point (#534). `cargo install`
# starts at the sparse index (index.crates.io) but downloads every .crate from
# static.crates.io, so either one being shut is fatal — while probing only the
# index says "open". That is not hypothetical: when the crates pair was retired
# from the cloud-environment dialog on 2026-08-16, static.crates.io went dark
# and index.crates.io DID NOT, because the environment sets
# `includeDefaultPackageManagers: true` and the sparse index is in that default
# layer. A one-host probe passed and launched a compile that could not finish.
# The asymmetry is permanent while that setting is on, so it is designed for
# rather than waited out.
#
# Reachability is judged by whether the host ANSWERS, not by the status it
# returns: a blocked host fails at CONNECT and curl reports 000, whereas a live
# host may legitimately 403 a bare root path (infra's cloud-environment.json
# records both facts, and .github#112's probe table shows crates.io's own API
# root 403ing while cargo's paths served).
reachable() {
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$1" 2>/dev/null)"
  [ -n "$code" ] && [ "$code" != "000" ]
}

if ! reachable https://index.crates.io/config.json || ! reachable https://static.crates.io/; then
  echo "toolpath: crates.io egress blocked — not installing. The fix is the environment network allowlist, not this script (.github#112, #534)."
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
