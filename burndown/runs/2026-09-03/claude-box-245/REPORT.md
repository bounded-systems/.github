# claude-box-245 — fully qualify the `claude-box` pod default image

Issue: https://github.com/bounded-systems/claude-box/issues/245
Fix lands in **bounded-systems/prx** (confirmed scout finding: the defect is
`packages/prx/src/room/claude-room.ts`, not anything in claude-box — claude-box
main @ 33776c8 has no unqualified image ref; its CLI pins `localhost/claude-personal:dev`).

Branch: `claude/burndown-claude-box-245` on prx (base `main` @ 9de9551), commit f8500ac (single commit, amended in the fix round). Not pushed.
Patch: `/home/claude/burndown/out/claude-box-245/0001-fix-room-fully-qualify-the-claude-room-image-bounded.patch`

## What changed (prx)

- `packages/prx/src/room/claude-room.ts` — `image: "claude-box"` → exported
  `CLAUDE_ROOM_IMAGE = "ghcr.io/bounded-systems/claude-box/claude-room:0.7.0"`,
  matching the sibling rooms' `*_ROOM_IMAGE` constants. Doc comment explains
  why (docker.io short-name expansion), that the GHCR package is private today
  (`podman login ghcr.io` with `read:packages` still needed), and how to move to
  a digest pin + `BOX_PINS` later.
- `packages/prx/test/room/spec.test.ts` — new test: `claudeRoom.image` is the
  constant, matches `^ghcr.io/bounded-systems/claude-box/claude-room[:@]`, not `:latest`.
- `packages/prx/test/room/pod.test.ts` — new test: every `perRepoPod` room image
  carries a registry host (no docker.io short-name fallback possible). The first
  path component must be `localhost` or contain a `.`/`:port`, so `localhost/…`
  and `host:5000/…` refs are accepted; bare `name` / `library/name` are not.
- `.changeset/claude-room-image-fully-qualified.md` — `@bounded-systems/prx: patch`
  changeset (required by `changeset-check.yml` for any `packages/` change).
- `packages/prx/test/room/podman.test.ts` — kube-render assertion now checks
  `image: "${CLAUDE_ROOM_IMAGE}"` instead of the bare `image: "claude-box"`.

Tag choice: `0.7.0` is the latest published claude-box release
(`claude-box-v0.7.0`, 2026-06-16; release-please passes the bare version to
publish-ghcr, so the GHCR tag is `0.7.0`). claude-box main's version.txt says
0.8.0 and a "release 0.8.0" commit (00c7e8f) merged, but no `claude-box-v0.8.0`
tag/release exists yet, so pinning 0.8.0 would 404.

## Verify output (trimmed)

```
### grep verify
OK: no unqualified image: refs in packages/prx/src/room/*.ts; claude-room pinned to ghcr.io

### bun test (room suite)
spec.test.ts             19 pass / 0 fail   (includes new claude-room image test)
pod.test.ts              14 pass / 0 fail   (includes new all-rooms-qualified test)
podman.test.ts           47 pass / 0 fail   (updated kube-render assertion)
concierged-room.test.ts   7 pass / 0 fail
pod-identity.test.ts      5 pass / 0 fail
repin.test.ts             5 pass / 0 fail
launch-attest / launch-pod / lifecycle-runner / pod-secrets / pod-up-verb /
podman-runtime.test.ts   -> "Cannot find module '@bounded-systems/door-kit/keeper'" /
                            '@bounded-systems/ocap-provenance/attestation' / verbspec
                            (sandbox dependency gap, see below — unrelated to this diff)
```

Regression proof: with `CLAUDE_ROOM_IMAGE` temporarily set back to `"claude-box"`,
the two new tests fail (`spec.test.ts` 18/1, `pod.test.ts` 13/1) and pass again with the fix.
Full log: `/home/claude/burndown/out/claude-box-245/verify.txt`.

## Unresolved / caveats

1. **Sandbox could not run the full prx checks.** The egress proxy returns 403
   for registry.npmjs.org and npm.jsr.io, so `bun install` cannot populate
   node_modules. I hand-shimmed `zod` (4.4.3, the locked version) and minimal
   `@bounded-systems/{env,fs,host,proc}` stubs inside node_modules (not part of
   the diff) to run the room tests that matter; the six room test files needing
   `door-kit`/`ocap-provenance`/`verbspec`, plus `bun run typecheck` and
   `biome check`, could not run here. They do not touch the changed lines; CI
   should be green but must confirm. Line width (100) was checked by hand.
2. **Tag pin, not digest pin.** Sibling rooms pin `@sha256:`; the claude-room
   GHCR package is private and ghcr.io is unreachable from the sandbox, so the
   digest could not be read. An owner with GHCR access can swap in the digest and
   add `{ image: "ghcr.io/bounded-systems/claude-box/claude-room", file: ".../claude-room.ts" }`
   to `BOX_PINS` in repin.ts.
3. **Private-GHCR half of the issue is an owner action — not attempted.** Making
   `ghcr.io/bounded-systems/claude-box/*` public, and documenting the
   `podman login ghcr.io` (`read:packages`) pull path in claude-box's
   HOSTING.md/README. Until then this fix turns the misleading docker.io 404 into
   a correct GHCR auth/`podman login` failure on a fresh machine.
4. Not claimed via `claim-ticket.yml` (no GitHub write access from here); check
   the Front Desk board for a concurrent prx PR before opening one.
