# site-40 — Close the coverage gap: promote high-value homepage copy into content/strings.json

**Outcome: stale / superseded. No patch.** Every homepage string the issue names is gone from
`index.html`, and the two design questions it raises (body prose -> strings.json; surface the
"door" thesis) were later decided the other way by merged commits. Executing the issue as
written would either be a no-op or reverse those decisions.

Repo: `/tmp/work/site-40/site` @ `0ede7fd` (main, 2026-09-01), branch `claude/burndown-site-40` (no commits).
Scout report (`/home/claude/burndown/scout/site-40.json`) re-checked: all claims confirmed; its one
unverified item (brand core `description` token) is now verified below via a git clone of
`bounded-systems/brand` (npm registry is 403 in this sandbox; `git clone` of the brand repo works).

## What changed (files)

Nothing. No files modified, no commits, no patch (`git format-patch main..HEAD` produced no output).

## Evidence

### 1. The named strings do not exist on the homepage

`grep -rn` across the repo (excluding node_modules/.git) for each string the issue names:

| Issue string | On index.html today? | Removed by |
|---|---|---|
| hero "Hand an AI coding agent a real task and it..." | No — hero lead is now "Give an agent a real task and it can touch anything you can..." (index.html:104, inline `<p class="hero__lead">`) | `37b7c88` 2026-06-28 (#84), then rewritten again in `c7dceb8` 2026-08-21 (#219) |
| CTA "Read the one idea" | No (only mentioned in `docs/coga-*.md` as a historical probe) | `37b7c88` 2026-06-28 (#84) |
| CTA "Start here" | No (only in `docs/handoffs/*.md`) | `5dc005c` 2026-06-29 |
| CTA "browse on GitHub" | No — not in the repo at all | — |
| thesis "Draw the boundary at the door..." | No (present only in `llms.txt:7`, not index.html) | never on the current homepage; see section 3 |

The issue was opened 2026-06-23 against the page as of `fcc150b` (2026-06-21). The homepage was
rewritten wholesale in #219 (`c7dceb8`, 1,516 -> 460 words).

### 2. The "promote body prose" question was decided — the other way

`scripts/check-copy-coverage.mjs` (added `5ca89d1` #134, decided `b4087be` #135, both 2026-06-30):

> DECISION (RESOLVED): the body-copy approach is settled — EXTERNAL-JARGON-LINKING, not
> data-str-md. Atomic micro-copy (headings/labels/CTAs) is single-sourced in strings.json and
> protected by the floor; the body PROSE stays inline BY DESIGN (a paragraph is content, not a token)

`content/strings.json` `$description` repeats it: "Atomic micro-copy only ... Body paragraphs stay
inline by design". The ratchet FLOOR is 22; the page has 23 `data-str` elements today, and
`gen-strings.mjs --check` reports `23 data-str element(s) match content/strings.json (0 catalogued
not-yet-wired)` — every atomic string (headings, repo-card titles, grade names/defs, lead-ins,
byline, contact CTA, site name, core `name`) already resolves from strings.json. The only homepage
copy outside strings.json is body prose (hero lead, card bodies, section leads), inline by the
documented decision.

### 3. Meta description vs core `description` token — divergence is deliberate

Core token (`bounded-systems/brand` @ `d71912d`, v2.0.0, `content/strings.json`):

> Capability security for AI agents — authority drawn at the door, not the process or container. Every claim graded against the running code.

`index.html:7` `<meta name="description">`:

> Your coding agent runs with your access. Bounded Systems puts one checkpoint in front of every privileged action: it checks who is asking and what they're allowed to do, then acts or refuses, and records it.

They differ, but #219 (`c7dceb8`) changed the meta description *away from* the door wording on
purpose (`git show c7dceb8 -- index.html`: `-... drawn at the door, not the process or
container...` -> `+Your coding agent runs with your access...`). The legibility gate that PR wired
(`scripts/legibility/lexicon.txt`) denies `\bdoors?\b` on the homepage, and
`scripts/legibility/coldread-grade.mjs` treats "door" as an org-vocabulary contamination canary
("NONE of it is on the page — which is the point"). Reconciling the meta description to the core
token, or surfacing the thesis ("Draw the boundary at the door..."), would reintroduce a denied word.
The thesis is therefore effectively waived for this surface by the gate itself. Residual nit,
unrelated to this issue: the meta description is 207 chars (check-seo warns, aim <=160).

### 4. `gen-strings.mjs` cannot wire `<meta>` anyway

The `DATA_STR` regex only substitutes element text bodies; attributes (`content="..."`) are not
projectable without extending the tool — another reason item 1 is not a strings.json task.

## Verify output (trimmed)

Run on unmodified main, with `bounded-systems/brand` (git clone, v2.0.0) symlinked at
`node_modules/@bounded-systems/brand` because npm is 403 in the sandbox. Scout `verify_command` was empty.

```
$ node scripts/gen-strings.mjs --check
✓ string-audit — 23 data-str element(s) match content/strings.json (0 catalogued not-yet-wired)
$ node scripts/check-copy-coverage.mjs
✓ check-copy-coverage — single-source floor holds (23 ≥ 22)
$ node scripts/check-seo.mjs
  ⚠ seo: meta description is 207 chars (aim for 50–160)
seo:check — index.html ok (1 warning(s))
$ npm run check          # all 24 gates + 30 coldread tests
✓ ... (every gate ✓; check-repetition at baseline ceiling 8/8)   exit=0
$ npm run build          # scripts/run-pipeline.mjs hermetic stamped local
✓ pipeline complete — 25 step(s) across hermetic + stamped + local   exit=0
```

Rendered homepage text before/after: identical by construction (no change made).

## Unresolved

- Nothing actionable for this issue. `<meta name="description">` still differs from the core
  `description` token, but that is a brand-vs-surface vocabulary decision made in #219, not a
  strings.json coverage gap; aligning them means changing the brand token's wording in
  `bounded-systems/brand`, or a site-level override plus a `gen-strings.mjs` extension for
  attributes — out of scope here.
- Issue #39 (baseline/targets) is superseded by the same commits.
- Per CLAUDE.md the issue should be claimed via `claim-ticket.yml` before work; no GitHub
  credentials in the sandbox, so nothing was claimed or posted.

## Ready-to-paste closing comment for #40

```
Closing as superseded — the page this was filed against no longer exists.

- None of the named strings are on index.html anymore: the "Hand an AI coding agent…" hero left in #84 (37b7c88) and the page was rewritten wholesale in #219 (c7dceb8); "Read the one idea" (#84), "Start here" (5dc005c) and "browse on GitHub" are gone.
- The body-prose question was decided in #134/#135: `scripts/check-copy-coverage.mjs` records "body PROSE stays inline BY DESIGN"; atomic copy is single-sourced and ratcheted (floor 22, currently 23 data-str; `gen-strings --check` → 0 not-yet-wired).
- Meta description vs core `description`: the divergence is deliberate — #219 rewrote it off the "door" wording, and `scripts/legibility/lexicon.txt` now denies "door" on the homepage. The same gate effectively waives surfacing the "Draw the boundary at the door" thesis here.
- `npm run check` and `npm run build` pass on main (0ede7fd) as-is.

If aligning the meta description with the brand token still matters, that's a brand-repo wording change, not a strings.json gap — happy to open a separate issue. #39 is superseded by the same commits.
```
