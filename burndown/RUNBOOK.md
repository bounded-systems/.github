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

    apply   (no template)  clone each target repo fresh, `git am` the patches, record the
                           head SHA tested against. Use `git am`, not `git apply` —
                           multi-commit series depend on order. A patch that does not
                           apply is FAILED, not done.

Verifiers default to REFUTED. Two lenses beat two identical refuters.
Output of a run: `out/<id>/*.patch`, `REPORT.md` (with ready-to-paste issue
comment + owner checklist), `result.json`, `verdict-*.json`, `out/SUMMARY.md`,
and `out/APPLY.md` — the command table with the head SHA each set was tested
against. Two traps APPLY.md must call out explicitly, both hit in run 01:
an item can patch a *different repo* than its issue lives in (claude-box#245's
defect was in prx), and a fix-round agent may rename patch files off the
`000N-` convention (site-32).

## 3. Trigger
Scheduled task "Burndown — nightly Desk work run" (06:00 UTC, fresh cloud
session). It clones bounded-systems/.github; if this kit is absent it does
NOT improvise a queue — it fetches the board, reports the top workable
unclaimed issues, notes that the kit is unapplied, and stops. Same prompt
works as a `/burndown` skill.

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
