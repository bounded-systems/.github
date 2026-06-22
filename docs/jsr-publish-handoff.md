# Publishing the `@bounded-systems/*` packages to JSR

How to close the README-table ↔ JSR gap by publishing the nine seams that
aren't on the registry yet. The packages live in the **`bounded-systems/prx`**
monorepo under `packages/<pkg>`; publishing happens from there, not from this
repo.

## The gap

Of the 20 seams in the profile README's library table, **11 are published** and
**9 are not**:

| State | Packages |
|---|---|
| ✅ on JSR | `anchored-chain`, `anchored-chain-sqlite`, `audit-context`, `auth`, `cas`, `disposition`, `env`, `host`, `machine-schema`, `scout`, `surface-sync` |
| ❌ not in the scope | `fs`, `git`, `policy` |
| ⚠️ name reserved, no version | `bd`, `gh`, `github-budget`, `proc`, `repo-root`, `slack` |

Publishing the nine makes the README table true with no edits to it.
(Separately, `verbspec` and `prx-config` are published but absent from the
page — non-seam libraries, worth surfacing elsewhere.)

## Heads-up: local publishing is currently disabled

The scope has **Require Publishing from CI** enabled, which disables
`jsr publish` from a local machine, scope-wide. Pick a lane:

- **Local** — Settings → turn *Require Publishing from CI* **off** → publish →
  turn it back **on**. Fast, but those versions won't carry provenance.
- **CI (recommended)** — publish from a `prx` GitHub Actions workflow; keeps the
  Sigstore build provenance the CI-required setting buys you.

## Per-package prerequisites

1. Each `packages/<pkg>` has a `jsr.json` (or `deno.json`) with name, version,
   and exports:
   ```json
   { "name": "@bounded-systems/fs", "version": "0.2.0", "exports": "./mod.ts" }
   ```
2. **New names** — `fs`, `git`, `policy` aren't in the scope yet: create each on
   jsr.io under `@bounded-systems` and link it to the `bounded-systems/prx`
   repo (required for CI publishing). The six reserved-but-empty packages
   already exist; they just need a first version.
3. JSR rejects **"slow types"** by default — give public APIs explicit return
   types, or publish with `--allow-slow-types` (lowers the package score).

## Local path

After flipping *Require Publishing from CI* off:

```sh
# from the prx repo root, per package (or once if the workspace is JSR-aware)
npx jsr publish        # add --allow-slow-types if it complains
```

Re-enable the toggle when done.

## CI path (recommended)

Drop a workflow into `prx/.github/workflows/jsr-publish.yml`. This is a
**template** — adapt the runtime/build steps to how `prx` actually builds:

```yaml
name: jsr-publish
on: { workflow_dispatch: {}, push: { tags: ["v*"] } }
permissions:
  contents: read
  id-token: write          # <- this is what mints JSR provenance
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<full-commit-sha>   # PIN IT — see warning
      - run: npx jsr publish
```

> ⚠️ **SHA-pin every action** (hardening §4, per `front-desk-add.yml`). With a
> tag ref like `@v4`, the run fails with `startup_failure` before it does
> anything — the same org-policy wall the `knowledge-check` workflow hit and
> had to be rewritten to avoid. Pin `actions/checkout` to a full commit SHA, as
> the other workflows do.

## Verify

Each package page on jsr.io shows the new version. CI-published versions also
carry a "published from GitHub Actions" provenance marker — the in-toto/SLSA
story made concrete for the packages.
