---
id: provenance-chain
title: Provenance chain
type: capability
status: Partial
last_reviewed: 2026-06-21
sources:
  - https://github.com/bounded-systems/prx
---

# Provenance chain

Every change moves through one content-addressed, auditable pipeline to a merged
PR. `anchored-chain` records the derivation chain — signing, lineage, and
invalidation; `cas` addresses bytes by their SHA-256 digest.

Kin to **in-toto** / **SLSA** in spirit, not (yet) by format — so describe it as
kinship, never as a compliance badge. Authority entering the chain is brokered
through [[bellhop]].
