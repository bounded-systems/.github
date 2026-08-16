# Session-start machinery

Six files here, with different jobs:

| file | scope | fires when |
|---|---|---|
| `inject-org-context.sh` | this repo | `.github` is the session's project directory |
| `status-probe.sh` | this repo | same — a second SessionStart hook; warns only when a provider reports an active incident (`.github-private` → `docs/handoffs/service-status-layer.md`) |
| `setup-toolpath.sh` | **every attached repo** | a third SessionStart hook when `.github` is the project directory; otherwise fetched by `boot.sh` and run by the dispatcher's manifest. Background-installs the toolpath CLI (`path`) when crates.io egress is open, so a session can `path share` its provenance to a PR (#112). Quiet no-op while egress is closed; when it cannot install at all the dispatcher says so, with the reason (#522) (`.github-private` → `docs/handoffs/toolpath-pathbase.md`) |
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

Since #125 the field is **one line**. Everything it used to do lives in
[`boot.sh`](boot.sh) — fetched, digest-checked, and only then executed — so the
body is reviewed, tested and gated in-repo, and the only hand-typed text left
is a line that changes only when its own failure behaviour does (three times
so far: retries for the measured init-time failure and deriving the URL from
the digest, both 2026-08-10; embedding the digest literally and logging the
run, 2026-08-16 — see below):

```sh
{ curl -fsSL --retry 3 --retry-connrefused --retry-max-time 60 --connect-timeout 5 --max-time 30 "https://boot.bounded.tools/239f716b6e69a408914ed3e6d5c750c27ecab1b8ff8dcbbe937885a170f02545.sh" -o /tmp/boot.sh && echo "239f716b6e69a408914ed3e6d5c750c27ecab1b8ff8dcbbe937885a170f02545  /tmp/boot.sh" | sha256sum -c --status - && bash /tmp/boot.sh && echo boot_ok || echo "bootstrap: refused or unreachable — no hooks installed (.github/.claude/README.md)"; } >/tmp/boot-init.log 2>&1
```

The digest in the field is a **literal, not `$ORG_BOOT_SHA256`**, and that is a
measured constraint, not a style choice: the init phase runs the setup script
**without the dialog's environment variables** (`sha=UNSET` printed from inside
the init run, while every probe from the session's own process sees the
variable — `.github-private`#506, 2026-08-16). The var-derived field expanded
its URL to `…/.sh`, 404'd in under a second through perfectly healthy egress,
and the fail-open tail hid it; on all evidence in the record, the derived
field never once completed at init. Do not "simplify" the literal back to the
variable — `bootstrap-pin.test.mjs` pins the field's literal to the sha256 of
this repo's own `boot.sh`, so the text and the payload cannot drift apart.

`ORG_BOOT_SHA256` the **variable** stays in the dialog for the consumers that
run where variables exist: `cloud-env-check.mjs`, `org-repair.sh`, and the
CLAUDE.md step-1 gate all verify against it in-session. It is recorded in
`.github-private` → `.claude/cloud-environment.json` alongside the other
`ORG_`-prefixed values — which puts it inside the `ORG_ENV_CONFIG` digest, the
`env-record.yml` honesty gate, and `cloud-env-check.mjs`'s every-boot drift
check. A digest bump therefore moves **three dialog things together, in one
sitting**: re-paste the field text (new literal), set the `ORG_BOOT_SHA256`
variable, and recompute `ORG_ENV_CONFIG` (`node
.claude/hooks/cloud-env-check.mjs --print-digest` in `.github-private`, after
writing the new value). Get the current digest with:

```sh
node .claude/gen-bootstrap-pin.mjs --outer origin/main
```