5. **This patch closes only Requested Action 3 of #245** (the default image
   ref). Requested Actions 1 (document the GHCR pull path/auth/digests in
   claude-box HOSTING.md) and 2 (make the packages public) are untouched, so the
   issue stays open after the prx PR merges. The PR description must NOT say
   `Closes #245`.

## Before merging (owner)

- [ ] Claim claude-box#245 (dispatch `claim-ticket.yml`, or assign yourself +
      comment on the issue) **before** opening the prx PR — `pr-claim.yml` runs
      on every PR and checks for a live Front Desk claim; CLAUDE.md forbids
      working unclaimed. Check the Front Desk board for a concurrent prx PR first.
- [ ] Open the prx PR with the description below; reference the issue as
      `Refs bounded-systems/claude-box#245` / "closes only request 3 of #245" —
      **do not write `Closes #245`**.
- [ ] Confirm CI: `bun run typecheck`, `biome check`, full `bun test` and
      `changeset-check` (not runnable from the sandbox).
- [ ] Optional follow-ups: swap `:0.7.0` for `@sha256:` + add claude-room to
      `BOX_PINS` in repin.ts once the digest is readable; open a small claude-box
      docs PR for HOSTING.md (private packages, `podman login ghcr.io` with
      `read:packages`) to close request 1.

## Ready-to-paste GitHub comment (issue #245)

```
The unqualified default lives in bounded-systems/prx, not this repo: `packages/prx/src/room/claude-room.ts` sets `image: "claude-box"`, which `prx pod up --pod per-repo` renders straight into the kube-play manifest, so podman expands it to `docker.io/library/claude-box:latest`.

Patch (against prx `main` @ 9de9551) pins it as an exported `CLAUDE_ROOM_IMAGE = "ghcr.io/bounded-systems/claude-box/claude-room:0.7.0"` (latest published release), matching the sibling `*_ROOM_IMAGE` constants, and adds tests asserting the claude-room image is registry-qualified and that no `perRepoPod` room can fall back to a docker.io short name. The kube-render test now checks the constant.

Apply in a prx checkout: `git checkout -b fix/claude-box-245 origin/main && git am 0001-fix-room-fully-qualify-the-claude-room-image-bounded.patch && bun test packages/prx/test/room` (the patch includes the `@bounded-systems/prx: patch` changeset).

This addresses only request 3 of this issue (the default image ref); it does not close #245. Still open: request 1 (document the pull path — the `ghcr.io/bounded-systems/claude-box/*` packages are private, so `podman login ghcr.io` with `read:packages` is needed — plus current digests in HOSTING.md) and request 2 (making the packages public). Follow-up in prx: swap the tag for an `@sha256:` digest + `BOX_PINS` entry once someone with GHCR read access can fetch it. Until the package is public, a fresh host now gets a GHCR auth error instead of a Docker Hub 404.
```

## Ready-to-paste PR description (prx)

```
fix(room): fully qualify the claude-room image

Refs bounded-systems/claude-box#245 — addresses request 3 only (default image
resolution); does NOT close the issue. Requests 1 (HOSTING.md pull-path/auth
docs) and 2 (public packages) remain open in claude-box.

`claudeRoom.image` was the bare `claude-box`, which `prx pod up --pod per-repo`
rendered verbatim into the kube-play manifest, so podman expanded it to
`docker.io/library/claude-box:latest` (404) on any host without a local image.
Pin `ghcr.io/bounded-systems/claude-box/claude-room:0.7.0` (latest published
claude-box release) as an exported `CLAUDE_ROOM_IMAGE`, matching the sibling
`*_ROOM_IMAGE` constants. Tag pin rather than digest because the GHCR package
is private and the digest is not readable from where this was authored;
follow-up: `@sha256:` + `BOX_PINS` entry.

Tests: claude-room image is registry-qualified and not `:latest`; no
`perRepoPod` room image can fall back to a docker.io short name; kube-render
test checks the constant. Changeset: `@bounded-systems/prx` patch.
```

## Fix round

Must-fix items from the verdicts and what was done (commit d731ef5 amended → f8500ac;
patch regenerated; room suite re-run, same results: spec 19/0, pod 14/0,
podman 47/0, repin 5/0, concierged-room 7/0, pod-identity 5/0; regression check
still fails exactly the two new tests with the constant reverted; the
`changeset-check.yml` grep logic passes against `main...HEAD`).

1. **(B) Add a changeset — changeset-check.yml hard-fails without it.** PATCH:
   added `.changeset/claude-room-image-fully-qualified.md` (`@bounded-systems/prx: patch`,
   following #981's precedent for a room fix).
2. **(B) Claim the issue before opening the prx PR.** PROCESS: cannot be done
   from the sandbox (no GitHub write access); listed under "Before merging (owner)".
3. **(B) PR description must say it closes only request 3 — no `Closes #245`.**
   PATCH (report wording): added a ready-to-paste PR description with
   `Refs …#245 — addresses request 3 only; does NOT close the issue`; reworded
   the issue comment to say the same; added caveat 5; result.json now carries
   `partial: true`.

Nits also taken: (B) `pod.test.ts` regex over-constrained legitimate refs —
now `/^(localhost|[^/]*[.:][^/]*)\//` (accepts `localhost/x`, `host:5000/x`,
`ghcr.io/…`; rejects `claude-box`, `claude-box:latest`, `library/claude-box`).
(A) result.json states explicitly that #245 stays open. Not taken: the
claude-box HOSTING.md paragraph (separate repo, separate PR — left as an owner
follow-up), the digest pin (unreadable from the sandbox), the `Claude-Session:`
trailer (harmless; squash removes it).
