---
title: Boot Attestation Policy
status: draft # draft | reviewed | canonical
last_reviewed: 2026-08-13
sources:
  - .claude/boot.sh
  - .claude/README.md
  - .github/workflows/attest-boot.yml
  - https://slsa.dev/provenance/v1
---

# Boot Attestation Policy

The verification predicate for the bootstrap chain's Sigstore provenance,
written as a literal statement of what must be true, and of what happens when
it is not.

`attest-boot.yml` has produced provenance since 2026-08-10. Nothing consumes
it. That ordering is backwards — the predicate should have been written before
the attestation lane, because an attestation with no stated predicate is
decoration with a cryptographic aesthetic. This file is the retrofit.

Grades follow `positioning.md`:

- **Enforced** — a test or gate fails when the property is violated.
- **Partial** — holds in some cases, by hand or by one-off code.
- **Aspirational** — stated, nothing checks it.

## What provenance adds, and what it does not

The digest chain (`.claude/README.md`, "Why the chain has three links") already
decides **what executes**: the field text refuses `boot.sh` unless it hashes to
the digest the channel manifest names (`channel/front-desk.json`, written only by
the OIDC-pinned `boot-manifest` lane on `main` — since #192 there is no
`ORG_BOOT_SHA256` in the dialog at all), and `fetch_verified` refuses the four
fetched files unless they hash to `boot.sh`'s pinned `SUM_*`. That chain fails
closed and does not need the network.

What no digest can say is **who produced the bytes**. "Matches the number in the
dialog" is not "came from this repo's `main`". Provenance is the signed
statement that binds a digest to a builder identity. It is a second, independent
claim — it does not replace the digest chain and must not be described as
strengthening it.

**Identity is content-addressed, not labelled.** The subject of every claim
below is a sha256. Names (`boot.sh`, `$PIN`) are mutable pointers *to* digests,
never the identity itself.

**Image identity is not instance identity.** These digests say what the boot
chain *is*. They say nothing about which boot this is, when it ran, or under
whose authority. That is a separate runtime record which *references* the
digest, and it is out of scope here — see the door/receipt vocabulary in
`.github-private` → `docs/org-map.md`.

## The predicate

For each subject file **S** installed by the bootstrap, the following must all
hold, or S is refused:

| Field | Required value |
| --- | --- |
| Subject digest | sha256 of S, matching the corresponding `SUM_*` in `boot.sh` |
| Predicate type | `https://slsa.dev/provenance/v1` |
| Source repo | `bounded-systems/.github` |
| Signer workflow | `.github/workflows/attest-boot.yml` |
| Source ref | `refs/heads/main` |
| OIDC issuer | `https://token.actions.githubusercontent.com` |

Subjects are exactly `boot.sh` plus the seven files `fetch_verified` installs:
`session-start-dispatch.mjs`, `register-mcp.mjs`, `stop-hook-git-check.sh`,
`setup-toolpath.sh`, `chat-fetch.sh`, `verb-server.mjs`, `harness-settings.mjs`.

This list, `attest-boot.yml`'s `subject-path`, its push path filter, and its
run-summary loop are all the same list. That used to be stated as an instruction
— "if one grows, the other must" — and the instruction failed: `setup-toolpath.sh`
joined the fetch set in #195 and was missing from every one of them until #534.
All four copies are now asserted against `boot.sh`'s actual `fetch_verified`
calls by `.claude/bootstrap-pin.test.mjs`, which parses them with the same
`parseBootstrap` that backs the pin gate. Adding a file to the fetch set fails
that suite until each copy is updated; this document is one of the copies.

As a command:

```sh
gh attestation verify "$S" \
  --repo bounded-systems/.github \
  --signer-workflow bounded-systems/.github/.github/workflows/attest-boot.yml \
  --cert-oidc-issuer https://token.actions.githubusercontent.com \
  --predicate-type https://slsa.dev/provenance/v1
```

`--owner` alone is **not** the policy and must not be used: it accepts any
workflow in any repo under the org, which is a much larger set of signers than
intended. `--repo` alone is likewise too weak — it accepts any workflow in this
repo.

**Open question — pinning the ref.** `--signer-workflow` constrains repo and
workflow path but not the ref, so as written the predicate accepts a run of
`attest-boot.yml` from a branch. The ref belongs in the certificate identity
(`…/attest-boot.yml@refs/heads/main`), reachable via `--cert-identity` instead
of `--signer-workflow`. The exact accepted form varies by `gh` version and has
**not** been verified against the version this org ships. Verify before relying
on the ref clause; until then treat the ref row above as Aspirational and the
rest of the table as the enforceable part.

## Where the predicate is enforced

**At the pin bump, not at boot.** This is the load-bearing decision.

`boot.sh`'s `PIN`/`SUM_*` block is the moment a new digest *becomes* trusted —
that is when provenance is worth having, and it happens in CI, online, with a
Sigstore trust root already available. Enforce there: the bump PR fails closed
if any subject's provenance does not satisfy the predicate.

At boot, the digest chain carries the claim transitively. A session that
verifies `SUM_*` is relying on a digest that was provenance-checked when it
entered the chain.

This is what terminates the regress. Verifying at boot would need network and a
pinned trust bundle in whatever image does the verifying — and that image then
needs its own provenance story. Moving enforcement to CI ends it at a boundary
that is already online and already gated, rather than pushing it onto a booting
instance whose whole design goal is to need neither.

A scheduled drift lane may re-verify continuously and fail loudly. That is
monitoring, not the gate.

## What happens on failure

| Where | On failure |
| --- | --- |
| Pin-bump PR | **Fail the check.** The bump does not merge; the digest never enters the chain. |
| Drift lane | **Fail the run**, loudly. Does not stop a session already booting. |
| Session boot | **Nothing** — boot does not verify provenance. The digest chain's existing fail-closed behaviour is unchanged: a mismatched file is deleted rather than left where something might execute it, and with no verified dispatcher no `settings.json` is written at all. |

Log-and-proceed is not an option at any row. If a future change adds
provenance verification to the boot path, it inherits the fail-closed rule —
a session with no hooks beats a session running unattested code.

## Current state

- Provenance is produced for all four subjects on push to `main`. **Enforced**
  (`attest-boot.yml`).
- The predicate above is stated. **Aspirational** — no gate evaluates it.
- Ref pinning. **Aspirational**, and blocked on the `gh`-version question above.
- Offline verification. **Not attempted.** Deliberate: see the regress argument.

The next implementation step is a check on the pin-bump path that evaluates the
table in "The predicate" and fails closed. It is not written here because the
predicate had to exist first.

## Known gap

`attest-boot.yml`'s run summary tells readers to verify with
`gh attestation verify <file> --repo bounded-systems/.github` — the weak form
this file rejects. Fixed in the same change that added this document, so the
copy-pasteable command and the policy agree.
