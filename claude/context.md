<!-- Canonical org context injected into Claude Code sessions at session start.
     Keep this LEAN — it counts against the context window every session.
     Full map: .github-private/docs/org-map.md -->

# bounded-systems — Claude context

**The _door_ — a scope-bounded capability set an agent acts through — is the unit
of bounded authority.** Mechanism-enforced; effects attributable to a signed
owner. `guest-room` is the runtime proof; `claude-box` is one guest plugged in.
_(Org posture: outward-only, composably-published.)_

## Naming (the Hotel)

- **Hotel** — the whole suite of tools.
- **Floor** — a host/VM (e.g. Lima) that rooms run on; provisioned by
  `facilities` (the rename-in-progress of `prx-fleet`).
- **Suite** — a *pod*: rooms sharing one entry/namespace, run as a unit.
- **Room** — a *process*. **Door** — a *set of capabilities* a room acts through.
- **Guest** — an agent. **Front Desk** — the tracking board (org project #2).
- **Concierge** — reserved for a future guest-assist tool.

## Conventions

- Privileged effects are verified against a **signed owner** — git-writes today
  (signing); egress and external reads next.
- Every change moves through **one auditable pipeline to a merged PR** — no direct
  pushes to default branches; commits signed; linear history. **Review is not
  required, and is not the gate** — one maintainer, so the enforceable predicate is
  a *check*, not an approval (`docs/merge-gate.md`).
- **Claim before working.** Doors, best reachable first (#529):
  1. `claim-ticket.yml` (`bounded-systems/.github`, workflow_dispatch: repo,
     issue, claimant) — the real door, lease-backed. Reachable only if
     `.github` was attached at session creation (`add_repo` refuses it).
  2. `claim.yml` (`.github-private`, workflow_dispatch: issue, claimant — a
     caller of `_claim.yml` in `.github`)
     — for `.github-private` issues when door 1 is unreachable. Bot-authored,
     run-backed record; does **not** authenticate the claimant (#530).
  3. Hand-claim (assign + comment) — last resort only, when no door is
     reachable. It provides **no exclusion** (keycard#7, `signerSelfAsserted`);
     say plainly the window was down.
  Whichever door: confirm the claim comment on the issue names your claimant.
  An issue with any assignee or the `claimed` label is someone else's — do not
  start. Work with no issue yet → open one and claim it; the direction
  (2026-08-07) is that **every session's work ties to a Front Desk claim** — a
  session with nothing to claim is the exception to close, not the norm.
- **The declared working set is `claude/session-repos.json`** — and it is
  creation-attached by intent (2026-08-07, #309): a session from the front-desk
  environment should start with every declared repo already checked out. A
  scope warning at start means the selector and the declaration have drifted —
  repair with `add_repo` for this session, and fix the selector for the next.
- **Every quality property is a forcing function** — machine-checked, ratcheted,
  self-documenting; trust is mechanical, not reviewer vigilance
  (`docs/agentic-code-hygiene.md`). Org-wide; `prx` is the reference instantiation.
- **Two license tiers** (#659): the leaf libraries are **MIT**; the `door-kit` /
  `guest-room` runtime is **PolyForm Noncommercial 1.0.0**. Gated by `lic` in
  `registry/generate.ts` — the tier lives in `registry/seed.json`, never in the
  package. Covers the seeded 27 of 45 published packages.

## Map (pointer — full detail in `docs/org-map.md`)

- `prx` — flagship agent-run work-unit CLI (the "bellhop") + `@bounded-systems/*` libs.
- `guest-room` — room+door capability runtime. `claude-box` — Claude Code runtime.
- `ocap-provenance` — shared provenance contract. `keeperd` — signer/verifier room
  (extraction pending). `bounded.tools` — GitHub App receiver. `facilities`
  (`prx-fleet`) — floor/host provisioning.

## If this wasn't auto-injected

If you're reading this only because a human pasted it, this repo is likely
missing the check-in hook. Adopt it once (per-repo `SessionStart` hook) per
`.github-private` → `docs/handoffs/claude-context-injection.md`.
