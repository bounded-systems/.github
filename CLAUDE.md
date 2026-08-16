# bounded-systems/.github — read this before doing anything

This file exists because it is the **only** org channel that survives a resumed
session. The org context, the claim convention and the harness `env` baseline all
arrive through `SessionStart` hooks, and a session that was *resumed* rather than
created runs none of them — the platform logs `Fast resume: Environment already
configured — Skipping initialization script` and does not persist what that script
installs (`.claude/README.md`, and `.github-private` #427).

`CLAUDE.md` is read from the filesystem when context is assembled, not by a hook.
Keep it **short** — it costs context every session.

## 1. Check the bootstrap, and repair it if it is not in effect

```sh
R="${CLAUDE_SESSION_ROOT:-}"                     # resolve the checkout root — never assume /home/user
[ -f "$R/.github/.claude/boot.sh" ] || R="$PWD"
[ -f "$R/.github/.claude/boot.sh" ] || R="${PWD%/*}"
[ -f "$R/.github/.claude/boot.sh" ] || R=/home/user
C="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
cmp -s "$C/stop-hook-git-check.sh" "$R/.github/.claude/stop-hook-git-check.sh" \
  && echo "bootstrap in effect" || {
  F="curl -fsSL --retry 3 --retry-connrefused --retry-max-time 60 --connect-timeout 5 --max-time 30"
  S="${ORG_BOOT_SHA256:-$($F https://boot.bounded.tools/channel/front-desk.json 2>/dev/null \
    | sed -n 's/.*"boot":"\([0-9a-f]\{64\}\)".*/\1/p')}"
  B="$R/.github/.claude/boot.sh"   # attached checkout — same bytes, no egress
  { [ -n "$S" ] && echo "$S  $B" | sha256sum -c --status - 2>/dev/null; } || {
  B=""
  [ -n "$S" ] && $F "https://boot.bounded.tools/$S.sh" -o /tmp/boot.sh \
    && echo "$S  /tmp/boot.sh" | sha256sum -c --status - && B=/tmp/boot.sh; }
  if [ -n "$B" ]; then
    CLAUDE_SESSION_ROOT="$R" bash "$B"
    D="$R/.github/.claude/session-start-dispatch.mjs"
    [ -f "$D" ] || D=/opt/bounded-boot/session-start-dispatch.mjs
    CLAUDE_SESSION_ROOT="$R" node "$D"
  else echo "bootstrap: REFUSED — no verified copy (no digest source, or no bytes matched)"; fi
}
```

The comparison is exact: the platform's stock Stop hook and this repo's copy differ
by construction (infra#112), and the platform rewrites its copy on every resume.
Repairing by hand does not weaken the trust chain — `bash` only ever runs bytes that
hashed to the resolved digest, whichever source supplied them, and with no digest
resolvable it refuses rather than falling through to an unverified file. The digest
comes from the CHANNEL MANIFEST since #192 (`channel/front-desk.json`, written only
by the OIDC-pinned `boot-manifest` lane on main), with the legacy `ORG_BOOT_SHA256`
variable honored FIRST while it still exists — a dialog pin is a deliberate hold on
a version, not stale state to outvote. The checkout is tried first because the
repair must work when egress is down (then only the variable path can resolve a
digest — the one capability the variable's retirement gives up here). This snippet
and the field's canonical text (`.claude/README.md`) now read the same manifest; if
you change the flags, change both texts together.

## 2. Claim before working

Before starting work on any issue, dispatch `claim-ticket.yml` in this repo
(`workflow_dispatch`: `repo`, `issue`, `claimant`), then confirm on the **issue**
that the claim comment names your claimant — a dispatch does not return its run id,
so the issue is the record, not the run list. An issue with any assignee or the
`claimed` label is someone else's. Window unreachable → claim by hand and say so.

## 3. What this repo is

Org-level defaults and the public profile README for bounded-systems. It is
**public** — nothing from `.github-private` belongs here, and `prx init`'s public
scaffolder must never carry the org context hook (there is a no-leak guard test).

One change → one PR → merge; no direct pushes to `main`. Open PRs as draft. Pin
every Action to a commit SHA; default `permissions: { contents: read }`. Run
`node --test .claude/*.test.mjs` and `node --test *.test.mjs` before pushing.

## Then read

`.claude/README.md` (session-start machinery: the dispatcher, the bootstrap field,
and what each fallback exists for) · `.github-private` → `claude/context.md`,
`docs/org-map.md`, `docs/merge-gate.md`.

<!-- bounded-systems-org:begin — managed by adopt-claude-harness; do not hand-edit this block -->
## bounded-systems sessions — before anything else

1. **Bootstrap**: run `bash .claude/org-repair.sh` — pre-approved where this
   repo's settings carry the org floor; generator-owned repos may still prompt.
   Its trust anchor since #192 is the channel manifest (written only by the
   OIDC-pinned `boot-manifest` lane on main — "what merged to main" is the
   root of trust), with the legacy dialog `ORG_BOOT_SHA256` honored first
   while it exists: it executes a local or fetched copy ONLY if the bytes
   hash to the resolved digest, and refuses otherwise. `bootstrap in effect`
   → continue. `REFUSED` or a permission denial → stop and report; do not
   work around it.
2. **Claim before working**: dispatch `claim-ticket.yml` in
   `bounded-systems/.github` (workflow_dispatch: `repo`, `issue`, `claimant`),
   then confirm the claim comment ON THE ISSUE names your claimant. Any
   assignee or `claimed` label → someone else's. Window unreachable → claim by
   hand (assign + comment) and say the window was down. No issue → open one.
3. **Degraded mode**: no "bounded-systems — Claude context" block in your
   session context means the org context did not load. You may claim and work
   THIS repo only — no org-level `[settings]`/`[org]` changes, no cross-repo
   work.
<!-- bounded-systems-org:end -->