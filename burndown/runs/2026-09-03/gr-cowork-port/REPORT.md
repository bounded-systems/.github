# gr-cowork-port — report

Repo: bounded-systems/guest-room · branch `claude/burndown-gr-cowork-port` (3 commits on `main` @ e6c3896, not pushed)
Patches: `0001-feat-profiles-the-nopodman-profile-a-room-with-doors.patch`, `0002-docs-nopodman-profile-Cowork-sandbox-gap-list-G1-G8.patch`, `0003-fix-profiles-same-host-cards-name-the-real-socket-re.patch`

## Scout claims re-checked

- guest-room has no podman coupling: confirmed — `bun test` 121/121 green on a clean clone in this sandbox (bun 1.3.13, `command -v podman` → absent, uid 0).
- The podman coupling is in claude-box: confirmed at claude-box `33776c8` (2026-09-01): `netd/run-netd.sh` hard-requires `podman` + `socat` + `docker.io/ubuntu/squid`; `claude-box.ts` builds podman argv; `door-relay.ts` needs podman `--internal` networks. One nuance the scout under-stated: `netd/netd.ts` (the bun-native egress proxy) needs **no container** — its blocker in Cowork is that it lives in claude-box, imports `../lib/runtime`, and would have to chain every CONNECT through the injecting gateway (gap G2 below).
- `docs/working-in-a-cowork-sandbox.md` described `NETD_ALLOW_INJECTING_PARENT=1` and `./work.sh survey|land`: confirmed neither exists in guest-room or claude-box (`grep -rn` on both). Corrected in the doc (gaps G4/G5).
- Engine files (`mod.ts`, `gherkin.ts`, `protocol.ts`, `daemon.ts`) forbid the words podman/netd/claude/…: respected — engine untouched; all new code is in `profiles/`.

## What changed

| File | Change |
|---|---|
| `profiles/nopodman.ts` (new, ~115 lines incl. doc comments) | `nopodmanRoom(rooms, catalog, room, env, {caveats, workcell})` → same-host `DoorGrant[]` (guest transport = host transport), `childEnv` (`<NAME>_SOCK` map for `env -i`), honest rulebook ("NO WALLS"). `sameHostDoor` (every GRANTED card ends with `sameHostNote`: the real socket path + `$<NAME>_SOCK`, declared authoritative over any in-box path the catalog text cites), `assertPrivateDir` (world-writable socket dir refused), `injectingParent` (`HTTPS_PROXY` ⇒ refuse unless `GUEST_ROOM_ALLOW_INJECTING_PARENT=1`; gateway then named in the rulebook), `runDir` (XDG_RUNTIME_DIR else `$HOME/.guest-room/run`; neither ⇒ throws, never `/tmp`). |
| `profiles/allowlist-door.ts` (new, 69 lines) | Egress-shaped decision door on the repo's JSON protocol: `connect {host}` answered by `checkCaveats` with a `host=` OR-set / `.suffix` verifier; DENY/ALLOW logged; a grant with no `host=` caveat refuses to serve. Explicitly a decision oracle, not a proxy. |
| `nopodman.test.ts` (new) | 7 tests over a real unix socket in a tmp run dir: allowed/denied hosts, no-ALLOW on denial, unattenuated door refuses, world-writable dir refused, injecting parent refused/acknowledged/named, attenuation narrows via `attenuatesDoors`, same-host cards name the real socket (catalogued and uncatalogued door), no HOME/XDG refused. |
| `features/nopodman.feature` (new) + `guest-room.test.ts` (+steps) | 3 executable scenarios (same-host doors, denied-by-name, injecting parent); per-scenario run dirs removed in `afterAll`. |
| `.release/nopodman-profile.md` (new) | mint release intent, `bump: minor` (two new public entrypoints). |
| `docs/working-in-a-cowork-sandbox.md` | New section "The `nopodman` profile — doors, no walls" + **gap list G1–G8** (each with reason); two false tooling claims corrected. |
| `jsr.json`, `package.json` | `./profiles/nopodman`, `./profiles/allowlist-door` exports; `profiles/*.ts` in publish include (else JSR would silently drop it). `deno publish --dry-run` passes. |
| `trellis.json`, `README.md` | New claim row (proven by `features/nopodman.feature`); claims block regenerated with `git hash-object` digests. descriptor-kit `check .` was run for real in the fix round (its one dep, `zod`, borrowed from an on-disk copy matching its lockfile): `✓ no drift`. Tree + "Going deeper" mention the profile. |

## Verify output (trimmed; full in `verify.txt`)

