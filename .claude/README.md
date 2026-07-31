# Session-start machinery

Three files here, with different jobs:

| file | scope | fires when |
|---|---|---|
| `inject-org-context.sh` | this repo | `.github` is the session's project directory |
| `session-start-dispatch.mjs` | **every attached repo** | installed at the session root (see below) |
| `register-mcp.mjs` | **every attached repo** | run from the environment setup script (see below) |

The last two exist for the same reason: both `.claude/settings.json` and `.mcp.json`
are **project-scoped**, discovered from the project directory — and a multi-repo
session has no project directory.

## The problem the dispatcher solves

Claude Code fires SessionStart hooks from the **project directory's**
`.claude/settings.json`. A session launched with one repo gets that for free. A
session launched with several does not: the session root (e.g. `/home/user`) is not
a repo, `CLAUDE_PROJECT_DIR` is unset, and no repo's `.claude/settings.json` is ever
discovered.

Measured in a nine-repo session on 2026-07-31: `CLAUDE_CODE_REMOTE=true`, and the
hooks in `front-desk-scheduler`, `infra` and `.github` **all failed to run**. The
session started with no `deno` and no `node_modules` — the exact degraded state
`front-desk-scheduler`'s hook exists to prevent — and with none of the org context
this repo's hook injects. Nothing reported it. It presents as a repo that simply has
no dependencies installed, which is easy to misread as a broken checkout and "fix"
with an `npm install` that repo explicitly forbids.

The dispatcher fans out to every attached repo that declares SessionStart hooks, so
each repo keeps owning its own provisioning.

## Install

Two directories are involved and they are **not** the same one:

| | path (verified 2026-07-31) | what it holds |
|---|---|---|
| user settings | `$HOME/.claude` → `/root/.claude` | hook wiring; the session runs as root |
| session root | `/home/user` | the attached repo checkouts |

The dispatcher is wired from the first and scans the second. Both are ephemeral —
the container is reclaimed — so the environment's setup script recreates the wiring
on every boot:

This is the canonical text of that field. It is recorded here — the same way
`cloud-environment.json` records what the network dialog should say — because the
field itself lives where no reviewer and no gate can see it. If the two drift,
this file is what the field should be returned to.

```sh
#!/usr/bin/env bash
# bounded-systems session bootstrap.
#
# This stays a POINTER. All logic lives in bounded-systems/.github/.claude,
# where it is reviewed, tested and gated. Anything added here is unreviewable
# and ungateable — infra#122's failure mode.
set -uo pipefail

ROOT=/home/user                                    # where the repo checkouts land
BOOT="$ROOT/.github/.claude"                       # preferred: the attached checkout

# --- the trust anchor -------------------------------------------------------
# PIN is a COMMIT SHA (content-addressed, so the URL is immutable). The SHA-256s
# are the second, independent check: pinning the URL only guarantees immutability
# IF the endpoint is honest, because the SHA in the URL is a path component the
# client never verifies. These digests are checked locally, so a wrong-bytes
# response is refused whatever served it.
#
# They live HERE, in the one file that is not fetched. Putting them in the repo
# would mean fetching the digests too, which verifies nothing.
#
# Bump all three together. Regenerate with:
#   for f in session-start-dispatch.mjs register-mcp.mjs; do
#     curl -fsSL "https://raw.githubusercontent.com/bounded-systems/.github/$PIN/.claude/$f" | sha256sum
#   done
PIN=6b63ba49c5a2417f88cb2b92eed2061a2d56a626
SUM_session_start_dispatch_mjs=604e40283fc6ff947b29dff324d3f59d443c4b1247fee74292f3943d05693f2e
SUM_register_mcp_mjs=bbdd6d07f2cd27bc02c8945d6eef62b104dadaad3d3fac52a826201d7221f3d0

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
fi

# Both scripts self-locate from their own path, which is correct in the attached
# checkout and WRONG in the fetch cache. Naming the root explicitly is harmless in
# the first case and load-bearing in the second.
mkdir -p "$HOME/.claude"
if [ -f "$BOOT/session-start-dispatch.mjs" ]; then
  cat > "$HOME/.claude/settings.json" <<JSON
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

# MCP servers resolve when Claude Code LAUNCHES, before any SessionStart hook
# runs — so this must happen here, not in the dispatcher.
if [ -f "$BOOT/register-mcp.mjs" ]; then
  CLAUDE_SESSION_ROOT="$ROOT" node "$BOOT/register-mcp.mjs" || true
else
  echo "bootstrap: WARN register-mcp.mjs missing — MCP tools will not be registered"
fi

# Replace the platform's Stop hook with the infra#112 fix. The stock one scopes
# its check to `origin/<branch>..HEAD`, which after a squash merge includes
# GitHub's own merge commit — so it warned "Unverified" after EVERY merge and
# advised an --amend that would rewrite already-merged history. Not digest-checked
# because it is not fetched: it is only ever copied from the attached checkout.
if [ -f "$BOOT/stop-hook-git-check.sh" ] && [ -d "$HOME/.claude" ]; then
  cp "$BOOT/stop-hook-git-check.sh" "$HOME/.claude/stop-hook-git-check.sh"
  chmod +x "$HOME/.claude/stop-hook-git-check.sh"
  echo "bootstrap: stop-hook patched (infra#112)"
fi

echo "bootstrap: ready — dispatcher at $BOOT"
```