There used to be a second variable. `ORG_BOOT_URL` carried the fetch location
(first `raw.githubusercontent.com/<commit>/.claude/boot.sh`, then the
content-addressed `boot.bounded.tools/<sha256>.sh` after infra#245 shipped on
2026-08-10) — but the content-addressed endpoint makes the URL a pure function
of the digest, so storing both was one fact written down twice, and the
2026-08-10 near-miss in `.github-private` (a pair written pointing at an
unpublished URL, caught only by probing) is exactly the mismatch that
derivation makes unrepresentable. CORRECTED 2026-08-16: "the field text now
derives it" was true for ten hours of design and never true at runtime —
init-time expansion of `$ORG_BOOT_SHA256` yields the empty string (#506).
Derivation survives as the **paste-time convention**: the URL is still a pure
function of the digest, computed by whoever types the field, and the field
carries the result literally. The serving
host is part of the field text rather than the hashed record; it is
non-trust-bearing (the sha256 check refuses wrong bytes regardless of host),
so moving hosts again is a field-text edit — a deliberate, org-wide re-paste —
not a dialog-var edit. The payload store is append-only (infra
`cloudflare/boot/`), so a dialog holding an older digest keeps booting its
older payload; publish and paste stay decoupled.

Every intermediate state fails safe: a 404 or wrong bytes break the `&&` chain
before `bash` runs, and the session starts with no hooks — the same posture the
old field had when a fetch_verified refused a file. The field stays fail-open
(the trailing `||` keeps exit 0, so a broken bootstrap never blocks session
creation) — but since 2026-08-16 it is no longer *silently* fail-open: the
whole run is logged to `/tmp/boot-init.log`, which rides the container into
every session (and into environment snapshots) and ends in `boot_ok` on
success, so "did boot run, and why not" is one `cat`. Two measured facts to
weigh before ever changing that posture: the init runner executes the field
under `set -e` and surfaces a nonzero exit loudly in the creation UI ("View
details" shows the script's stdout — a usable readout channel), so a
fail-closed field is possible but blocks all session creation while broken;
and the UI's "Try again" after a failed setup **skips the init script on the
retry pass**, producing a running-but-hookless session (#506).

### The field is skipped entirely on a RESUMED session (measured 2026-08-11)

Every failure mode described above assumes the field **runs**. On a resumed
session it does not run at all, and nothing above detects that.

The environment manager's own log (`/tmp/env-manager.log`) records both boots of
one container. On creation, `"session_mode": "setup-only"`, the field ran and
exited 0 — `Running initialization script {"script_length": 342}` against the
342-byte then-canonical line, a trailing newline apart — and the platform
then fired each repo's SessionStart hooks with `claude --init-only`, once per
repo, which is the only context in which a project-scoped `.claude/settings.json`
is ever discovered. (CORRECTED 2026-08-16: this log line was read as "the field
succeeded". Exit 0 was the fail-open tail — the fetch itself had 404'd on the
empty-var URL, #506. The launcher's "Successfully executed init script" attests
the exit code, not the install.) On resume, `"session_mode": "resume-cached"`:

```
Wrote launcher settings file  {"path": "/root/.claude/launcher-settings.json"}
Wrote hook script             {"path": "/root/.claude/stop-hook-git-check.sh"}
Fast resume: Environment already configured
              {"message": "Skipping initialization script for faster startup"}
```

`has_init_script: true` — the field is configured, and skipped as an
optimisation. `~/.claude` does not survive the resume. So the platform re-writes
**its own** artifacts and skips **ours**, and the net effect is worse than a
missing install: its stock `stop-hook-git-check.sh` lands and is never overwritten
by the bootstrap, so **every resume silently reverts the infra#112 scope fix.**
`~/.claude/settings.json` is simply never re-created.

This supersedes the two causes proposed in `.github-private` #314 (an empty
`$ORG_BOOT_URL`, and an init-time egress race). Both are ruled out by this log:
the variable no longer exists, and the script succeeded in 532 ms rather than
fail-safing in 28 ms.

**Repair, from inside any session** — the canonical field text above is runnable
verbatim and fully repairs the session; verified 2026-08-11, yielding
`bootstrap: ready` plus a byte-restored Stop hook. Follow it with:

```sh
CLAUDE_SESSION_ROOT=/home/user node /home/user/.github/.claude/session-start-dispatch.mjs
```

**Detector.** A resumed session cannot use a SessionStart hook to discover it had
no SessionStart hooks — the same irreducibility recorded above for the
`settings.json` write. But the condition has an exact signature, because the
platform's stock Stop hook and this repo's copy differ by construction:

```sh
cmp -s ~/.claude/stop-hook-git-check.sh .claude/stop-hook-git-check.sh \
  || echo "org bootstrap NOT in effect — resumed session; run the repair above"
```

Full forensics, including the consequences for the claim convention and for
`.github-private` #75's telemetry acceptance test, are in `.github-private` →
`docs/handoffs/front-desk-dialog-verify.md`.

Which link breaks depends on the failure, and it is worth knowing which:
`-f` makes curl exit non-zero and write **nothing** on a 404, so the chain
stops at the curl link and the digest gate is never reached; only a 200
carrying the wrong bytes gets as far as `sha256sum`. Both refuse, but the
first refuses earlier and leaves no file behind.

`-f` is therefore load-bearing and must **not** be swapped for
`--fail-with-body`, whatever a general "strict curl" recipe says. This is a
fetch-then-execute call site: the body of a failed response must never land at
a path something might run. (Diagnostic fetches want the opposite —
`.github-private` → `docs/agent-cli-tooling-survey.md` splits the recipe by
call-site class.) `--fail-with-body` is also the one flag in that recipe that
would break a bullseye-era curl 7.74 with unknown-option exit 2; everything
here clears that floor — `--retry-connrefused` is 7.52, `--retry-max-time`
7.12.

The retry flags were added 2026-08-10 for a measured failure, not on
principle. `cloud-environment.json` caveat 3 records this field running at
container init and exiting 0 in **~28ms** — far too fast for a TLS fetch —
leaving no `/tmp/boot.sh` and a hookless session, while the identical fetch
from the running session succeeded and hashed correctly. The egress path is
not guaranteed usable that early, and `--retry-connrefused` is the flag that
covers it: plain `--retry` does not retry a refused connection, which is
exactly the init-time symptom. `--retry-max-time 60` bounds the worst case, so
a genuinely unreachable host costs a minute before failing safe rather than
hanging. That trade is right here and wrong for `status-probe.sh`, which stays
retry-free by design: a missing status line is nobody's emergency, a hookless
session is.

**Bump both layers together whenever `.claude/` changes here.** A boot.sh byte
change — including the inner `PIN`/`SUM_*` rewrite a bump performs — moves
`ORG_BOOT_SHA256`, so every pin bump implies a `.github-private` record PR and
a dialog edit. The generator prints the implied pair on every bump, and a
stale dialog pair is flagged at every session start by `cloud-env-check.mjs`
rather than discovered by a failed probe. A stale pin still only affects the
fallback path — an attached `.github` always wins — so the symptom stays
subtle: it works for you and not for a session without `.github`. #71 recorded
the pin it branched from, which predated the file that PR existed to install,
so the fallback fetched a 404 the moment it merged.

### Migration runbook (field → one line)

The operator types the field by hand, so the order is arranged to fail safe at
every step:

1. Merge the #125 PR (boot.sh + retargeted generator/tests + this text).
2. Let `org-defaults.yml` open and land the pin-bump PR naming the merge
   commit; then run `node .claude/gen-bootstrap-pin.mjs --outer origin/main`
   for the final pair.
3. Merge the `.github-private` record PR (.github-private#314): the two
   `ORG_BOOT_*` variables, the `raw.githubusercontent.com` domain entry, and
   the recomputed `ORG_ENV_CONFIG` digest, placeholder-first.
4. In **one** dialog visit: add `ORG_BOOT_URL` + `ORG_BOOT_SHA256`, update
   `ORG_ENV_CONFIG`, and replace the setup-script field with the one line
   above. (This is the deliberate restoration of the drifted field — the
   reduced remnant is discarded, not patched.)
5. Fresh session, then verify: `cloud-env-check` shows no stale-pair warning;
   `~/.claude/settings.json` names the dispatcher; no
   `WARN registered MCP server(s) the setup script did not` line; the Stop
   hook is byte-equal to the repo copy. In a scratch environment, flip one hex
   of `ORG_BOOT_SHA256` and confirm the REFUSED path installs nothing.

Half-done states: variables missing → the chain fails closed; variables
present but the old field still in place → old behavior, harmless.

### Why the chain has three links

Pinning a URL to a commit SHA makes it immutable **if the endpoint is honest** —
the SHA is a path component the client never verifies, so a compromised or
misconfigured host can serve anything under it. The SHA-256s are the check that
does not require trusting the transport: they are compared locally, and a
mismatch is refused whatever served the bytes.

A digest can only vouch for bytes it does not travel with — digests fetched
alongside the files they describe verify nothing. So each link's digest lives
one link closer to the operator than the bytes it verifies:

1. **The dialog digest** (`ORG_BOOT_SHA256`; the URL is derived from it in the
   field text, so there is no second value to keep consistent) — the root.
   Never fetched: typed into the environment dialog, recorded in
   `.github-private`'s `cloud-environment.json`, hashed into `ORG_ENV_CONFIG`,
   gated by `env-record.yml`, drift-checked at every boot.
2. **boot.sh's `PIN`/`SUM_*` block** — fetched, but only ever executed after
   the field verified boot.sh against link 1, so the inner digests are
   transitively anchored.
3. **The three artifacts** — fetched by boot.sh, refused unless they hash to
   link 2's digests, exactly as before.

The old design had two links with the root in the field itself; the root is
now *smaller* (two values instead of a script) and *gated* (the field never
was). What it costs: every boot.sh byte change moves link 1, which is a record
PR plus a dialog edit — the bump procedure above.

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
for f in session-start-dispatch.mjs register-mcp.mjs stop-hook-git-check.sh setup-toolpath.sh; do
  a=$(git show "$PIN:.claude/$f" | sha256sum | cut -d' ' -f1)
  b=$(curl -fsSL "https://raw.githubusercontent.com/bounded-systems/.github/$PIN/.claude/$f" | sha256sum | cut -d' ' -f1)
  [ "$a" = "$b" ] && echo "$f OK $a" || echo "$f MISMATCH — endpoint disagrees with the git object"
done
```

That compares the raw endpoint against git's own hash chain, which is the check
that would catch a host serving something the commit does not contain. The
outer link is confirmed the same way:
`node .claude/gen-bootstrap-pin.mjs --outer <commit>` prints what the dialog
should say, and the dialog pair disagreeing with it is exactly what
`cloud-env-check.mjs` flags at session start.

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

**Keep that pointer a pointer.** The field (one line) and the two dialog
variables are the only pieces of this machinery living outside version control
— and the variables, unlike the field, are at least *recorded* and digest-gated
via `.github-private`'s `cloud-environment.json`. Logic added to the field is
unreviewable — the failure mode infra#122 was filed about. Everything real
belongs in this repo, in `boot.sh` or behind it.

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

**The source now exists; the rewire is the remaining work.** `boot.bounded.tools`
is live and verified, and serving `claude/context.md` lease-gated from it is the
accepted plan (infra#245, `.github-private` →
`docs/handoffs/portable-secrets-and-brokers.md`) — with the custody trade
recorded there: a lease key's exposure set is everything that executes in any
session using that environment, which is tolerable for conventions prose and
never for credentials. The source side of that bargain is already mechanical —
`_scripts-lint.yml` fails any PR that puts credential-shaped content into
`claude/context.md` (boot `SECURITY.md` R1).

What the rewire needs is a way to change the hook **in the 84 repos that already
committed it**, which the rollout lane cannot do — it skips every repo that has
a `.claude/settings.json`. That path now exists as
`.github-private` → `docs/handoffs/claude-harness-reroll.md`
(`reroll-claude-harness.sh` + `reroll-claude-harness.yml`): edit the canonical
hook in `adopt-claude-harness.sh`, then run a re-roll wave. So this gap is no
longer blocked on tooling — it is a canonical-hook edit plus a wave.