```
$ ! command -v podman >/dev/null && bun test 2>&1 | tail -4 && grep -c "G[0-9]" docs/working-in-a-cowork-sandbox.md
 131 pass
 0 fail
 40229 expect() calls
Ran 131 tests across 12 files. [381.00ms]
11
exit=0
$ DENO_NO_PACKAGE_JSON=1 deno publish --dry-run --allow-dirty   → Success Dry run complete (locally; CI gate is `bunx jsr publish --dry-run`, not runnable offline)
$ DENO_NO_PACKAGE_JSON=1 deno check profiles/*.ts                → Check ok
$ bun <descriptor-kit>/src/cli.ts check .                        → descriptor: ✓ no drift
$ bun test guest-room.test.ts nopodman.test.ts; ls -d /tmp/gr-feature-*  → 34 pass, no leaked run dirs
```
(Fix-round numbers, from a fresh clone at `/tmp/fix/gr-cowork-port/guest-room` with all three patches `git am`'d, and re-confirmed on a second fresh clone. `DENO_NO_PACKAGE_JSON=1` works around a sandbox-only `npm:@types/node` resolution failure that reproduces on untouched `main`.)

## Unresolved (and why)

1. **No tracking issue / claim** — off-board item; CLAUDE.md says "No issue → open one" and claim via `claim-ticket.yml`, but the sandbox has no GitHub credentials. Nothing pushed.
2. **Gaps G1–G8 are documented, not closed** — each is a substrate or cross-repo limit: no walls without a container runtime/userns (G1); no egress chokepoint behind an injecting gateway (G2); reach/identity are platform dials (G3); injecting-parent rule lives only in the profile, not in claude-box's netd (G4, needs a claude-box PR — claude-box vendors guest-room as a subdirectory); no `work.sh` launcher (G5, belongs with the consumer's catalog); same-uid peer creds (G6); root-only bun (G7, a Python client is out of scope); no transit grants (G8).
3. **Release intent + rulebook path fix landed in the fix round** (commit 3); the remaining merge blockers are process items — see "Before merging (owner)".
4. The handoff doc's engine gap #1 (guest-side transport selectable in `resolveDoor`) is worked around in the profile (`guest = host`) rather than changed in `mod.ts`, to keep the engine diff at zero.

## Before merging (owner)

- [ ] Open a tracking issue for this work (none exists; CLAUDE.md: "No issue → open one") and claim it via `claim-ticket.yml`.
- [ ] Push `claude/burndown-gr-cowork-port` and open the PR with `Closes #N` (or `Claim-issue: bounded-systems/guest-room#N`) in the body — `pr-claim.yml` fails closed without an open, claimed issue.
- [ ] Let CI run `bunx jsr publish --dry-run` (only `deno publish --dry-run` could be run offline) and `mint plan` over the new `.release/nopodman-profile.md`.
- [ ] Cross-repo follow-ups G2/G4/G5 need a claude-box PR (it vendors guest-room as a subdirectory); nothing here reaches it.

## Ready-to-paste GitHub comment

```
Cowork-sandbox port assessment for guest-room (burndown `gr-cowork-port`, no tracking issue — please open one and attach this).

guest-room itself needs nothing: `bun test` is green here with no podman. The podman coupling is claude-box's (run-netd.sh, claude-box.ts argv, door-relay.ts internal networks). What this patch adds, all in new files behind `profiles/`:
- `profiles/nopodman.ts` — open a room same-host (guest socket = broker socket, private run dir, world-writable dir refused, `HTTPS_PROXY` refused unless `GUEST_ROOM_ALLOW_INJECTING_PARENT=1`, rulebook says NO WALLS, names the gateway, and every GRANTED card ends with the real socket path + `$<NAME>_SOCK` since catalog `use` text cites in-box mounts that do not exist same-host).
- `profiles/allowlist-door.ts` — the egress door's decision (`host=` caveats via `checkCaveats`, fail closed) over a real unix socket; explicitly not a proxy.
- `docs/working-in-a-cowork-sandbox.md` — new gap list G1–G8 naming each thing a default sandbox cannot do and why; two claims about tooling that exists nowhere (`NETD_ALLOW_INJECTING_PARENT`, `./work.sh`) corrected.
- `.release/nopodman-profile.md` — mint intent, bump: minor (two new entrypoints).
Proven by `features/nopodman.feature` + `nopodman.test.ts` (131/131 pass); engine files untouched; `deno publish --dry-run` passed locally (CI's `bunx jsr publish --dry-run` not run offline); README claims block regenerated, descriptor-kit `check .` → no drift.

Apply: `git checkout -b claude/burndown-gr-cowork-port main && git am 0001-*.patch 0002-*.patch 0003-*.patch && bun test`.
Not done: claude-box side (G2/G4/G5) — cross-repo.
```

## Fix round

Verdict-A (correctness): no must_fix. Verdict-B (scope/mergeability): three must_fix.

| must_fix | What was done |
|---|---|
| B1: add `.release/nopodman-profile.md` intent (bump: minor) | Added, in the format of `.release/grant-in-call.md`; one line summarizing the two new entrypoints and the fail-closed rules. (commit 3) |
| B2: open tracking issue, claim via `claim-ticket.yml`, `Closes #N` in PR — `pr-claim.yml` fails closed | PROCESS item (needs owner GitHub credentials; nothing pushed). Listed under "Before merging (owner)" above. |
| B3: rulebook reuses catalog `use` text naming in-box paths (`/run/doors/netd.sock`) that do not exist same-host | `sameHostDoor` now appends `sameHostNote(path, envKey)` to `use`: "Same-host: this door is the unix socket at <real path> ($<NAME>_SOCK); any other path named here does not exist in this launch." Tested for a catalogued door and for resolveDoor's uncatalogued `/run/<name>.sock` fallback; doc paragraph says `$<NAME>_SOCK` is authoritative. (commit 3) |

Nits also taken: `runDir` throws instead of falling back to `/tmp` when HOME is unset (A1/B-nit, tested); `guest-room.test.ts` removes its per-scenario run dirs in `afterAll` (A2/B-nit, verified no `/tmp/gr-feature-*` left); `assertPrivateDir` documents its immediate-parent/other-writable scope (A4/B-nit); README pin for `guest-room.test.ts` regenerated and descriptor-kit `check .` actually run → no drift (A3); report wording now says `deno publish --dry-run` passed *locally* and names the real CI gate (B-nit). Not taken: listing `profiles/allowlist-door.ts` in the README tree and narrowing the two `expect<unknown>` TS2769s (same pattern as pre-existing `interpose.test.ts`).