**The heredoc is deliberately unquoted** (`<<JSON`, not `<<'JSON'`) because `$ROOT`
and `$BOOT` must interpolate. There is nothing else `$`-shaped in that JSON. If you
add a field containing a literal `$`, escape it.

**Bump `PIN` and both digests together whenever `.claude/` changes here.** A stale
pin only affects the fallback path — an attached `.github` always wins — so the
symptom is subtle: it works for you and not for a session without `.github`. This
already bit once: #71 recorded the pin it branched from, which predated the file
that PR exists to install, so the fallback fetched a 404 the moment it merged.

### Why two independent checks

Pinning the URL to a commit SHA makes it immutable **if the endpoint is honest** —
the SHA is a path component the client never verifies, so a compromised or
misconfigured host can serve anything under it. The SHA-256s are the check that
does not require trusting the transport: they are compared locally, and a
mismatch is refused whatever served the bytes.

The digests live in the setup script, not in this repo, because the setup script
is the one thing that is not fetched. Digests fetched alongside the files they
describe verify nothing.

Verification **fails closed**. A file that does not match is deleted rather than
left at a path something might execute, and if the dispatcher fails to verify, no
`settings.json` is written at all — a session with no hooks beats a session
running unverified code. Verified by tampering with a digest:

```
bootstrap: REFUSING session-start-dispatch.mjs — sha256 mismatch, not executing it
bootstrap:   expected deadbeef000000…
bootstrap:   got      d54d7a2e261e25…
bootstrap: WARN no dispatcher — repo SessionStart hooks will not run
```

The attached checkout is deliberately **not** digest-checked: it arrives over the
session's git proxy with git's own integrity, and it may legitimately be newer
than `PIN`, so checking it would fail on every merge.

To confirm a pin and its digests agree with the repo, from a clone:

```sh
PIN=<the pin>
for f in session-start-dispatch.mjs register-mcp.mjs; do
  a=$(git show "$PIN:.claude/$f" | sha256sum | cut -d' ' -f1)
  b=$(curl -fsSL "https://raw.githubusercontent.com/bounded-systems/.github/$PIN/.claude/$f" | sha256sum | cut -d' ' -f1)
  [ "$a" = "$b" ] && echo "$f OK $a" || echo "$f MISMATCH — endpoint disagrees with the git object"
done
```

That compares the raw endpoint against git's own hash chain, which is the check
that would catch a host serving something the commit does not contain.

The dispatcher locates the repos itself — it resolves the session root from its own
path — so the command above only has to point at the file. Adjust it if the repos
are checked out somewhere other than `/home/user`.

### Do not edit `launcher-settings.json`

`$HOME/.claude/launcher-settings.json` already exists and already declares a
`SessionStart` hook (`session-start-git-identity.sh`) plus a `Stop` hook. It is
platform-managed and gets rewritten, so changes there do not survive.

`settings.json` is the standard user-settings file and is read alongside it; hook
arrays from the two sources combine, so the snippet above **adds** the dispatcher
without displacing the git-identity hook. If a session ever shows the dispatcher
not running while `session-start-git-identity.sh` does, that merge is the thing to
check first.

