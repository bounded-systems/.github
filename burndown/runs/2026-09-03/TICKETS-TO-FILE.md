# Tickets to file — none of these were filed

No GitHub credentials existed in the run sandbox, so **zero issues were created,
claimed, commented on, or closed**. Everything below is a finding the run surfaced
that has no ticket. Filing them is a manual step.

## Required before a PR can exist

1. **guest-room — no tracking issue for the nopodman profile.**
   guest-room/CLAUDE.md says "No issue → open one". The `gr-cowork-port` patch set
   (3 commits, nopodman profile + G1–G8 gap list) has nothing to attach to.
   File it, claim it, then `Closes #N` in the PR. Body: attach
   `gr-cowork-port/REPORT.md`.

## New work the run discovered

2. **gh-project-room — the ledger emitter does not exist.**
   `gpr-10` lands the window-meter and a `--ledger` seam, but the thing that writes
   the ledger (telemetry/OTLP source, or the `api_spend` table from
   docs/behavioral-prioritization-delivered.md) is not filed in the repo. Until it
   is, the budget gate stays fail-open in production. This is the blocker on
   actually closing #10.

3. **prx — `--resume` partial-draft path does not re-embed the source body.**
   Found while confirming #230 is already fixed. Different scenario from #230, same
   class of bug: the planner can lose the pinned issue body on resume.

4. **trellis — `trellis-kit-lattice` fails in status.json from a registry/flake
   check-name mismatch.** Unrelated to #2 and not a `nix flake check` failure.

5. **site — `site/CLAUDE.md` line 1 is a stray GitHub 404 JSON blob.**
   Unrelated to #32, left untouched.

6. **site — homepage `<meta name=description>` is 207 chars** (check-seo warns at
   160), and differs from the brand core `description` token by design. Aligning
   them is a brand-repo wording decision, not a strings.json gap.

## Existing issues that need a decision, not a patch

7. **site#39** — the baseline for #40, superseded by the same commits (#84, #219)
   and still open. Close alongside #40.

8. **claude-box#245** — the patch closes only request 3 (the image ref, which lives
   in prx). The docs and public-GHCR-package requests remain open; the PR must not
   say `Closes #245`.

9. **dev-contracts#2** — no patch. Two secret-scanning alerts need dismissing as
   "Used in tests" (needs `security_events` scope), and the history-scrub question
   is yours. The report recommends declining the scrub.
