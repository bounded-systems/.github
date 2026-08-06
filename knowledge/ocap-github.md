---
id: ocap-github
title: ocap-github (GitHub permissions as door objects)
type: capability
status: Aspirational
tracking: https://github.com/bounded-systems/.github/issues/104
last_reviewed: 2026-08-06
sources:
  - scripts/gh-permission-reconcile.mjs
  - scripts/gh-permissions-docs.json
  - docs/session-capability-invariants.md
  - https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
  - https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps
---

# ocap-github (GitHub permissions as door objects)

A GitHub App permission is a [[ocap-doors|door]] expressed in someone else's
vocabulary. `ocap-github` is the sibling of `ocap-provenance`: the contract that
makes that permission a **constructed value** rather than a string copied between
six maps, so `granted ⊆ declared ⊆ installed` is one checkable chain instead of
three bespoke checks in three repos.

The registration surface is the missing end of that chain. GitHub's App manifest
carries `default_permissions` as data, so a door can be *authored* and projected
to the manifest, the URL-parameter registration form, the preflight `require:`
list (I3), and the probe target set (I2) — one value, four surfaces, the
`descriptor-kit` idiom. Today `declared` lives only in a hand-filled web form,
which is why nothing can compare it to anything.

## Why it is not an enum

GitHub publishes this vocabulary **twice**, and the two disagree in both
directions. `scripts/gh-permission-reconcile.mjs` measures the gap rather than
guessing across it:

- **The wire** — `app-permissions` in `github/rest-api-description`: 55 slugs
  with exact levels; what `default_permissions` and token-mint actually accept.
- **The grant** — the docs page an installer approves from: prose only,
  transcribed into `scripts/gh-permissions-docs.json`.

Measured 2026-08-06: 36 grant entries have no wire slug, 14 wire slugs no grant
entry claims, and 4 resolved pairs disagree on levels. The display name does not
determine the slug — `Members` is `members`, with no `organization_` prefix,
which is the case that kills prefix-as-plane and with it any probe that derives
its target from the slug.

**The lattice is not `read < write < admin`.** 8 of 55 deviate: four admit
`admin` (including `organization_projects`, the Front Desk door), `profile` and
`workflows` are write-only, `organization_events` and `organization_plan`
read-only. So `workflows: read` is unconstructible — a fact no string map can
state, and the reason `unsafePrivilegedApp` matches on key presence instead of
level.

**The vocabulary moves and it is theirs.** `organization_issue_types` has no wire
slug at all, and org Issue Types is `gh-issues-room`'s declared door.

## What is measured, and what cannot be

Endpoint→permission is absent from the description (0 of 1220 operations) and is
recoverable only from `X-Accepted-GitHub-Permissions` on a 403. Webhooks carry
`supported-webhook-types` but no permission field. **GraphQL has no discovery
mechanism at all** — which matters because ProjectV2 is GraphQL-only, so the
org's most-used door sits on the one surface where authority can only be probed,
never read.

API version is not the drift axis: `2022-11-28` and `2026-03-10` yield identical
`app-permissions`. Drift is the schema's content digest over time — the same
pinning idiom the bootstrap already uses, and where effects land in the
[[provenance-chain]].
