# synoptic-4 — Embedded webfont token (vs the system stack)

Issue: https://github.com/bounded-systems/synoptic/issues/4 (open, no comments — a single maintainer proposal; implemented as proposed, with the system stack as the default and the fallback tail).
Branch: `claude/burndown-synoptic-4` in `/tmp/fix/synoptic-4/synoptic` (2 commits on top of `main` @ be917d0, not pushed).
Patches: `0001-feat-tokens-embedded-webfont-FontFace-token-one-font.patch`, `0002-chore-tokens-ship-the-SIL-OFL-1.1-notice-with-the-we.patch` (apply cleanly in order with `git am` on main — verified in a fresh clone).

## What changed

| File | Change |
|---|---|
| `tokens/font.ts`, `tokens/gen-font.ts` | New `FontFace` Zod token `{ family, src: data:font/(woff2\|woff\|ttf\|otf);base64,…, weight: n \| [min,max] (default 400), style (normal), display (swap) }`, `FontDisplay`, `FONT_FORMAT_BY_MIME`, `fontFormatOf()`. font.ts is generated: the block was added to the generator template and font.ts regenerated from it (verified by running the template with the generic-family fallback list; the only remaining diff vs the generator is the pre-existing font-palette comment drift). |
| `tokens/config.ts` | `font` (string, back-compat) now must end in a generic family; new `fontFaces: FontFace[]` (default `[]`); `parseFontStack()`. |
| `tokens/derive.ts` | `deriveFontFamily(brand)` → the typed `FontFamily` token (faces first, `font` as the tail) — the ONE font-family source both emitters consume (the previously dead `FontFamily` type is now live). |
| `tokens/serialize.ts` | `CSSStyleValueBase` (base Typed OM value with `cssText`), `fontFamilyValue()` (quotes family names that are not generics/idents), `serializeFontFace()` → one `@font-face { font-family; src: url(data:…) format("…"); font-weight; font-style; font-display; }` line. |
| `tokens/to-css.ts` | `--font-sans` is now `fontFamilyValue(fontFamily.)` (was a `CSSKeywordValue` holding a comma list); `@font-face` rules are emitted before the `@property` registrations; `body { font-family: var(--font-sans) }` stays the only consumer. |
| `tokens/to-tokens.ts` | DTCG `fontFamily.sans` (`: fontFamily`, `` = stack, face metadata under `["systems.bounded.fontFace"]`, bytes omitted); SD `font.family.sans`. |
| `tokens/audit.ts` | Strips `@font-face` blocks (they define a face) and adds rule 5: any `font-family` not equal to `var(--font-sans)` is a violation. |
| `tokens/brands/webfont-demo/brand.json`, `tokens/examples/mock-webfont/*` | Fixture exercising the face path: a basic-Latin (U+0020–007E) subset of Poppins Regular (SIL OFL 1.1, from the system's google-fonts package) as a 6 KB WOFF data URI. |
| `tokens/brands/webfont-demo/OFL.txt` (commit 2) | The SIL OFL 1.1 text with the Poppins copyright header, shipped next to the fixture (OFL §2 requires the license to accompany copies; the subset's name table has no license entry). |
| `tokens/examples/mock-{orange,blue}/tokens.*.json` | Regenerated — gain the `fontFamily` entry. **style.css for both is byte-identical to before.** |
| `.github/workflows/tokens-check.yml` | Third gate: `webfont-demo → examples/mock-webfont`. |
| `tokens/GROUNDING.md`, `package.json` | CSS Fonts 4 §font-face-rule / §src-desc / §font-display grounding; version 0.54.0 → 0.55.0 (repo habit: one feature = one minor). |

Generated for the demo brand:
```
@font-face { font-family: Poppins; src: url(data:font/woff;base64,…) format("woff"); font-weight: 400; font-style: normal; font-display: swap; }
:root { … --font-sans: Poppins, system-ui, sans-serif; … }
body { font-family: var(--font-sans); }
```

## Verification

The sandbox's egress policy blocks `jsr.io` and `registry.npmjs.org` (403 `host_not_allowed`), so the repo's deps cannot be fetched. To run the real gate locally I used a throwaway harness (NOT committed): `zod@^4.4.3` satisfied by the `v4` build shipped inside a locally present zod 3.25.76 (byonm `node_modules`), and a minimal local stand-in for `jsr:@bounded-systems/verbspec` (`defineVerb`/`dispatch`/`render`/`Registry` — only the identity/registration surface verbs.ts touches). The baseline gate on unmodified `main` passed with this harness before any change, so it is faithful for check.ts/audit.ts/cvd-hues.ts.

```
## deno check (all non-network files; gen-*.ts/validate.ts/resolve.test.ts need npm:@webref / jsr:@std which the sandbox egress blocks)
Check to-tokens.ts
Check typed-om.ts
Check verbs.ts
exit=0
## check.ts brands/burnt-orange → examples/mock-orange
  audit: audit examples/mock-orange/style.css: 53 real declarations checked — ✓ conforms (full indirection, rem-only, oklch-only, valid properties)
  cvd:   cvd-hue scan: 3 chromatic colors — ✓ all hues stay distinguishable under color-blindness
check examples/mock-orange: drift ✓ matches the derivation · audit ✓ · cvd ✓
exit=0
## check.ts brands/deep-blue → examples/mock-blue
  audit: audit examples/mock-blue/style.css: 53 real declarations checked — ✓ conforms (full indirection, rem-only, oklch-only, valid properties)
  cvd:   cvd-hue scan: 3 chromatic colors — ✓ all hues stay distinguishable under color-blindness
check examples/mock-blue: drift ✓ matches the derivation · audit ✓ · cvd ✓
exit=0
## check.ts brands/webfont-demo → examples/mock-webfont
  audit: audit examples/mock-webfont/style.css: 53 real declarations checked — ✓ conforms (full indirection, rem-only, oklch-only, valid properties)
  cvd:   cvd-hue scan: 3 chromatic colors — ✓ all hues stay distinguishable under color-blindness
check examples/mock-webfont: drift ✓ matches the derivation · audit ✓ · cvd ✓
exit=0
## scout grep: font-family only via the token
PASS (no other font-family source)
```

- `deno check` covered every file except `gen-*.ts`, `validate.ts`, `resolve.test.ts` (they import `npm:@webref/*` / `jsr:@std/*`, unreachable here); CI's `deno check *.ts` will cover those.
- `deno lint` on the touched files: the same 5 pre-existing problems as on main (unused `spacing`/`Role`/`HAIRLINE_REM`, `ban-unused-ignore`, `no-explicit-any`), nothing new.
- Negative checks: `font: "Helvetica"` → "font stack must end in a generic family"; an `https://` src → "a base64 data: URI with a font/* MIME type"; a hand-written `body { font-family: Arial }` fails the audit with the new rule 5. `font: "\"Helvetica Neue\", Arial, sans-serif"` serializes to `--font-sans: "Helvetica Neue", Arial, sans-serif;`.

## Unresolved

- **CI must be the final gate.** Local verification ran against a stand-in verbspec and a relabeled zod; `tokens-check.yml` on GitHub is the authoritative run (no reason to expect drift — the derivation code does not touch verbspec, and existing fixtures reproduce byte-for-byte).
- **Not claimed.** CLAUDE.md requires dispatching `claim-ticket.yml` / commenting on the issue before working; the sandbox has no GitHub credentials and `*.bounded.tools` is blocked. The maintainer should claim/assign when applying.
- **Fixture font: WOFF, not WOFF2.** No brotli in the sandbox; WOFF (zlib) is universally supported and the schema accepts woff2/woff/ttf/otf. Swap for a woff2 subset if smaller bytes are wanted. The fixture is Poppins (OFL 1.1) because Space Grotesk was not available offline. The subset's WOFF name table carries only the copyright string (nameIDs 0–6, no license entries), so the OFL text is shipped as `tokens/brands/webfont-demo/OFL.txt`.
- **`build-site.mjs` (lines ~136/149/153)** still hardcodes `system-ui,sans-serif` / `ui-monospace,monospace` fallbacks. It is the Node site builder, outside the token engine and outside this issue's scope; it consumes the generated `style.css` so the token stays authoritative for the pipeline. Left as a follow-up note.
- **Pre-existing, unrelated:** `deriveRoles` crashes (`Cannot read properties of undefined (reading 'Y')`) for cool seeds such as `#0F766E` / `#0369A1` without the `roles.*.field: "cool"` overrides deep-blue carries — reproduced on unmodified main. The demo brand uses a warm seed (`#B91C1C`) to avoid it.

## Ready-to-paste issue comment

```
Implemented on branch claude/burndown-synoptic-4 (patches attached: 0001-feat-tokens-embedded-webfont-FontFace-token-one-font.patch, 0002-chore-tokens-ship-the-SIL-OFL-1.1-notice-with-the-we.patch).

- brand.json gains fontFaces: [{ family, src: "data:font/woff2;base64,…", weight (n or [min,max]), style, display }]; font (string) stays the fallback tail and must end in a generic.
- Each face becomes a self-contained @font-face rule in style.css (data: URI src + format(), font-display: swap default) — no CDN, CSP-clean; its family leads the stack.
- font-family now has ONE source: deriveFontFamily() → the typed FontFamily token → --font-sans (CSS) and fontFamily.sans (DTCG) / font.family.sans (SD). audit.ts fails any font-family that isn't var(--font-sans).
- Existing brands derive byte-identical style.css; token JSON gains the fontFamily entry. New fixture brands/webfont-demo (6 KB Poppins OFL subset, WOFF) is gated in tokens-check.yml.
- Bytes/licensing stay the brand's call — the default is still the zero-load system stack. The fixture ships its SIL OFL 1.1 notice (brands/webfont-demo/OFL.txt) since the subset's name table holds only the copyright string.

Apply: git checkout -b claude/burndown-synoptic-4 main && git am 000*.patch, then let tokens-check.yml run (local sandbox could not reach jsr.io; the gate passed there against the real verbspec 0.3.1 + zod 4.4.3 resolved from disk).
Note: #4 is unclaimed and the commit says `Closes #4`, so pr-claim.yml will fail the PR until the issue is claimed (claim-ticket.yml or assign + comment) — please claim before opening it.
Left out on purpose: build-site.mjs's own hardcoded system-stack fallbacks (outside the token engine).
```

## Before merging (owner)

- [ ] Claim issue #4 (dispatch `claim-ticket.yml`, or assign yourself and comment) BEFORE opening the PR — `pr-claim.yml` fails any PR whose `Closes #4` names an unclaimed issue, and the sandbox had no GitHub credentials to do this.
- [ ] Open the PR from `claude/burndown-synoptic-4` (both patches applied in order) and let `tokens-check.yml` run — it is the authoritative gate (real jsr.io/npm resolution, plus `deno check` of `gen-*.ts` / `validate.ts` / `resolve.test.ts`, which the sandbox could not type-check).
- [ ] Optional: swap the WOFF fixture for a woff2 subset if smaller bytes are wanted (keep `OFL.txt` alongside it).

## Fix round

Verdicts A (correctness) and B (scope/mergeability) both confirmed the patch; their must_fix items and what was done:

1. **A + B: "the license text travels in the font's name table" is false; ship the OFL 1.1 notice with the Poppins subset.** Verified: the subset's name table has nameIDs 0–6 only (copyright + naming), no nameID 13/14. Added `tokens/brands/webfont-demo/OFL.txt` as a second commit (`chore(tokens): ship the SIL OFL 1.1 notice with the webfont-demo fixture`): the canonical OFL 1.1 text with the Poppins copyright header (`Copyright 2020 The Poppins Project Authors`, matching nameID 0) and a note that the embedded WOFF is a basic-Latin subset (a Modified Version). Corrected the claim in this report (Unresolved and the ready-to-paste comment).
2. **B: claim issue #4 before opening the PR (pr-claim.yml fails on an unclaimed `Closes #4`).** Process item — cannot be fixed in the patch (no credentials). Added the "Before merging (owner)" checklist above and an explicit line in the ready-to-paste comment.

Wording fixes flagged in nits: the `deno lint` claim ("7 pre-existing `no-explicit-any` findings") corrected to the verified 5 pre-existing problems of mixed kinds.

Re-verified in a fresh clone (`/tmp/fix/synoptic-4/synoptic`, `git am` of both patches onto main @ be917d0) with the verdicts' harness (real `@bounded-systems/verbspec` 0.3.1 source + zod 4.4.3 from disk): `deno check` on every non-network `.ts` exit 0; `check.ts` for burnt-orange→mock-orange, deep-blue→mock-blue, webfont-demo→mock-webfont each report `drift ✓ · audit ✓ · cvd ✓` exit 0; the scout's font-family grep passes; working tree clean after the run. Patches regenerated with `git format-patch be917d0..HEAD`.