**Keep that pointer a pointer.** It is the one piece of this machinery living outside
version control, where no reviewer and no drift gate can see it. Logic added there is
unreviewable — the failure mode infra#122 was filed about. Everything real belongs in
this repo.

### Requires `.github` to be attached

The dispatcher lives in this repo, so the session must have it. infra#101 records that
`add_repo` refuses `.`-prefixed repos; if that holds, `bounded-systems/.github` can
only arrive by being attached at launch. Unverified — the one attempt returned
`-32003` before reaching the API, which is #65.

## Contract

- **Best-effort.** A child hook that fails, hangs (10 min default, override with
  `SESSION_START_HOOK_TIMEOUT_MS`) or prints garbage degrades its own repo and nothing
  else. A session that starts slightly wrong beats one that refuses to start.
- **Sequential**, not parallel — these hooks install toolchains and append to the
  shared `CLAUDE_ENV_FILE`; racing them would interleave `PATH` exports.
- **`CLAUDE_PROJECT_DIR` is rebound per repo**, which is what lets the existing hooks
  run unmodified.
- **stdout is reserved for the merged context envelope.** A child's stdout counts as
  context only if it parses as a `hookSpecificOutput` envelope; everything else goes
  to stderr. Both shapes are live today — this repo's hook emits JSON, the other two
  echo prose — and concatenating them would corrupt the envelope.
- **No per-repo knowledge.** Adding a repo to a session, or a hook to a repo, needs no
  edit here. If you are special-casing a repo in the dispatcher, the logic belongs in
  that repo's hook.

## MCP: why user scope, not `.mcp.json`

`.mcp.json` is project-scoped, so in a multi-repo session it is never discovered —
the same wall the hooks hit. Two further reasons user scope is the right target
rather than a workaround:

1. **Project `.mcp.json` servers require an approval prompt** before first use, and
   that prompt currently fails with `-32003` (#65 — observed four times on
   2026-07-31). Even a *discovered* project server may be unusable. User-scope
   servers carry no such prompt.
2. **A project `.mcp.json` records a relative command** (`node scripts/mcp.ts`),
   which only resolves with `cwd` set to that repo. User scope forces an absolute
   path, which is also what makes it work from anywhere.

Measured 2026-07-31: a session that had read front-desk-scheduler's `CLAUDE.md` —
which says *"the verbs are registered as MCP tools, so ask the `next` tool"* —
shelled out to `node scripts/fds.ts next` instead. `~/.claude.json` had
`mcpServers: {}` and `projects: {}`. The instruction was right; the tool was not
there.

`register-mcp.mjs` reads whatever `.mcp.json` each attached repo declares, makes
path-shaped args absolute (leaving flags and bare interpreters alone), sets `cwd`
to the repo, and **merges** into `~/.claude.json` — that file is Claude Code's own
state and holds much more than MCP config, so it is read-modify-write via a temp
file and rename, never a replacement. It never removes a server it did not add,
and re-running is a no-op.

### Ordering caveat

It registers whatever exists **at the moment it runs**. If the setup script runs
before the repos are cloned, it will find nothing and say so:

```
register-mcp: no attached repo under /home/user declares .mcp.json — nothing to register.
```

If you see that line while the repos are plainly present later in the session, the
setup script is running too early — move the call to the end of the setup script,
or after whatever step materialises the checkouts. The success line names what it
registered:

```
register-mcp: registered at user scope: front-desk (from 1 repo(s))
```

## Known gap: org context does not reach a cloud session

`inject-org-context.sh` reads `claude/context.md` from `bounded-systems/.github-private`
through three fallbacks. In a cloud session **all three fail**, verified 2026-07-31:

- `gh` is not installed;
- `git clone` of `.github-private` has no credential (it is not attached to the
  session) — `could not read Password for 'http://local_proxy@127.0.0.1'`;
- the `curl` fallback uses the ambient `GH_TOKEN`, which is proxy-local and not valid
  against `api.github.com`.

It fails open (`exit 0`), so the dispatcher reports `0 injected context` and the
session proceeds without it. Getting org context into a cloud session needs a source a
session can actually reach — attaching `.github-private`, or serving it from somewhere
that does not require a GitHub credential.
