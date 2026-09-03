# site-32 — `site` cloned as `bounded.tools/` vs the separate `bounded-systems/bounded.tools` repo

Issue: https://github.com/bounded-systems/site/issues/32 (open, unlabelled, unassigned, opened 2026-06-23 by bdelanghe).
Task: document the relationship between the two repos; propose (not execute) any rename.
Verify criterion: README in both repos states which is which and why, citing the other by URL.

## Root cause (re-checked; scout's claims hold)

- `site/README.md` Setup block (main @ 0ede7fd, lines 34-39) said
  `git clone --recurse-submodules https://github.com/bounded-systems/bounded.tools.git && cd bounded.tools`.
  That is how a checkout of `site` ends up in a directory named `bounded.tools/`. The same URL now
  resolves to a different, unrelated repo.
- `bounded-systems/bounded.tools` (main @ 6c7299c) is the prx GitHub App receiver, a TypeScript
  Cloudflare Worker at `hooks.bounded.tools`; first commit 765fc64 (2026-06-04) "scaffold bounded.tools —
  GitHub App receiver stub for prx". Its README never mentioned `site`.
- The submodule steps in that clone block are dead: `brand/` stopped being a submodule in site#137
  (6ad8478, 2026-07-02, deleted `.gitmodules`); it is now a flake input (`flake.nix:14-17`) plus the
  `@bounded-systems/brand` npm dep (`package.json`), with `build.mjs:14-20` picking whichever exists.
- `bounded-tools-site` is the consistent repo identifier elsewhere: `package.json` name, `wrangler.jsonc:5`
  name, `flake.nix:32` pname, GHCR image `.github/workflows/deploy.yml:69`.

## What changed

Two commits, one per repo, both on branch `claude/burndown-site-32` (not pushed):

1. `site` — f259ab0 `docs(readme): say which repo this is — site, not bounded.tools (#32)`
   - `README.md`: new section **"Naming: `site` vs `bounded.tools`"** directly under the intro. States
     this repo is `bounded-systems/site` (URL), that `bounded-systems/bounded.tools` (URL) is the prx
     receiver Worker and not the website, explains the directory-name trap, says `git remote get-url
     origin` is the source of truth, gives the local fix (`mv bounded.tools site` / re-clone), and
     records the rename proposal **without executing it**: do not rename either GitHub repo (both names
     are load-bearing — `bounded-tools-site` deploy wiring; `hooks.bounded.tools` live Worker); if a
     maintainer wants the collision gone later, rename `bounded.tools` -> e.g. `prx-receiver`
     (GitHub keeps redirects), not `site`.
   - Setup block fixed to `git clone https://github.com/bounded-systems/site.git && cd site && npm install`
     (comment: `# pulls @bounded-systems/brand`); dead submodule steps removed; one-line
     "Not `bounded.tools.git`" pointer.
   - Three link refs added at the bottom (`site-repo`, `hooks-repo`, `issue-32`).
   - Patch: `site-0001-readme-naming.patch` (+46 / -4, README.md only)
2. `bounded.tools` — fe5b9e6 `docs(readme): this is the prx receiver, not the bounded.tools website`
   - `README.md`: one blockquote under the intro: "Not the website" — names this repo, links
     `https://github.com/bounded-systems/site`, explains the stale-clone trap, links site#32.
   - Patch: `bounded.tools-0002-readme-not-the-website.patch` (+9, README.md only)

## Verify output

Scout's `verify_command` fetches `raw.githubusercontent.com`, which the sandbox proxy blocks
(`HTTP/1.1 403 Forbidden`), and the branches are unpushed anyway, so the identical greps were run
against the working-tree READMEs (`/tmp/work/site-32/verify-local.sh`):

```
$ bash verify-local.sh
OK
exit=0
```

Repo checks (`site`, `npm run check`): `npm ci` fails (npm registry 403 through the proxy), so
`node_modules/@bounded-systems/brand` is absent. Gates that don't need it pass; `gen-strings --check`
fails identically on untouched `main` — it is missing the brand's core `name` string, not a
README problem (no script under `scripts/`, `build.mjs`, `flake.nix`, or any workflow reads `README.md`):

```
✓ verify-vendor: vendor/conformance-kit/ matches the hash-pin (49 files @ 52e523460ee8…)
✓ seam grid is in sync with data/seams.json
blog:check — 6 post(s), 0 problem(s)
✗ index.html: data-str="name" — no such key in content/strings.json      <- same on main; env-only
ok check-emphasis / check-outline / check-inline-purity / check-copy-coverage / check-jargon / check-license / check-repetition
node --test scripts/legibility/coldread.test.mjs: # pass 30 / # fail 0
```

`bounded.tools`: `bun install` also 403s (sharp, workerd), so `tsc --noEmit` / `bun test` could not
run; the change is README-only.

## Unresolved

- Cross-repo: the second commit lands in `bounded-systems/bounded.tools`, which needs its own PR.
  Per `CLAUDE.md` degraded-mode rules, cross-repo work requires the org context; the patch is provided
  but a human (or a session with org context) must open that PR.
- Claim: `claim-ticket.yml` in `bounded-systems/.github` was not dispatched (no GitHub credentials in
  the sandbox). Claim before pushing.
