---
title: Session Capability Invariants
status: draft # draft | reviewed | canonical
last_reviewed: 2026-08-03
sources:
  - .claude/README.md
  - .claude/session-start-dispatch.mjs
  - .claude/bootstrap-steps.test.mjs
  - .github/workflows/org-defaults.yml
  - https://github.com/bounded-systems/.github/pull/84
  - https://github.com/bounded-systems/.github/pull/88
  - https://github.com/bounded-systems/.github/issues/91
  - https://github.com/bounded-systems/front-desk-scheduler/pull/101
  - https://code.claude.com/docs/en/self-hosted-environments-production
---

# Session Capability Invariants

What a session must be able to say about the capabilities it depends on.

Written 2026-08-01, from a day in which Front Desk was reported "not working"
and turned out to be broken in two unrelated ways at once, neither of which
anything had noticed. Five PRs later the specific bugs are fixed. This file is
the part that generalises.

Grades below follow `positioning.md`'s convention and are claims about *this
repo today*, not aspirations dressed as facts:

- **Enforced** — a test or gate fails when the property is violated.
- **Partial** — holds in some cases, by hand or by one-off code.
- **Aspirational** — stated, nothing checks it.

## The shape

Everything below is one idea applied in different places.

> A capability a session depends on needs three things **in version control**: a
> canonical definition, a detector that notices the real state has diverged from
> it, and either a repairer or a failure loud enough to act on.

The day's two root causes were each a missing middle term. The MCP server was
declared, absent, and undetected. The Stop hook was defined, wrong, and
undetected. In both cases everything *else* worked — hooks ran, toolchains
installed, the server started cleanly by hand — which is precisely why nobody
looked.

The recurring adversary is not breakage. It is **breakage that presents as
health**.

---

## I1 — Every step of the canonical bootstrap has a fallback, or is declared irreducible

