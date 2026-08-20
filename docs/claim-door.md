# The claim door

Claim an issue before working on it, so two agent sessions never start the same
ticket.

`_claim.yml` in this repo is the **one implementation**. Every consumer is a
caller of about ten lines. This repo is public, so the reusable is callable from
any repository — inside this organization or outside it.

## Adopt it

Drop this in the consuming repository as `.github/workflows/claim.yml`:

```yaml
name: claim

on:
  workflow_dispatch:
    inputs:
      issue:
        description: "Issue number in this repository"
        required: true
        type: string
      claimant:
        description: "Claimant identity, e.g. claude-session/my-branch"
        required: true
        type: string
      release:
        description: "Release an existing claim instead of taking one"
        type: boolean
        default: false

permissions:
  contents: read

jobs:
  claim:
    uses: bounded-systems/.github/.github/workflows/_claim.yml@<commit-sha>
    permissions:
      contents: read
      issues: write
    with:
      issue: ${{ inputs.issue }}
      claimant: ${{ inputs.claimant }}
      release: ${{ inputs.release }}
```

That is the whole adoption. Pin `@<commit-sha>`, not a branch.

**No secret is needed.** The door runs against the caller's own repository with
the caller's built-in `GITHUB_TOKEN`, and `issues: write` is exactly and only
what a claim record uses — no App, no PAT, no OIDC broker. That is why it
travels.

## Using it

Dispatch the caller with the issue number and a claimant string, then **confirm
on the issue, not the run list**. A `workflow_dispatch` does not return its run
id, so a caller cannot identify its own run. Your claim exists iff the claim
comment on the issue names your claimant and the label is present.

An issue carrying any assignee or the `claimed` label is someone else's. Do not
start.

Release by re-dispatching with `release: true`, or by removing the label and
unassigning.

## What a claim is

The `claimed` label plus a comment naming the claimant. The assignee is a
best-effort human-facing projection — agents and bots are usually not
assignable, so assignment is never load-bearing, and a failed assignment never
fails a run whose record already landed.

## What it does and does not establish

It establishes that the record was written by a workflow rather than authored by
the guest, and that a run exists as an audit trail.

It does **not** authenticate the claimant. Anyone who can dispatch the caller can
pass any `claimant` string. **It buys exclusion between concurrent sessions, not
proof of authorization** (`.github-private`#530). Do not read a green run as
issuer-attested; closing that gap needs an authenticated guest identity, not
more workflow plumbing.

## Relationship to the other doors

- **`claim-ticket.yml`** (this repo) stays as it is: the lease-backed door, with
  a brokered App identity and a different threat model. It writes claims *into
  other repos* in this org, which is why it needs a minted credential.
- **`_claim.yml`** is the door that was always meant to travel — it writes a
  claim in the repository that calls it, and needs nothing to do so.

Any repository still carrying a **copy** of the relay should replace it with a
caller. The copies are what this file exists to end: two implementations of one
convention drift, and the drift is invisible until a claim gets stuck
(`.github-private`#652).
