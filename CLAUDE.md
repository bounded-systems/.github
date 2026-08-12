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
cmp -s ~/.claude/stop-hook-git-check.sh .claude/stop-hook-git-check.sh \
  && echo "bootstrap in effect" || {
  B=/home/user/.github/.claude/boot.sh   # attached checkout — same bytes, no egress
  echo "$ORG_BOOT_SHA256  $B" | sha256sum -c --status - 2>/dev/null || {
  B=""
  curl -fsSL --retry 3 --retry-connrefused --retry-max-time 60 --connect-timeout 5 \
    --max-time 30 "https://boot.bounded.tools/$ORG_BOOT_SHA256.sh" -o /tmp/boot.sh \
    && echo "$ORG_BOOT_SHA256  /tmp/boot.sh" | sha256sum -c --status - && B=/tmp/boot.sh; }
  [ -n "$B" ] && bash "$B" || echo "bootstrap: REFUSED — no copy matched \$ORG_BOOT_SHA256"
  CLAUDE_SESSION_ROOT=/home/user node /home/user/.github/.claude/session-start-dispatch.mjs
}
```

The comparison is exact: the platform's stock Stop hook and this repo's copy differ
by construction (infra#112), and the platform rewrites its copy on every resume.
Repairing by hand does not weaken the trust chain — `bash` only ever runs bytes that
hashed to `$ORG_BOOT_SHA256`, whichever of the two sources supplied them, and if
neither does it refuses rather than falling through to an unverified file. The
checkout is tried first because the repair must work when egress is down, which is
exactly when a resumed session is most likely to be repairing by hand. The `curl`
invocation is the canonical setup-script field text and its flags are unchanged; if
you change *them*, change `.claude/README.md` and the environment dialog together.

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
