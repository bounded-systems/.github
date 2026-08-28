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
      human_authorization:
        description: "Keeper token from `node claim-ceremony.mjs`. Required to claim; ignored to release."
        required: false
        type: string

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
      human_authorization: ${{ inputs.human_authorization }}
```

That is the whole adoption. Pin `@<commit-sha>`, not a branch.

**Taking a claim needs a passkey (#264).** Run `node claim-ceremony.mjs` with
`CLAIM_REPO` / `CLAIM_ISSUE` / `CLAIMANT` / `KEEPER_URL` set, approve on your
device, and pass the token it prints. No token is a red run — there is no green
path that skips the ceremony and no break-glass. The keeper sets the window per
request type and a claim's may be as short as two minutes, so fetch the token
immediately before dispatching.

**Releasing does not.** The asymmetry is deliberate: gating release would strand
every claim whose session died, since the holder is gone and the ceremony can
never be completed. Fail closed on acquiring authority, open on giving it up.

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

Since #264 it also establishes that **a human holding an enrolled passkey
approved this exact request** — the ceremony's challenge is a digest over
(repo, issue, claimant), verified by the keeper, which is deliberately not this
run. That is evidence rather than assertion, and it is what the door was missing.

**Read the limit precisely, because it has not moved.** What is attested is that
a keyholder approved *that claimant string* for *that ticket*. It is not proof
that the session doing the work IS the named claimant — a keyholder can approve
any string, and nothing here binds the string to the runtime that presents it.
So the door still buys exclusion plus keyholder authorization, and still not an
**issuer-attested guest identity** (`.github-private`#530). Closing that last gap
needs a session identity to attest, which is the #113 family, not more workflow
plumbing.

## Relationship to the other doors

- **`claim-ticket.yml`** (this repo) is the lease-backed door, with
  a brokered App identity and a different threat model. It writes claims *into
  other repos* in this org, which is why it needs a minted credential.
- **`_claim.yml`** is the door that was always meant to travel — it writes a
  claim in the repository that calls it, and needs nothing to do so.

Any repository still carrying a **copy** of the relay should replace it with a
caller. The copies are what this file exists to end: two implementations of one
convention drift, and the drift is invisible until a claim gets stuck
(`.github-private`#652).
