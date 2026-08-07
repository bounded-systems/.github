# Session-start machinery

Five files here, with different jobs:

| file | scope | fires when |
|---|---|---|
| `inject-org-context.sh` | this repo | `.github` is the session's project directory |
| `status-probe.sh` | this repo | same — a second SessionStart hook; warns only when a provider reports an active incident (`.github-private` → `docs/handoffs/service-status-layer.md`) |
| `session-start-dispatch.mjs` | **every attached repo** | installed at the session root (see below) |
| `register-mcp.mjs` | **every attached repo** | run from the environment setup script; re-run by the dispatcher as a fallback (see below) |
| `stop-hook-git-check.sh` | the session | copied over the platform's Stop hook by the setup script; re-copied by the dispatcher as a fallback (infra#112) |

The middle two exist for the same reason: both `.claude/settings.json` and
`.mcp.json` are **project-scoped**, discovered from the project directory — and a
multi-repo session has no project directory.

The last is a different problem sharing one property with them: it has to be
installed by something outside the repo, and on 2026-08-01 that something silently
stopped doing it (#85). All three are now re-done by the dispatcher when the setup
script has not done them.

> **Why this file keeps growing a new fallback.** The general property these are
> instances of — *a capability needs a canonical definition, a detector for
> drift, and a repairer or a loud failure, all three in version control* — is
> written up with its evidence in
> [`docs/session-capability-invariants.md`](../docs/session-capability-invariants.md).
>
> **Do not add a fifth bespoke repair here.** They are now one `MANIFEST` in
> `session-start-dispatch.mjs`, and it is gated against the canonical field text
> below: `parseSteps` in `gen-bootstrap-pin.mjs` enumerates that field's steps,
> and `bootstrap-steps.test.mjs` asserts each one maps to a manifest entry or to
> an `IRREDUCIBLE` declaration with a reason. A step added to the field with no
> fallback fails `node --test .claude/` instead of failing in production six
> weeks later, which is how #85 was found (#91).

### Adding a step to the setup script

Add the line to the canonical text below, then give it one of two things in
`session-start-dispatch.mjs`:

- a **`MANIFEST` entry** — `artifact` (the file the step installs, which is the
  key the gate matches on), `compare`, `repair`, and `context`. The comparison is
  per-entry on purpose: the Stop hook compares **bytes** because its failure was a
  *wrong* file, while MCP compares a **predicate over JSON** because
  `~/.claude.json` legitimately holds much more than what any repo declares.
  Forcing one comparison on both would reinstate a failure that has already
  happened here.
- an **`IRREDUCIBLE` entry** with a reason, when nothing in the dispatcher can
  re-do it. Both of today's — the `settings.json` write and the
  `CLAUDE_SESSION_ROOT=` prefix — are the same irreducibility: they install the
  pointer that invokes the dispatcher, so a fallback would have to run before
  itself.

If the parse does not recognise the verb you used, it **refuses to parse** rather
than skipping the line — a step nobody has classified is exactly what the gate
exists to catch, so teach `parseSteps` the verb rather than working around it.

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
# PIN and the digests are ONE PAIR — bump them together or the bootstrap refuses
# a legitimate file. Do not hand-edit them; regenerate:
#
#   node .claude/gen-bootstrap-pin.mjs <commit>
#
# On main this is automatic: org-defaults.yml regenerates on push and opens the
# bump PR, because the pin can only name a merge commit once that commit exists.
# The equivalent by hand, against the endpoint rather than the git objects:
#   for f in session-start-dispatch.mjs register-mcp.mjs stop-hook-git-check.sh; do
#     curl -fsSL "https://raw.githubusercontent.com/bounded-systems/.github/$PIN/.claude/$f" | sha256sum
#   done
PIN=9536835c92d4cdd8be02c93cc30b024455b7353d
SUM_session_start_dispatch_mjs=4da7bb6e85bc0cdb48a5ca9243ce3154b36432a753927230a284dd39b6c6ffcb
SUM_register_mcp_mjs=36710119312b6caa9065f9d89c8f661ed750cfc16657528437ad0f60d67418c6
SUM_stop_hook_git_check_sh=d124f7e8844ce1bd1ebd7034b0fed0276b643223582a7cd18f7f78a5f6c6f11f

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

# Keep this call. The dispatcher re-runs register-mcp.mjs as a fallback (#84), but
# only THIS one is ordered before Claude Code launches and reads the tool list.
if [ -f "$BOOT/register-mcp.mjs" ]; then
  CLAUDE_SESSION_ROOT="$ROOT" node "$BOOT/register-mcp.mjs" || true
else
  echo "bootstrap: WARN register-mcp.mjs missing — MCP tools will not be registered"
fi

# Replace the platform's Stop hook with the infra#112 fix. The stock one scopes
# its check to `origin/<branch>..HEAD`, which after a squash merge includes
# GitHub's own merge commit — so it warned "Unverified" after EVERY merge and
# advised an --amend that would rewrite already-merged history. Copied rather than
# executed here, but still digest-verified above when fetched, so the fallback
# path installs the same bytes the attached checkout would.
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
for f in session-start-dispatch.mjs register-mcp.mjs stop-hook-git-check.sh; do
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

### The setup script is not the only call site any more

It happened again on **2026-08-01**, one layer up: the setup-script field had been
reduced to just the `settings.json` heredoc — 264 bytes, per the environment log —
so the `register-mcp.mjs` call was simply gone. `~/.claude.json` read
`mcpServers: null`; a session asked *"what should we work on next?"*, found no
`next` tool, and ranked the org's work by hand from `list_issues` and
`list_pull_requests`. That answer is not Front Desk's answer, and nothing in the
session distinguished the two.

Note what was and was not broken. The dispatcher ran, every repo's hook ran, `deno`
and `dolt` and `node_modules` were all there, and the MCP server itself started
cleanly when invoked by hand. One line was missing from a field that no reviewer
and no gate can see — which is exactly the `infra#122` failure mode this directory
keeps being written against.

So the dispatcher now **calls `register-mcp.mjs` itself** before fanning out, and
reports in the session context anything still missing afterwards. This is a
fallback, not a relocation: the setup script remains the right primary call site
because it is ordered before anything reads the tool list. Keep the call in the
field.

It works because the earlier claim in this file — that registering after launch
cannot help, since servers resolve at launch — was only half right, and the wrong
half was load-bearing. Verified live on Claude Code 2.1.42, 2026-08-01: a session
that started with `mcpServers: null` gained `front-desk`'s five tools **within the
same session**, seconds after `register-mcp.mjs` ran, with no relaunch. The config
is watched. Launch-time resolution is still real and still the ordering you want;
it is just not the only door.

The dispatcher says so on stderr when it has to step in:

```
session-start-dispatch: WARN registered MCP server(s) the setup script did not: front-desk — see .claude/README.md
```

Treat that line as a bug report against the setup-script field, not as a healthy
session. A field that has stopped calling `register-mcp.mjs` has probably stopped
doing the rest of its job too — compare it against the canonical text above.

That prediction was correct, which is why the Stop hook below now works the same
way.

### The Stop hook, for the same reason

The setup script's `cp` of `stop-hook-git-check.sh` had gone missing too, and the
dispatcher now re-copies it. Measured on 2026-08-01: `$HOME/.claude` held the
platform's stock hook at 3262 bytes against this repo's 5458.

This one is worth flagging because it fails **quietly**, which is how it outlasted
the MCP break. The stock hook scopes its check to `origin/<branch>..HEAD`, which
after a squash merge includes GitHub's own merge commit — so it warns "Unverified"
after every successful merge and advises an `--amend` that would rewrite
already-merged history. A hook that cries wolf on every merge is worse than no
hook: it teaches you to ignore the one time it is right. Nothing looks broken, so
nothing gets investigated.

The comparison is on **bytes**, not on presence, because the failure is a *wrong*
file rather than a missing one. Only the script is replaced —
`launcher-settings.json` declares the Stop hook and is platform-managed and
rewritten, so the dispatcher swaps the file it already points at. Hooks are
invoked per event, so a copy written at SessionStart is in force from that
session's first Stop.

```
session-start-dispatch: WARN installed the Stop hook the setup script did not (infra#112) — see .claude/README.md
```

A refused digest can leave the dispatcher present and this file absent. That case
is reported and the platform's hook is left alone, rather than overwritten with
nothing:

```
session-start-dispatch: WARN no stop-hook-git-check.sh beside this file — leaving the platform's Stop hook in place
```

### Ordering caveat

It registers whatever exists **at the moment it runs**. If the setup script runs
before the repos are cloned, it will find nothing and say so:

```
register-mcp: no attached repo under /home/user declares a usable MCP server — nothing to do.
```

If you see that line while the repos are plainly present later in the session, the
setup script is running too early — move the call to the end of the setup script,
or after whatever step materialises the checkouts. The success line names what it
registered:

```
register-mcp: registered at user scope: front-desk
```

and a re-run, including the dispatcher's, reports the no-op rather than rewriting:

```
register-mcp: already registered: front-desk
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
