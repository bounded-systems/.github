---
title: Positioning & Naming
status: draft # draft | reviewed | canonical
last_reviewed: 2026-06-21
sources:
  - profile/README.md
  - https://github.com/bounded-systems/prx
  - https://github.com/bounded-systems/guest-room
---

# Positioning & Naming

Working notes on how Bounded Systems describes itself — the vocabulary the
public surfaces should use, the name for the capability-broker layer, and the
calibration rules that keep every claim honest.

> Grades below (*Enforced / Partial / Aspirational*) are **proposed** and must
> be verified against source before any of this ships to a public surface. They
> are themselves claims; treat them the same way prx treats its own.

## The core synthesis

The themes that feel missing from the site — object-capability, sockets,
fd-passing, "the brokered service" — are not separate. They are one layer: the
**capability broker**. Today guest-room says *"a door is a socket to a brokered
service — you hold the socket, never the keys behind it,"* but the broker has no
name.

**`bellhop` names it.** A bellhop escorts the guest, carries what they ask for,
and never surrenders the master key — a capability broker, exactly. Naming the
tool names the missing layer in one move.

## Naming

| Name | Role | Status |
|---|---|---|
| `prx` | The flagship work-unit CLI; orchestrates a work unit to a merged PR. **Unchanged** — it is established, do not rename. | shipped |
| `bellhop` | The capability broker `prx` (and agents) use to obtain and pass doors. Mediates privileged effects; hands out sockets without surrendering keys. | proposed |
| `guest-room` | The capability runtime — the bounded space behind the door. | shipped |

The hospitality family stays coherent: **guest-room** (bounded space) ·
**doors** (capabilities) · **guest** (agent) · **bellhop** (broker).

Seam to keep clean: `prx` orchestrates work-units → PRs; `bellhop` brokers
authority. They must not bleed into each other.

## Vocabulary — name what's already there, calibrated

The surfaces describe the system in metaphor ("doors," "signed," "auditable")
but rarely use the terms of art that signal real expertise. Add them — but each
becomes a gradeable claim the moment it appears, answering to the same
instrument that graded the rest of the page.

- **object-capability / ocap** — *Enforced (model).* guest-room's narrow-only
  attenuation *is* the ocap model (Miller/E lineage). Say it out loud; it is the
  biggest expertise signal currently left unsaid.
- **sockets / fd-passing** — *Enforced.* The mechanism under "a door is a
  socket": an open file descriptor / mounted socket is an unforgeable capability.
  Live in `claude-box` — per-door bind-mounts give a box only its granted door
  sockets, so a non-granted door is physically absent, not merely denied
  (`door-mounts.test.ts`, VM-verified #159/#161). The `bellhop` broker was a
  speculative home; the mechanism didn't need it.
- **provenance (anchored-chain)** — *Partial.* Real today (derivation chain +
  signing + lineage + content-addressing) but buried in the library table.
  Foreground it; it is a differentiator hiding in a footnote.
- **in-toto / SLSA** — *Aspirational.* Cite as **kinship, not badges**:
  "in-toto-style attestations," "SLSA-style provenance as the goal." Do **not**
  print a SLSA level or "in-toto compliant" unless the exact formats are emitted
  and the exact levels met. This is the canonical over-claim trap.
- **quadlets / podman / systemd** — *Aspirational / unconfirmed.* Only claim if
  the brokers actually run this way. Mind the contradiction with the bio's "not
  the container": quadlets *are* containers. Resolution — authority is drawn at
  the **socket you're handed**, not the container boundary; the quadlet is only
  where the broker lives. Stated that way it reinforces "not the container."

## bifurcate

A thinking tool, not a site word. It already appears concretely as **capability
attenuation** — every handoff splits authority into a narrower branch, never
wider. Keep it as an internal design heuristic; let it surface publicly only
*as* the attenuation property, never as the word "bifurcation."

## Action items

- [ ] Add **object-capability** to the site/README as the named model.
- [ ] Surface **provenance chains** (anchored-chain) out of the table and into
      the pitch.
- [ ] Introduce **`bellhop`** as the broker layer once its seam with `prx` is
      settled.
- [ ] Resolve the **quadlet** question (run today vs. aspirational) before
      leaning on it.
- [ ] Keep **in-toto / SLSA** as kinship language until the formats/levels are
      genuinely met.
