# trellis-2 — Flip keeper-wire contract-check to blocking

Issue: https://github.com/bounded-systems/trellis/issues/2
Branch: `claude/burndown-trellis-2` (3 commits on top of main `40ec246`), not pushed.
Work tree: `/tmp/fix/trellis-2/trellis` (fix round; original worker tree was `/tmp/work/trellis-2/trellis`)

## Scouting result: drift is fixed, the flip is safe

Re-checked every scout claim against the sources (not the scout's port — the
repo's own `check/*.ts` scripts run with the local deno 2.9.6):

- door-kit#21 (`ledgerRef` vs `manifestDigest`): closed. Fixed by correcting the
  agreement — keeper-wire `bc59436` declares `ledgerRef`; trellis #16 (`fc9c3c6`)
  re-pinned it and skips the `kind` discriminator.
- door-keeper#15 (stale vendored client): closed by door-keeper PR #32
  (`d9c6917`, 2026-08-15). The pinned door-keeper `cd370da` (#19) already
  re-synced the vendored client; trellis #17 (`6a6e874`) re-pinned it.
- At the pins on main (all 2026-07-04) all seven flake checks pass:
  keeper-wire / scout-wire / concierge-wire CONFORM, door-kit-mirror
  byte-identical, sanctioned-reader-seam, descriptor-honesty, lattice pass.
- The signed `status` branch (built by CI from main `40ec246`, 2026-08-30) records
  the same seven passes. The one `fail` there (`trellis-kit-lattice`) is a
  registry/flake name mismatch, not a `nix flake check` output — see Unresolved.
- CI run 33282224080 on main: job `contract-check` succeeded (only warning:
  FlakeHub auth).

Two things the scout got wrong / missed, both handled:

1. **Re-pinning only the keeper trio breaks scout-wire.** door-kit HEAD's scout
   client already calls `repos/project/orgOpenWork/orgMergedPrs`, which the pinned
   door-scout + scout-wire lack (`scout-wire: 4 discrepancy(ies): [client]
   extra-method: project, repos, orgOpenWork, orgMergedPrs`). All seven door/wire
   inputs must move together; at full upstream HEAD everything conforms.
2. **flake.lock is missing `drift-gate` and `guest-room`** (declared in flake.nix
   since #29 but never locked), so every CI run silently re-locks them at HEAD.

## What changed

| commit | files | change |
|---|---|---|
| `3475770` ci: make contract-check a blocking gate | `.github/workflows/ci.yml`, `flake.nix`, `README.md` | Removed `continue-on-error: true` from `contract-check`; rewrote the job comment as a blocking gate. Retired stale "red / report-only" comments in flake.nix (keeper-wire, scout-wire, door-kit-mirror, sanctioned-reader-seam, lattice) and the README prose + status-table rows for keeper-wire and door-kit-mirror; README status section now lists all seven verified types (adds concierge-wire, descriptor-honesty). No check logic touched. |
| `33603db` chore: re-pin door daemons + wire agreements | `flake.lock` | door-keeper `cd370da→5984e37`, door-kit `4b72a33→b817c07`, keeper-wire `bc59436→9d5bec6`, door-scout `2b047ec→f4bb596`, scout-wire `79bedb3→d54a43f`, door-concierge `eebbcb9→30baa93`, concierge-wire `24ca9af→2dd43ac` (all = upstream `origin/main` on 2026-09-03). |
| `1ab2c6a` chore: lock drift-gate + guest-room | `flake.lock` | Adds the two missing entries (drift-gate `af65bea`, guest-room `e6c3896`) and the `root.inputs` references. |

Patch 0001 alone satisfies the issue (current pins already conform). 0002 and 0003
are separable: `git am 0001-*.patch` for the minimal fix, or all three.

**Lock entries were hand-computed (no nix here).** `narhash.py` (included)
serialises a tree to NAR and sha256s it; `lastModified` = committer timestamp
of the rev. The method was validated by reproducing all nine existing lock
entries bit-for-bit (narHash and lastModified, 9/9 MATCH) before computing the
new ones. `nix flake lock --update-input <name>` regenerates the same entries if
a maintainer would rather not trust a hand-edit.

## Verify output (trimmed)

Full logs: `verify-head.log` (checks at the new pins), `verify-repo.log` (repo gates).

All seven flake checks, run as the derivations run them, against the inputs
checked out at the NEW pins (`/tmp/work/trellis-2/inputs-head`):

```
keeper-wire: CONFORMS — daemon + client match the agreement.           exit=0
scout-wire: CONFORMS — daemon + client match the agreement.            exit=0
concierge-wire: CONFORMS — daemon + client match the agreement.        exit=0
diff -q door-keeper/lib/keeper.ts  door-kit/lib/keeper.ts              exit=0
diff -q door-keeper/lib/runtime.ts door-kit/lib/runtime.ts             exit=0
sanctioned-reader-seam: fs UPHOLDS its claim (prod ⊆ [node:fs, node:path], no ambient authority).  exit=0
descriptor-honesty: guest-room UPHOLDS its descriptor — 10 trellis claims checked against 10 README pin rows.  exit=0
lattice: one agreement per pair, and a build DAG. ✓                    exit=0
```

Same eight commands at the OLD pins (main's flake.lock): all exit=0 as well.

Repo gates on the branch HEAD:

```
deno check  (11 files)   Checked — exit=0
deno lint                Checked 17 files
deno fmt --check         Checked 17 files — exit=0
deno test --allow-read   ok | 36 passed | 0 failed
! grep -q continue-on-error .github/workflows/ci.yml   exit=0
yaml parse ci.yml: jobs=[contract-check, deno, overlap, status]; continue-on-error in contract-check: False
```

Caveat on the deno gates: jsr.io and registry.npmjs.org are blocked in this
sandbox, so `deno check`/`deno test` ran with an import map pointing
`@bounded-systems/trellis-kit` → a clone at v0.1.0, `verbspec` → a clone at
v0.3.1, `zod@4.4.3` → a local copy, and `@std/assert` → a 20-line shim
(`assert`/`assertEquals`). `deno lint` and `deno fmt --check` ran unmodified.
The check scripts under test (`check/*.ts`) are dependency-free and ran exactly
as in the derivation (`deno run --no-remote --allow-read`).

### What could not be run: `nix flake check`

Not installed and not installable to a useful state here: nixos.org,
install.determinate.systems, releases.nixos.org, cache.nixos.org,
cache.flakehub.com and codeload.github.com all return 403/blocked through the
sandbox proxy. The Determinate installer binary itself is downloadable from
GitHub releases, but without nixpkgs source or a binary cache the `runCommand`
derivations (which need `pkgs.deno`) could not be evaluated or built. The
authoritative proof is the `contract-check` job on the PR.

## Unresolved

- `nix flake check` itself was not executed (above). Risk is confined to the
  hand-computed flake.lock entries in 0002/0003; if nix rejects one, the fallback
  is `nix flake lock` on the branch, or apply 0001 only.
- `status.json` reports `trellis-kit-lattice` as `fail`: `registry.ts` marks it
  `verified: true` but no `checks.<sys>.trellis-kit-lattice` flake output exists
  (the flake check is named `lattice`; the real guard is `check/lattice_test.ts`
  in the deno job). Does not affect `nix flake check` or this gate. Out of scope
  — worth its own issue (alias the check name or mark the type unverified).
- README still references `specs/keeperd.ts` / `specs/keeper-wire.json` /
  `deno task gen`, which no longer exist (the agreement moved to keeper-wire).
  Left alone as unrelated to #2.
- Not pushed; no PR opened; no Front Desk claim dispatched (claims.bounded.tools
  and issues.bounded.tools are unreachable from this sandbox). See "Before
  merging (owner)".

## Before merging (owner)

Process items that cannot be done from the sandbox; the patches are complete
without them, but the PR will not pass the repo's required checks until they are.

- [ ] **Claim issue #2 before opening the PR.** `.github/workflows/pr-claim.yml`
      fails any PR whose `Closes #N` issue is open but unclaimed, and #2 currently
      has no Front Desk claim or assignee. Dispatch `claim-ticket.yml` for #2 (or
      assign yourself + leave a comment noting the claim window was unreachable).
- [ ] Push `claude/burndown-trellis-2` (or `git am` the three patches onto a
      branch of your own) and open the PR with `Closes #2` in the body. Say in
      the description that 0002 and 0003 are optional/separable — 0003 goes
      beyond the issue text (locks drift-gate + guest-room) and can be dropped if
      you prefer those inputs unpinned.
- [ ] Watch the `contract-check` job on the PR: it is the first real
      `nix flake check` at the new lock (nix was unavailable in the sandbox). If
      nix rejects a hand-computed entry, run `nix flake lock` on the branch or
      merge 0001 alone.

## Ready-to-paste GitHub comment

```
Both blockers are closed (door-kit#21 via the corrected keeper-wire agreement, door-keeper#15 via door-keeper#32) and every check `nix flake check` runs is green at the pins on main — the signed `status` branch from 40ec246 agrees. Patch series flipping the gate:

1. `0001` drops `continue-on-error` from `contract-check`, retires the stale "red / report-only" comments in ci.yml, flake.nix and README, and brings the README status table up to the seven verified types. This alone closes #2.
2. `0002` (optional) re-pins door-keeper/door-kit/keeper-wire **and** door-scout/scout-wire/door-concierge/concierge-wire to current HEAD — they must move together (door-kit's scout client already speaks the 4 methods the old door-scout pin lacks; a keeper-only bump turns scout-wire red). All 7 checks verified CONFORMS at these revs.
3. `0003` (optional, and beyond the literal issue text) adds the `drift-gate` + `guest-room` lock entries flake.nix declares but flake.lock never had, so the now-blocking gate stops re-locking them at HEAD on every run. Drop it if you'd rather keep those two unpinned.

Apply: `git checkout -b flip-contract-check main && git am 000*.patch` (or `git am 0001-*.patch` for the minimal change). Lock entries in 0002/0003 were computed without nix (method validated against all 9 existing entries); `nix flake lock` regenerates them identically if preferred. The green `contract-check` job on the PR is the final proof.
```

## Fix round

Verdicts A (correctness + reproducibility) and B (scope + mergeability) both
returned `refuted: false`. must_fix items and what was done:

- **B must_fix — issue #2 is unclaimed, so `pr-claim` would fail the PR.**
  Process, not patch: claims.bounded.tools is unreachable from this sandbox.
  Added the "Before merging (owner)" checklist above with the exact steps.

Nits that were patch-level and cheap were also taken (fresh clone at
`/tmp/fix/trellis-2/trellis`, `git am` of the old series, commits amended —
history stays at three commits):

- Commit subjects: dropped the `(#2)` suffix (it mimicked the squash-merge PR
  suffix) and shortened 0001's ~90-char subject to
  `ci: make contract-check a blocking gate`; `Closes #2` stays in 0001's body.
- flake.nix: the keeper-wire check comment no longer cites the removed
  `specs/keeper-wire.json` (folded into 0001).
- README status section: "Five types are `verified` … three kinds" → seven
  types / four kinds, with rows for `concierge-wire` and `descriptor-honesty`
  matching `registry.ts` (folded into 0001).
- Ready-to-paste comment now says explicitly that 0003 is beyond the issue text
  and droppable.

Nits deliberately left: README's `specs/keeperd.ts` / `deno task gen` prose
(unrelated to #2) and the `trellis-kit-lattice` status.json name mismatch
(separate issue).

Re-ran after the rewrite: `git am` of the regenerated patches on a fresh clone
of `40ec246` — clean; `deno fmt --check` / `deno lint` — 17 files, clean;
`continue-on-error` absent from ci.yml (grep + YAML parse of all four jobs);
all seven checks with the flake.nix invocations at the new pins — keeper-wire /
scout-wire / concierge-wire CONFORMS, door-kit-mirror byte-identical,
sanctioned-reader-seam UPHOLDS, descriptor-honesty UPHOLDS, lattice ✓ (all
exit 0). Patches regenerated with `git format-patch 40ec246..HEAD`.
`nix flake check` itself is still unexecuted (no nix in the sandbox).
