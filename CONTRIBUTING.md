# Contributing

Thanks for your interest in bounded-systems.

- **One change, one PR.** Every change moves through one auditable pipeline to a
  merged pull request — direct pushes to default branches are not accepted.
- **CI must pass.** `main` in this repo is gated on a required `schema` check;
  other repos gate on their own always-run check.
- **Review is not required to merge.** This org has a single maintainer, and
  GitHub does not permit approving your own pull request — so a required approval
  could only ever be an automated rubber-stamp, which certifies that a review
  happened while certifying nothing about the change. The gate is the check.
  An outside contribution still needs a maintainer to merge it; that is a human
  step, not an enforced review.
- **License:** contributions are accepted under [MIT](https://opensource.org/license/mit) —
  every `@bounded-systems` repository. The repo's own `LICENSE` and package
  manifest remain authoritative if they ever disagree.
- Sign your commits where possible (signed commits are required on protected
  branches).

## Two habits the gates cannot enforce

Most of this org's quality properties are forcing functions — machine-checked,
so nobody has to remember them. These two resist that, because a gate would have
to tell an impossibility claim from ordinary prose. They are here because both
cost real time on 2026-08-01; see
[`docs/session-capability-invariants.md`](docs/session-capability-invariants.md)
for the full set and the evidence.

- **Date every "cannot", and say how you checked.** A recorded impossibility
  without a date and a method is a claim nobody can re-test, so nobody does. The
  costliest wrong sentence that day was an undated one in a code comment — *"MCP
  servers resolve when Claude Code LAUNCHES … so this must happen here, not in
  the dispatcher"* — half true, and the wrong half was the reason nobody had
  considered the fallback that turned out to work. Note the asymmetry: a stale
  *capability* claim costs one retry, while a stale *impossibility* claim closes
  a design direction and nobody reopens it.

- **When a tool you were told to use is missing, say so — do not quietly route
  around it.** The failure that follows a missing capability is not silence. It
  is a plausible answer, produced by other means, that reads exactly like the
  real one. That day a session was told to ask Front Desk's `next` tool and
  explicitly *not* to hand-rank issues from the GitHub API, found no such tool,
  and hand-ranked issues from the GitHub API. Nothing downstream could tell the
  two apart. If you could not use the sanctioned path, the deliverable includes
  which path you did use.
