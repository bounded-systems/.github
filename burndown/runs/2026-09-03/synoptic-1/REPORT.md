# synoptic-1 — axe / real-a11y verification wired into the gate (issue #1)

Branch `claude/burndown-synoptic-1` on top of `main` @ `be917d0` (v0.54.0), one commit
`24aa7e8 feat: axe gate — real a11y in a real browser, wired into check + CI (v0.55.0)` (amended in the fix round, see below).
Patch: `0001-feat-axe-gate-real-a11y-in-a-real-browser-wired-into.patch` (applies cleanly with `git am` on main; re-verified after the fix round).

**Scope statement (read first):** the gate asserts "zero violations" under axe's WCAG 2.x A/AA tags only
(`runOnly` `wcag2a,wcag2aa,wcag21a,wcag21aa,wcag22aa`). axe's best-practice rules (`region`,
`landmark-one-main`, `heading-order`, …) are NOT run and AAA is NOT asserted. Issue #1's stated purpose is
"proves the derived AAA is real"; this patch narrows that on purpose (see design note b) and the maintainer
must confirm the interpretation before merging. Nothing has run on real WebKit yet — the patch is NOT CI-green.

## What changed

| File | Change |
|---|---|
| `tokens/axe.ts` (new, 139 lines) | The gate. `Deno.serve` serves `<outDir>` on `127.0.0.1:<ephemeral>` (so `./style.css` resolves and layout is real), injects `/__axe-core.js` + an `axe.run()` runner before `</body>`, drives `tezcatl <url> --wait=MS --eval=JS` (retry once at 2x wait) to read the result node back, and asserts **zero violations** (any impact) under axe's `wcag2a,wcag2aa,wcag21a,wcag21aa,wcag22aa` tags — the same ruleset conformance-kit's `axe-gate.mjs` runs (best-practice rules and AAA excluded; documented in the header). `loadAxe()` sha256-digests the vendored engine and compares it to the exported `AXE_SHA256` before a byte is served. Fails closed (exit 1) on violations, on a page that yields no result, on a digest mismatch, and when `tezcatl` is not on PATH. `AXE_SKIP=1` skips explicitly (prints `⊘`, exit 0). Env: `TEZCATL`, `AXE_TEZCATL_WAIT` (default 3000). Exports `axeGate()` / `axePage()` / `loadAxe()` / `AXE_SHA256` for the test. |
| `tokens/vendor/axe-core/axe.min.js` (new, 573 KB) | The embedded engine: axe-core **4.12.1**, MPL-2.0 notice kept in the file header; sha256 `84494fec…53bc` is enforced at gate time by `axe.ts` (`AXE_SHA256`), refresh recipe in the header. No npm fetch at gate time, `deno.lock` untouched. Provenance still needs the maintainer's `npm pack` check (below). |
| `tokens/check.ts` | Runs `axe.ts` as the fourth sub-gate (after drift/audit/cvd), prints `axe: …` (falls back to axe's last stderr line when it dies before its summary, e.g. tezcatl missing), includes it in `ok`, summary line gains `· axe ✓/✗/⊘`, surfaces axe's stderr (rule id, impact, targets, helpUrl) on failure. |
| `tokens/cli.ts` | New `axe` verb (`--out <dir>`, actor `ci`, `RunResult` output) registered in `CLI`; `runScript` takes an optional extra-permissions list so `axe.ts` gets `--allow-net --allow-env`; `check` summary mentions axe. |
| `tokens/axe.test.ts` (new) | Encodes the verify criterion: built `mock-orange` → 0 violations; a temp copy with `lang` removed, an empty `<a>`, and an `<img>` without alt → gate fails with >=3 violations. Both browser tests `ignore` when `tezcatl --version` is not runnable, so `deno test` stays green on Linux (the header says so explicitly: 0 axe assertions on Linux CI is expected, not proof). A third test — `loadAxe()` digest + `/*! axe v4.12.1` banner — runs everywhere, no browser needed. |
| `tokens/deno.json` | `deno task axe` (`--allow-read --allow-net --allow-run --allow-env axe.ts`). |
| `.github/workflows/tokens-check.yml` | Linux `check` job: the two `check.ts` steps run with `AXE_SKIP=1` (typecheck + drift/audit/cvd stay fast). New `axe` job on `macos-14`: checkout + setup-deno (same SHA pins) + `DeterminateSystems/nix-installer-action@ef8a14…` (pin copied from `site-ci.yml`), then `nix shell github:bdelanghe/tezcatl-flake -c deno run … check.ts` for both brands — the full four-gate `check` runs there. `permissions: contents: read`. |
| `CORE.md` | Scopes the "tezcatl/WebKit browser job — opt-in, off" line: the `tokens` gate is the exception. |
| `package.json` | `0.54.0 → 0.55.0` per the `feat: … (vX.Y.Z)` convention. |

Design notes: (a) "embedded axe-core" per the issue → vendored, not `npm:` (keeps the gate hermetic and
the lock reproducible; org sites already vendor `conformance-kit` wholesale); the vendored bytes are
digest-checked at run time, so "pinned" means enforced, not just recorded. (b) Ruleset is A/AA via
`runOnly` tags, **not** `wcag2aaa` and **not** axe's best-practice rules: when I ran the gate with
`wcag2aaa` + axe's off-by-default `color-contrast-enhanced` (7:1) it flagged `a`, `button`, `small` on both
mocks at ~5.3:1 — consistent with `roles.ts` `ROLE_CONTRACT`, which deliberately puts `link` / `muted` /
`on-accent` at AA (4.5). A strict-AAA gate would fail `main` by the engine's own contract, contradicting the
verify criterion, so AAA stays a documented follow-up (see below). A plain `axe.run()` with no `runOnly`
would additionally run best-practice rules (`region`, `landmark-one-main`, `heading-order`), which the
hand-written mocks would trip; those are excluded too. This is a scope interpretation of "zero violations"
the maintainer has to sign off on, not a given.
(c) tezcatl's CLI (`<url> --wait=MS --eval=JS`, result printed on stdout, exit != 0 on error) was confirmed
against `georgemandis/tezcatl` v0.3.0 (the version `bdelanghe/tezcatl-flake` pins), not inferred.

## Verify output (trimmed)

Environment caveat: this sandbox is Linux with no tezcatl (macOS WebKit) and no egress to jsr/npm. I ran
everything through (1) a `deno` shim injecting an offline import map (real `@bounded-systems/verbspec`
0.3.1 source + zod 4.4.3 from a sibling checkout) and (2) a **tezcatl-CLI-compatible shim** backed by
headless Chromium (puppeteer + the cached Chrome 148) implementing exactly `tezcatl <url> --wait=MS --eval=JS`.
So the axe engine and the gate logic are real; the browser engine was Chromium, not WebKit. The repo code
only knows `tezcatl`; nothing Chromium-specific was committed.

Baseline on `main` (both brands) — `check.ts` passes: `drift ✓ · audit ✓ · cvd ✓`.

Scout `verify_command` (verbatim), exit 0:
```
  audit: audit examples/mock-orange/style.css: 53 real declarations checked — ✓ conforms (…)
  cvd:   cvd-hue scan: 3 chromatic colors — ✓ all hues stay distinguishable under color-blindness
  axe:   axe examples/mock-orange: 1 page(s) · 0 violation(s) ✓ zero violations (axe-core WCAG 2.x A/AA, tezcatl/WebKit)
check examples/mock-orange: drift ✓ matches the derivation · audit ✓ · cvd ✓ · axe ✓
  audit: audit examples/mock-blue/style.css: 53 real declarations checked — ✓ conforms (…)
  cvd:   cvd-hue scan: 3 chromatic colors — ✓ all hues stay distinguishable under color-blindness
  axe:   axe examples/mock-blue: 1 page(s) · 0 violation(s) ✓ zero violations (axe-core WCAG 2.x A/AA, tezcatl/WebKit)
check examples/mock-blue: drift ✓ matches the derivation · audit ✓ · cvd ✓ · axe ✓
{ "ok": false, }            <- cli.ts axe --out <injected copy>
OK: axe gate failed closed on injected violation
```

Negative case detail (`axe.ts` on a mock copy with `lang` removed, empty link, `<img>` without alt), exit 1:
```
  ✗ /tmp/…/index.html — 3 violation(s), 0 incomplete
      [serious]  html-has-lang — <html> element must have a lang attribute (1 node(s))   · html
      [critical] image-alt — Images must have alternative text (1 node(s))              · img
      [serious]  link-name — Links must have discernible text (1 node(s))               · a
axe /tmp/…: 1 page(s) · 3 violation(s) ✗
```
`check.ts` on that copy: `drift ✓ · audit ✓ · cvd ✓ · axe ✗`, exit 1. Missing binary (`TEZCATL=/nonexistent`):
`axe …: ✗ /nonexistent not runnable (on PATH? see BROWSER.md)`, exit 1. `AXE_SKIP=1`: `axe ⊘`, exit 0.

`deno test axe.test.ts resolve.test.ts`: **11 passed, 0 failed** (3 axe + 8 existing); with tezcatl off PATH:
1 passed (digest), 2 ignored. Tampered engine (`echo //x >> axe.min.js`): `axe …: ✗ vendored axe-core digest
mismatch: expected 84494fec…, got a6073057…`, exit 1. `deno check` clean on
`cli.ts check.ts axe.ts axe.test.ts` and every other `tokens/*.ts` that does not need the network
(`gen-*.ts`/`validate.ts` import `npm:@webref/*` / `jsr:@std/crypto`, unreachable here — unchanged files).
`examples/mock` (the third, unbuilt mock) also passes with 0 violations. Root `npm run validate` not run
(needs the conformance-kit peer dependency; untouched by this change).

## Unresolved / for the maintainer

1. **Not run on real WebKit.** The macOS `axe` job (nix-installer -> `nix shell github:bdelanghe/tezcatl-flake`)
   is copied from `site-ci.yml`'s proven `browser` job, but I could not execute it here. First CI run on
   macOS is the real proof; if WebKit's computed styles differ from Chromium's for `oklch()` colors, the
   only rule likely to move is `color-contrast` (both mocks sit >= 5.25:1 on the AA-tier roles, well above 4.5).
2. **Vendored axe-core provenance.** npm/CDNs were unreachable; the file came from the pinned commit
   `pamelafox/axe-playwright-python@88c601d` (`axe_playwright_python/axe.min.js`, header `axe v4.12.1`,
   produced there by `npm pack axe-core`). The digest is enforced at gate time, but that only proves the
   file has not changed since vendoring — NOT that it equals upstream. Reviewer B noted the sha256 does not
   match axe-core's (deprecated, pre-release-generated) `sri-history.json` entry for 4.12.1 — inconclusive.
   Please confirm `AXE_SHA256` in `axe.ts` against `npm pack axe-core@4.12.1` before merging; the refresh
   recipe is in the header. The osv lane will not scan a vendored file — if that matters, switch to
   `npm:axe-core` in `deno.json` (+ lock regen) and read `axe.min.js` from the npm cache.
3. **AAA is not asserted** (see design note b). If the intent is a hard AAA gate, either raise
   `link`/`muted`/`on-accent` to `aaaText` in `roles.ts` (a derivation change, out of scope here) or add
   `wcag2aaa` + `rules: { "color-contrast-enhanced": { enabled: true } }` to `AXE_TAGS`/`axe.run` once
   the contract allows it — the gate already reports the exact ratios it finds.
4. **Org process not done from the sandbox:** no `.claude/org-repair.sh` bootstrap, no `claim-ticket.yml`
   claim, nothing pushed. The PR body must carry `Closes #1` for the `pr-claim` check.
5. `deno.lock` unchanged (no new remote deps). `CONTRIBUTING`/`AGENTS.md` do not exist; `CLAUDE.md` only carries the org block.
6. **Cost/policy:** the `macos-14` `axe` job runs on every `tokens/**` push/PR (no opt-in). `CORE.md` said
   the browser job was "off, until it's cheap"; the patch carves the `tokens` gate out as the exception.
   That is a runner-cost decision for the maintainer, surfaced here rather than buried in the doc hunk.
   `nix shell github:bdelanghe/tezcatl-flake` is unpinned (same as `site-ci.yml`); add `?rev=` when the
   flake is pinned. `package.json` has no `files`/`.npmignore`, so the 573 KB engine would ship if this
   tree were ever published to npm.

## Before merging (owner)

Process items that cannot be done from the sandbox (no GitHub credentials, no macOS, no push):

- [ ] Run `.claude/org-repair.sh` (CLAUDE.md bootstrap).
- [ ] **Claim issue #1 via `claim-ticket.yml`** before opening the PR — the `pr-claim` check fails on an
      unclaimed issue (scout: `claimed: false`).
- [ ] Push `claude/burndown-synoptic-1` and open the PR with **`Closes #1`** in the body.
- [ ] Decide the scope question in the PR: accept "zero violations under WCAG 2.x A/AA tags only" (no
      best-practice rules, no AAA) with AAA as a follow-up, or change `ROLE_CONTRACT` first.
- [ ] Watch the first `macos-14` `axe` job run — it is the only real-WebKit proof; **do not treat this
      patch as CI-green until it passes there.**
- [ ] `npm pack axe-core@4.12.1` and compare `sha256sum package/axe.min.js` to `AXE_SHA256` in `tokens/axe.ts`.
- [ ] Accept the runner-cost/policy change (macOS job on every `tokens/**` change) or make it opt-in.

## Ready-to-paste GitHub comment (issue #1)

```
Implemented on branch `claude/burndown-synoptic-1` (patch attached): a third-party a11y gate beside the dogfood ones.
- `tokens/axe.ts` serves the built mock on an ephemeral localhost origin, renders it in tezcatl (WebKit), injects the embedded axe-core 4.12.1 (`tokens/vendor/axe-core/axe.min.js`; its sha256 is verified against `AXE_SHA256` at gate time, so a tampered or half-refreshed engine fails closed; no network at gate time) and asserts ZERO violations under axe's WCAG 2.x A/AA tags. Fails closed if tezcatl is missing; `AXE_SKIP=1` opts out explicitly.
- **Scope — please confirm:** "zero violations" is asserted with `runOnly` WCAG 2.x A/AA tags only. axe's best-practice rules (`region`, `landmark-one-main`, `heading-order`, …) are NOT run, and AAA is NOT asserted: `wcag2aaa` + `color-contrast-enhanced` (7:1) flags `a`/`button`/`small` at ~5.3:1 on both mocks, which is exactly where `ROLE_CONTRACT` puts link/muted/on-accent (AA). Since the issue's "why" is "proves the derived AAA is real", this is a narrowing of the ask — either accept A/AA-with-AAA-as-follow-up, or raise those roles in `roles.ts` first and I will flip the tag set.
- New `axe` verb in `cli.ts`; `check.ts` runs it as the 4th sub-gate (`drift ✓ · audit ✓ · cvd ✓ · axe ✓`).
- `axe.test.ts` proves both directions (built mock -> 0 violations; injected `lang`/`alt`/empty-link faults -> exit 1); those two are skipped when tezcatl is absent. A third test (engine digest + version banner) runs everywhere.
- `tokens-check.yml`: the Linux job keeps the fast gates with `AXE_SKIP=1`; a new SHA-pinned `macos-14` `axe` job provisions tezcatl via nix and runs the full gate for both brands.
Verified locally (axe 4.12.1 + a tezcatl-compatible headless-Chromium shim, since WebKit is macOS-only): both mocks pass with 0 violations, the injected copy fails with 3, a tampered engine fails on digest. **Not yet run on real WebKit** — the macos-14 job has never executed; the first PR run is the real proof, so this is not CI-green yet.
Apply: `git checkout -b claude/burndown-synoptic-1 main && git am 0001-feat-axe-gate-*.patch`, then `cd tokens && deno task check brands/burnt-orange/brand.json examples/mock-orange` on a Mac with tezcatl on PATH (or `AXE_SKIP=1` elsewhere). The runtime digest check proves the file is unchanged since vendoring, not that it equals upstream — please compare `AXE_SHA256` against `npm pack axe-core@4.12.1` (the file came from `pamelafox/axe-playwright-python@88c601d`, npm was unreachable from the sandbox). Also note the macos-14 job runs on every `tokens/**` change — a runner-cost call for you.
```

## Fix round

Verdict A (correctness + reproducibility) had no must_fix. Verdict B (scope + mergeability) had three:

1. **"sha256-pinned" overstated — hash was only a comment.** Fixed at the patch level, the stronger option:
   `tokens/axe.ts` now exports `AXE_SHA256` and `loadAxe()`, which reads the vendored engine, digests it with
   `crypto.subtle` and throws on mismatch before `Deno.serve` starts; `axeGate()` uses it. New always-on
   test in `axe.test.ts` (digest + `/*! axe v4.12.1` banner). The header comment, the commit message and the
   ready-to-paste comment now say "verified at gate time" and, separately, that this does not establish
   upstream provenance (maintainer's `npm pack` check kept). Verified: tampered file → `digest mismatch`,
   exit 1; untouched file → 11/11 tests, verify_command exit 0.
2. **State the A/AA-only narrowing plainly and ask the maintainer to confirm.** Added a SCOPE block to the
   `axe.ts` header (best-practice rules not run, AAA not asserted, why), a scope paragraph to the commit
   body, a "Scope statement (read first)" at the top of this report, and a bold "Scope — please confirm"
   bullet in the ready-to-paste comment that names the issue's "proves the derived AAA is real" and offers
   both resolutions.
3. **Claim #1 before the PR, `Closes #1` in the body, do not present as CI-green.** Process items — recorded
   in the new "Before merging (owner)" checklist above. The report header, the comment and `result.json`
   now say explicitly that the macos-14 job has never run and the patch is not CI-green. The commit already
   carried `Closes #1`.

Nits also picked up while in there: `check.ts` no longer prints an empty `axe:` line when `axe.ts` dies
before its summary (falls back to stderr's last line); `axe.test.ts` header says 0 axe assertions on Linux
is expected; cost/policy and unpinned-flake nits are listed under "Unresolved" item 6 and the checklist.
Not changed: the vendored bytes themselves (provenance cannot be settled from this sandbox).

Method: fresh clone → `git am` the old patch → edits → `git commit --amend` (one commit, history stays
minimal) → re-ran `deno check cli.ts check.ts axe.ts axe.test.ts` (clean), `deno test axe.test.ts
resolve.test.ts` (11 passed; 1 passed / 2 ignored with tezcatl off PATH), the scout `verify_command`
verbatim (exit 0, `OK: axe gate failed closed on injected violation`), the tampered-engine, missing-binary
(`TEZCATL=/nonexistent` → `axe ✗`, exit 1) and `AXE_SKIP=1` (`axe ⊘`, exit 0) paths — all through the same
offline import map + tezcatl-compatible Chromium shim the verifiers used (still not WebKit). Old patch
deleted and regenerated with `git format-patch be917d0..HEAD`; re-applied on a clean `be917d0` clone.
