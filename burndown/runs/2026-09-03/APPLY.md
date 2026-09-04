# Apply — verified 2026-09-03T12:5xZ

Every patch set below was applied with `git am` to a fresh clone of its repo at the
head shown, with no conflicts. Use `git am`, not `git apply`: three of these are
multi-commit series where later commits depend on earlier ones.

Run from inside a clone of the target repo, with `$RUN` pointing at this directory
(e.g. `RUN=~/.github/burndown/runs/2026-09-03`).

| item | repo | head verified against | command |
|---|---|---|---|
| trellis-2 | trellis | 40ec246 | `git am $RUN/trellis-2/*.patch` |
| claude-box-245 | **prx** | 9de9551 | `git am $RUN/claude-box-245/*.patch` |
| prx-360 | prx | 9de9551 | `git am $RUN/prx-360/*.patch` |
| prx-270 | prx | 9de9551 | `git am $RUN/prx-270/*.patch` |
| gr-cowork-port | guest-room | e6c3896 | `git am $RUN/gr-cowork-port/*.patch` |
| conformance-25 | conformance | 293dd55 | `git am $RUN/conformance-25/*.patch` |
| gpr-10 | gh-project-room | f28b2b2 | `git am $RUN/gpr-10/*.patch` |
| synoptic-1 | synoptic | be917d0 | `git am $RUN/synoptic-1/*.patch` |
| synoptic-4 | synoptic | be917d0 | `git am $RUN/synoptic-4/*.patch` |
| mint-18 | mint | 3e1ef40 | `git am $RUN/mint-18/*.patch` |
| fds-1 | front-desk-scheduler | 19437d5 | `git am $RUN/fds-1/*.patch` |
| site-32 (a) | site | 0ede7fd | `git am $RUN/site-32/site-0001-readme-naming.patch` |
| site-32 (b) | bounded.tools | 6c7299c | `git am $RUN/site-32/bounded.tools-0002-readme-not-the-website.patch` |

Note the two cross-repo cases:
- **claude-box-245 applies to `prx`**, not claude-box. The scout found the unqualified
  image default lives in `packages/prx/src/room/claude-room.ts`.
- **site-32 is two patches for two different repos**, named by repo rather than numbered.

No patch: `dev-contracts-2` (withdrawn in review — needs credentials and an owner
decision), `prx-230` and `site-40` (already resolved / stale; each REPORT.md carries a
closing comment with commit evidence).

## Before any of these merge

`pr-claim` fails closed on an unclaimed issue in every one of these repos. Claim the
issue first (`claim-ticket.yml` in bounded-systems/.github), then open the PR with the
`Claim-issue:` / `Closes` line that repo expects. Each REPORT.md has the per-item
checklist.
