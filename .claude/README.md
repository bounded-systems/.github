# Session-start machinery

Two files here, with different jobs:

| file | scope | fires when |
|---|---|---|
| `inject-org-context.sh` | this repo | `.github` is the session's project directory |
| `session-start-dispatch.mjs` | **every attached repo** | installed at the session root (see below) |

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

```sh
mkdir -p "$HOME/.claude"
cat > "$HOME/.claude/settings.json" <<'JSON'
{
  "hooks": {
    "SessionStart": [
      { "matcher": "", "hooks": [ { "type": "command",
        "command": "node /home/user/.github/.claude/session-start-dispatch.mjs" } ] }
    ]
  }
}
JSON
```

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
