# burndown — mechanism

Spend spare model budget on Desk-ranked issues, producing verified patches.
Three pieces; each swappable.

## 1. Queue — Desk is the queue of record
`queue.json` is a *selection* over https://issues.bounded.tools, not a second
backlog. Before every run: re-fetch the board (WebFetch; curl to
*.bounded.tools is proxy-blocked), drop anything now on
https://claims.bounded.tools, apply `sandbox_filter`, keep items with a
mechanical `verify` line. No verify line → not ready.

## 2. Runner — Agent fan-out, four stages
The Workflow tool's subagents fail in Cowork sessions (permission handler
strips tool inputs; observed 2026-09-03). Use plain parallel Agent calls,
≤20 concurrent. One prompt file per item per stage under `scout/`:

    scout   <id>.prompt    read-only clone, feasibility + plan + verify_command → scout/<id>.json
    work    <id>.work      branch claude/burndown-<id>, format-patch → out/<id>/ + REPORT.md + result.json
    verify  <id>.verify-A  correctness/reproducibility: fresh clone, git am, re-run checks
            <id>.verify-B  scope/mergeability: issue body, CONTRIBUTING/CLAUDE.md, would-maintainer-merge
    fix     <id>.fix       resolve must_fix items, regenerate patches, owner checklist in REPORT.md
    final   <id>.final     one skeptic confirms every must_fix resolved or correctly deferred

Verifiers default to REFUTED. Two lenses beat two identical refuters.
Output of a run: `out/<id>/*.patch`, `REPORT.md` (with ready-to-paste issue
comment + owner checklist), `result.json`, `verdict-*.json`, `out/SUMMARY.md`.

## 3. Trigger
Scheduled task "Burndown — nightly Desk work run" (06:00 UTC, fresh cloud
session). It clones bounded-systems/.github and fails closed if
`burndown/` is absent there. Same prompt works as a `/burndown` skill.

## Hard limits learned (2026-09-03 run)
- Every repo's `pr-claim` check fails closed on an unclaimed issue. Patches
  cannot merge until the owner claims the issue and opens the PR with the
  repo's `Claim-issue:` / `Closes` line. Claiming needs keeper auth — owner step.
- Sandbox egress: github.com + package registries are *not* all open —
  npm.jsr.io and registry.npmjs.org return 403. "Verify passed" therefore
  means touched-file tests with vendored/stand-in deps; CI is the gate.
- No gh, no push credentials, no podman, no nix. Private repos (clank) blocked.
- Rate limit: a 26-agent fan-out hit the session limit once; batch ≤14 and
  expect a reset window.

## Where it lives
`bounded-systems/.github/burndown/` next to COWORK.md. Apply
`out/dotgithub-kit/*.patch` to install it.
