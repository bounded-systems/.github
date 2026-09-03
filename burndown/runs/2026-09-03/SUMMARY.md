# Burndown run — 2026-09-03

Source: Desk board snapshot 2026-09-03T01:18Z (issues.bounded.tools). 15 items scouted, 15 worked, 13 patched, 26 two-lens adversarial verdicts, 13 fix-round agents, 10 final re-verifications. Nothing pushed; patches are the delivery unit.

**Systemic finding (instrument, not patch):** every repo's `pr-claim` check fails closed on an unclaimed issue, and none of these issues are claimed. Nothing here merges until you claim each issue (claim-ticket.yml in bounded-systems/.github) and open the PR with the `Claim-issue:`/`Closes` line the repo expects — each REPORT.md has an owner checklist. Second constraint: this sandbox blocks npm/jsr, so 'verify passed' means the touched files' tests ran with vendored or stand-in deps; CI is the authoritative gate for every item.

| id | repo#issue | outcome | patches | verify | final verdict | apply |
|---|---|---|---|---|---|---|
| claude-box-245 | claude-box#245 | partial | 1 | True | confirmed | `git am out/claude-box-245/*.patch` |
|  |  | prx: claude-room image pinned to ghcr.io/bounded-systems/claude-box/claude-room:0.7.0 (was bare claude-box -> docker.io 404) with tests + changeset; grep verify + room spec/pod/podman tests pass. Addresses request 3 of c |  |  |  |  |
| conformance-25 | conformance#25 | partial | 1 | True | confirmed | `git am out/conformance-25/*.patch` |
|  |  | Added scripts/audit/release-tags.ts (+lib, 13 fixture unit tests, workflow, README, deno tasks): per-repo PASS/FAIL/UNKNOWN/SKIP table with evidence for mint-released repos vs refs/tags/* creation rulesets. Fix round: wo |  |  |  |  |
| dev-contracts-2 | dev-contracts#2 | partial | 0 | False | confirmed | `git am out/dev-contracts-2/*.patch` |
|  |  | No patch. The original commit (.trunk/.gitignore + trunk.yaml lint.ignore + contracts.toml entry) was withdrawn after review: .trunk/.gitignore re-added a file the maintainer deleted in fe6d335 and duplicated the generat |  |  |  |  |
| fds-1 | front-desk-scheduler#1 | partial | 1 | True | confirmed | `git am out/fds-1/*.patch` |
|  |  | Delta sync already shipped (f3c0f61, 1b1683c, 3f9285a/#57); patch adds DeltaIo seam + test/sync-delta.test.ts proving a second sync after one change fetches and writes only that delta (5/5 pass; suite otherwise unchanged |  |  |  |  |
| gpr-10 | gh-project-room#10 | partial | 1 | True | confirmed | `git am out/gpr-10/*.patch` |
|  |  | Added pure window-meter.ts (consumedPoints per rolling/calendar window) and wired it into budget-check.ts via --ledger + pure evaluate(); tests assert accumulate-per-window and reset-at-boundary; 34/34 network-free tests |  |  |  |  |
| gr-cowork-port | off-board | partial | 3 | True | confirmed | `git am out/gr-cowork-port/*.patch` |
|  |  | Added the nopodman profile (same-host doors whose rulebook cards name the real socket path, injecting-parent refusal, allowlist decision door) with feature+socket tests, a .release intent, and a G1-G8 gap list in docs/wo |  |  |  |  |
| mint-18 | mint#18 | done | 1 | True | confirmed (A+B) | `git am out/mint-18/*.patch` |
|  |  | README gains 'First release' (two numbered bootstrap paths + CI variant) and 'Tag creation under rulesets — the bypass actor' (actor per path: releaser's account vs github-actions[bot]/GITHUB_TOKEN, rejection signature,  |  |  |  |  |
| prx-230 | prx#230 | closing comment | 0 | True | n/a (no patch) | `git am out/prx-230/*.patch` |
|  |  | Already fixed on main (0312766/2701169/9e5424e): planner prompt embeds the pinned issue body; named test 'embeds the consumed source body' passes (91/91 in runtime_profiles.test.ts). No patch; closing comment in REPORT.m |  |  |  |  |
| prx-270 | prx#270 | done | 1 | False | confirmed | `git am out/prx-270/*.patch` |
|  |  | Extended the existing top-of-file JSDoc on packages/prx/src/intake/intake-source.ts to state human/agent invocation + GH-292 signing and to describe all five exports, and (fix round) added an empty changeset so changeset |  |  |  |  |
| prx-360 | prx#360 | done | 1 | True | confirmed | `git am out/prx-360/*.patch` |
|  |  | Tester leg now opens the implement session with role=tester and is served a dedicated read-only tester SDK profile (own spawn@tester) instead of the executor profile + plan; fix round added omitOwnNamespace so the tester |  |  |  |  |
| site-32 | site#32 | done | 2 | True | confirmed (A+B) | `git am out/site-32/*.patch` |
|  |  | Both READMEs state which repo is which (site = website, bounded.tools = prx receiver Worker) with cross-links, site's Setup block clones site.git, rename proposed but not executed; verify greps pass against patched worki |  |  |  |  |
| site-40 | site#40 | closing comment | 0 | True | n/a (no patch) | `git am out/site-40/*.patch` |
|  |  | Issue is stale/superseded: none of the named homepage strings exist (removed in #84/#219), body prose stays inline by documented decision (#134/#135), all 23 atomic strings already resolve from strings.json, meta-descrip |  |  |  |  |
| synoptic-1 | synoptic#1 | partial | 1 | True | confirmed | `git am out/synoptic-1/*.patch` |
|  |  | Added tokens/axe.ts (tezcatl + embedded axe-core 4.12.1 with a runtime sha256 check, zero violations under WCAG 2.x A/AA tags), an `axe` verb, wired it into check.ts and a macos-14 tokens-check job; both mocks pass, inje |  |  |  |  |
| synoptic-4 | synoptic#4 | done | 2 | True | confirmed | `git am out/synoptic-4/*.patch` |
|  |  | Added an embedded-webfont FontFace token (data: URI @font-face, system stack as fallback tail) with --font-sans as the single font-family source; fix round added the SIL OFL 1.1 notice for the Poppins subset fixture and  |  |  |  |  |
| trellis-2 | trellis#2 | done | 3 | True | confirmed (A+B) | `git am out/trellis-2/*.patch` |
|  |  | Upstream drift confirmed fixed; dropped continue-on-error from contract-check (+stale-comment cleanup, README status table now lists all 7 verified types), optionally re-pinned all 7 door/wire inputs to HEAD and locked t |  |  |  |  |

## Closing comments (no patch needed)
- prx-230, prx-270 (doc existed; small extension patched), fds-1 (delta sync already shipped; test added), site-40 (stale) — each REPORT.md has a ready-to-paste comment with commit evidence.

## Owner actions collected across reports
- Claim every issue before opening PRs (pr-claim fails closed).
- conformance-25: run `GH_TOKEN=<org-admin App token> deno task audit:release-tags` for the live table.
- claude-box-245: make ghcr.io/bounded-systems/claude-box/* public or document `podman login ghcr.io`; repin :0.7.0 → @sha256 in BOX_PINS.
- dev-contracts-2: dismiss the 2 secret-scanning alerts as 'Used in tests' (needs security_events scope); decide on history scrub.
- synoptic-1: first macos-14 CI run is the only real tezcatl/WebKit proof; confirm vendored axe.min.js sha256 against npm.
- trellis-2: run `nix flake lock` to confirm the hand-computed flake.lock entries.

## Not attempted (sandbox_filter)
prx#434 #215 #348 #236 #261, claude-box#195 #220 #131 #132, trust#5, claude-box#200 — need secrets, keeperd, GHCR, on-device runs, or an owner decision.

## Candidates for next run
Re-select from the live board; 221 issues sit below the visible top-25 threshold and were never scored against the sandbox filter.