**Statement.** For each step in the canonical bootstrap `.claude/boot.sh`
(fetched by the one-line setup-script field — `.claude/README.md` carries the
field's canonical text), either the dispatcher re-does it when the setup script
has not, or the step is explicitly recorded as irreducible with the reason.

**Why.** The setup-script field is the one link outside version control. On
2026-08-01 it had been reduced to 264 bytes — the `settings.json` heredoc alone
— losing three of its four steps. Losing `register-mcp.mjs` cost Front Desk
entirely; losing the `stop-hook-git-check.sh` copy reinstated infra#112 silently
(#85 has the measurements).

**Grade: Enforced** (#91, 2026-08-03). Two of the four steps self-heal (#84,
#88); the other two are declared irreducible with reasons. The relation between
the field's contents and that coverage is now machine-checked rather than prose.

**How.** The two bespoke repair functions are one `MANIFEST` in
`.claude/session-start-dispatch.mjs` — per entry: the artifact, a detector
(`compare`), a repairer (`repair`), and the failure wording (`context`) — driven
by one loop. `parseSteps` in `gen-bootstrap-pin.mjs`, which **already read the
canonical field text** for `PIN` and the `SUM_*` lines, now also enumerates the
field's steps, and `.claude/bootstrap-steps.test.mjs` asserts every step maps to
a manifest entry or an `IRREDUCIBLE` declaration. Adding a line to the field with
no fallback fails `node --test .claude/`.

Three details carry most of the value:

- **The comparison stays per-entry.** The Stop hook compares bytes (its failure
  was a *wrong* file, so presence reports health); MCP compares a predicate over
  JSON. A manifest that forced one comparison on both would have to pick, and
  either pick reinstates a failure that has already happened here.
- **The parse refuses what it cannot classify.** An unrecognised verb throws
  rather than dropping out of the enumeration — a step silently missing from the
  gate is precisely the invisibility this invariant is about.
- **Irreducible is declared, not inferred from absence.** An omission and a
  decision both present as silence, and it was an omission wearing a decision's
  clothes that cost #85. A bare declaration is not enough either: the test
  requires a reason.

The idiom is the repo's own: `bootstrap-pin.test.mjs` asserts on its generator
rather than reimplementing it, precisely so the two cannot drift.

**What this still does not catch.** The gate relates `.claude/boot.sh` to the
dispatcher. It cannot see the *actual* field, which lives in the environment
selector where nothing can read it — so it catches a step added to the
canonical bootstrap with no fallback, not a field that has drifted from the
one-line canonical text. That residue is now much smaller than it was: the
field is one stable line, and the values it depends on (`ORG_BOOT_URL`,
`ORG_BOOT_SHA256`) are recorded in `.github-private`'s
`cloud-environment.json`, where a stale pair is flagged at every session start
by `cloud-env-check.mjs` — but the line itself remains unverifiable from here.
See "What this does not claim" below.

---

## I2 — A privileged capability is exercised on a schedule, not only when needed

**Statement.** No credential or identity the org depends on may go longer than N
days without a synthetic exercise that would fail if the grant were absent.

**Why.** The sharpest finding of the day. `registry-graph.yml` had reported
success on every weekly run for over a month while the App identity it depends
on **has never once worked**. Its script early-exits on `"in sync"`, so success
meant "nothing to do". The absence of any `registry-graph/*` or
`bootstrap-pin/bump` branch on the remote is the proof (#87).

Merging #84 was simply the first time anything needed the push. A second
workflow carries the identical latent failure and is not currently red only
because it has had no work to do.

Green from a job that did nothing is not evidence. It is the absence of
evidence, reported in the same colour.

**Grade: Aspirational.** Nothing does this.

**To enforce.** A scheduled probe per privileged identity: push a no-op branch,
delete it, fail loudly on 403. This is the ticket-window pattern
(`board-parity.yml`, `claim-ticket.yml`) turned on the org's own plumbing rather
than on the board.

---

## I3 — A preflight assertion covers every scope the job will use

**Statement.** Where a component asserts its credential's scope before doing
work, the assertion covers all operations that follow, not the first one someone
happened to think of.

**Why.** The `pin` job asserts `pull_requests: write` in a step whose own
comment explains why asserting early matters — then dies one step later on
`contents: write`, which is never asserted. The failure arrived as a bare 403 at
`exit 128`, killing the script before any of the carefully worded `::error`
annotations below it could run. The job predicts a failure mode ("branch pushed,
PR not opened") that cannot occur, because the branch cannot be pushed at all.

A partial preflight is worse than none: it converts "check your scopes" into
"scopes were checked".

**Grade: Aspirational.** The `broker-gh-token` action exports `permissions`
precisely so callers can assert; one caller does, incompletely.

**To enforce.** Move the assertion into the action as a `require:` input
(`require: contents, pull_requests`), failing at mint time and naming the gap.
One change fixes all three callers.

---

## I4 — A "cannot" is a claim with a date and a method

**Statement.** Any recorded impossibility carries when it was verified and how.
Re-verify before building on it.

**Why.** The most expensive wrong sentence of the day was undated and
unattributed: *"MCP servers resolve when Claude Code LAUNCHES … so this must
happen here, not in the dispatcher."* It was half true, and the wrong half was
load-bearing — it is the reason nobody had considered a dispatcher-side
fallback. Measured on Claude Code 2.1.42, a session that started with
`mcpServers: null` gained the server's five tools **within the same session**,
seconds after a write, with no relaunch. The config is watched.

Note the asymmetry that makes this worth a rule: a stale *capability* claim
costs one retry, while a stale *impossibility* claim closes off a design
direction and nobody re-opens it.

**Grade: Partial.** The convention is already practised well in `CLAUDE.md`
files — `front-desk-scheduler`'s ProjectV2 findings carry a date and the exact
commands. It is not practised in code comments, which is where this one lived.

**To enforce.** Convention, not machine-check: a reviewer prompt in
`CONTRIBUTING.md`. A gate would have to distinguish an impossibility claim from
ordinary prose, which is not worth the false positives.

---

## I5 — A missing capability is reported, never worked around silently

**Statement.** When a documented capability is absent, saying so is the
deliverable. An answer reconstructed by other means must be labelled as such.

**Why.** The original symptom. A session read front-desk-scheduler's
`CLAUDE.md`, which says to ask the `next` tool and explicitly **not** to
hand-rank issues from the GitHub API, found no such tool, and hand-ranked issues
from the GitHub API. The instruction was right and the tool was not there.

The failure that follows a missing tool is not silence. It is a plausible
answer, delivered with the confidence of the real one, that nothing downstream
can distinguish. An agent that finds its tool missing does not stop; it
improvises.

**Grade: Partial.** The mechanism is now general — `applyManifest` collects a
context block from every manifest entry that could not be repaired (#91) — but
only the MCP entry declares one. The Stop hook deliberately does not: a stock
Stop hook degrades advice about git, while a missing tool makes the model
fabricate an answer nothing downstream can distinguish from the real one, and a
warning that fires for the milder case teaches the reader to skim past both.

**To enforce.** The remaining half is behavioural — *say which answer this is* —
and belongs in the org context file. It stays convention: a gate would have to
tell a reconstructed answer from a retrieved one, which is the thing the failure
mode is defined by being unable to do.

---

## I6 — Test through the path that validates

**Statement.** Where two interfaces expose one computation and only one
validates, tests exercise the validating one.

**Why.** `next`, `graph` and `list` all failed over MCP with `expected number,
received string` while `node scripts/fds.ts next` printed a correct queue
throughout. The DoltHub read plane returns every column as a string;
`assembleScheduling` coerced `effort`, `value` and `age_days` but not `number`.
Only the MCP path carries an `outputSchema`, and only the MCP path is what every
`CLAUDE.md` tells agents to use. A green CLI was not evidence the tool worked.

Note the corollary about assertions: the regression test asserts on `typeof`,
because `assert.equal("931", 931)` would have passed for the entire outage.
Where a type is the bug, assert the type.

**Grade: Partial.** front-desk-scheduler#101 fixed the case and pinned it; no
check relates the two paths in general.

**To enforce.** Run CLI output through the same `outputSchema` in tests, so the
two paths cannot diverge in what they would accept.

---

## What this does not claim

**The bootstrap cannot reach zero.** Something outside the repos must name the
entry point, because the hook that would self-heal a missing hook is the thing
being installed. Verified 2026-08-01 against the cloud-environment docs:
environments are editable only in the selector at claude.ai/code — *"There's no
settings page or direct URL"* — and `/remote-env` *"can't add or edit
environments"*. No API, no CLI, no repo-committed form.

So I1's target is not elimination. It is **one line that fails loudly**, rather
than four steps where losing one is silent.

Server-managed settings may reduce it further, since they support `hooks` and
explicitly do reach cloud sessions where endpoint-managed settings do not. That
is recorded on #85 as unverified — nobody here has tried it, and the hook
approval dialog's behaviour in a cloud session is unknown.

**Re-dated 2026-08-07 (I4 applied to this section's own claim).** The
2026-08-01 "no API, no CLI, no repo-committed form" still holds for the
managed environment every org session runs on. What changed is that the
residue is no longer floor-independent: Anthropic's **self-hosted
environments** beta (Team/Enterprise; production page in `sources` above)
runs cloud sessions on runners we deploy, where per-session setup is a
wrapper script and lifecycle hooks on the runner — files in a repo — and the
runner image is a Dockerfile we build. On that floor, I1's target collapses
from "one line that fails loudly" toward "the environment secret and the
runner deployment", and one detector loses its repairer: private repos cannot
be added mid-session there, so the scope-check's `add_repo` repair path is
selector-or-nothing. Recorded, not adopted — the option and its hardening
facts live in `.github-private` →
`docs/handoffs/self-hosted-session-floors.md` (#337).