- `site/README.md` still describes `brand/` as a git submodule in "How it consumes the brand",
  "Updating the brand" and the Deploy tail (stale since #137). Deliberately left alone to keep this PR
  scoped to #32; worth a separate issue.
- `site/CLAUDE.md` line 1 is a stray GitHub 404 JSON blob. Unrelated; not touched.
- The issue mentions a `vendor/string-audit` submodule; today `vendor/` holds only the vendored
  `conformance-kit` directory. No action needed; the issue text is dated on that point.
- Upstream verify_command could not be executed from this sandbox (raw.githubusercontent.com 403);
  re-run it after both PRs merge.

## Ready-to-paste GitHub comment (site#32)

```
Documented rather than renamed. Two README-only patches on branch `claude/burndown-site-32`:

1. **site** — new "Naming: `site` vs `bounded.tools`" section: this repo is `bounded-systems/site` (the website, deployed as `bounded-tools-site`); https://github.com/bounded-systems/bounded.tools is the unrelated prx receiver Worker at hooks.bounded.tools. It explains the trap (the old Setup block said `git clone …/bounded.tools.git`, hence the `bounded.tools/` directory), makes `git remote get-url origin` the source of truth, and gives the fix: `mv bounded.tools site`. Setup now clones `site.git` and drops the dead submodule steps (brand is an npm dep since #137).
2. **bounded.tools** — "Not the website" note linking back to https://github.com/bounded-systems/site and this issue. Needs a PR in that repo.

Rename proposal (not executed): keep both GitHub repo names — `bounded-tools-site` is wired into the Worker/GHCR/flake, and `bounded.tools` is a live Worker. If the collision should ever go away at the GitHub level, rename `bounded.tools` -> something like `prx-receiver` (GitHub redirects), never `site`.

Apply: `git am site-0001-readme-naming.patch` in site; `git am bounded.tools-0002-readme-not-the-website.patch` in bounded.tools. No gate reads README.md, so `npm run check` is unaffected.
Before opening the site PR: claim this issue (assignee or `claimed` label via claim-ticket.yml) or pr-claim stays red. The site commit says `Fixes #32`, so squash-merging it closes this issue before the bounded.tools half lands — either merge the bounded.tools PR first or reopen/track it there.
Follow-up (out of scope here): the rest of site's README still describes `brand/` as a submodule.
```

## Before merging (owner)

- [ ] Claim issue #32 first: dispatch `claim-ticket.yml` in `bounded-systems/.github` (repo=site, issue=32)
      so the issue carries an assignee or the `claimed` label; `_pr-claim.yml` is red until then.
- [ ] Open the `site` PR from `site-0001-readme-naming.patch` (commit body has `Fixes #32`, which pr-claim's
      regex accepts). Note in the PR body that `Fixes #32` closes the issue on squash-merge while the
      bounded.tools half is a separate PR — merge order or a manual reopen is the owner's call.
- [ ] Open the `bounded-systems/bounded.tools` PR from `bounded.tools-0002-readme-not-the-website.patch`
      (`Refs bounded-systems/site#32`). Cross-repo; needs org context / credentials the sandbox lacks.
- [ ] After both merge, run the scout `verify_command` (raw.githubusercontent.com is unreachable from here).
- [ ] Optional follow-up issue: site README "How it consumes the brand" / "Updating the brand" / Deploy tail
      still describe `brand/` as a git submodule (stale since #137); deliberately not fixed in this PR.
- [ ] Both commits carry a `Claude-Session:` trailer (required by the session's attribution rules); strip
      on squash if the repo prefers plain trailers.

## Fix round

Verdicts A (CORRECTNESS + REPRODUCIBILITY) and B (SCOPE + MERGEABILITY): `must_fix: []` in both.
Nits handled where cheap; process items moved to the owner checklist above.

- must_fix: none.
- Nit A1/B1 (Setup comment "(no submodules to init)" contradicts the still-stale submodule section 25 lines
  above): dropped the parenthetical; the line is now `npm install   # pulls @bounded-systems/brand`. The
  stale submodule prose remains scoped out (owner checklist). Site commit amended -> f259ab0 (patch regenerated).
- Nit A2 (title still `# bounded.tools`): left as is; the Naming section explains the title is the product
  name. Retitling is a maintainer taste call, not required by the issue.
- Nit A3/B4 (`Claude-Session:` trailer): kept — it is mandated by this session's attribution rules; flagged
  in the owner checklist.
- Nit B2 (`Fixes #32` closes the issue before the bounded.tools PR lands): kept `Fixes #32` because pr-claim's
  regex keys on it; added the merge-order caveat to the ready-to-paste comment and the owner checklist.
- Nit B3 (comment did not mention the claim requirement): added a sentence to the ready-to-paste comment.
- Nit A4 (REPORT's `npm run check` wording): the "Verify output" section already states the chain stops at
  gen-strings; unchanged.
- Re-ran on fresh clones (site main 0ede7fd, bounded.tools main 6c7299c, both unchanged since the verdicts):
  `git am` clean for both patches; scout verify greps against the patched READMEs -> `VERIFY_OK`;
  check-emphasis/outline/inline-purity/copy-coverage/jargon/license/repetition all pass; coldread.test
  30/30; no script/workflow reads README.md. `npm ci` / `bun install` still 403 through the proxy.
- Old *.patch files deleted and regenerated with `git format-patch origin/main..HEAD`; the bounded.tools
  patch is content-identical apart from the commit hash (fe5b9e6).
