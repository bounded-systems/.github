# Splitting `verbspec` / `prx-config` into their own repos

Both are published `@bounded-systems/*` packages that currently live in the
`bounded-systems/prx` monorepo under `packages/<pkg>`. This is the handoff for
promoting them to standalone repos, like `prx` and `guest-room`.

## Should you?

- **`verbspec`** — yes. A general-purpose "author a verb once, project it to
  CLI / MCP / OpenAPI / Anthropic surfaces" core is reusable well beyond prx and
  earns its own home.
- **`prx-config`** — closer call. It's TUI config *for* prx's L1/L2 tools, so
  it's tightly coupled; a separate repo adds release/CI overhead for little
  decoupling gain. Weigh it before splitting.

## Per package → its own repo

1. **Create** the empty repo (e.g. `bounded-systems/verbspec`), public, no
   auto-init.
2. **Extract with history** from a `prx` clone:
   ```sh
   git clone https://github.com/bounded-systems/prx prx-verbspec
   cd prx-verbspec
   git filter-repo --subdirectory-filter packages/verbspec   # cleanest
   git remote add origin https://github.com/bounded-systems/verbspec
   git push -u origin main
   # alternative without filter-repo:
   #   git subtree split -P packages/verbspec -b verbspec-split
   ```
3. **Re-link JSR** ⚠️ — on jsr.io, change the package's linked GitHub repo from
   `prx` to the new repo. **Critical:** the scope's *Require-Publishing-from-CI*
   setting only permits publishes from the *linked* repo, so until you re-link,
   CI publishing from the new repo is rejected.
4. **Publish workflow** — add `.github/workflows/jsr-publish.yml` to the new repo
   (`id-token: write` for provenance, **SHA-pinned** `actions/checkout` or it
   `startup_failure`s — see [`jsr-publish-handoff.md`](jsr-publish-handoff.md)).
5. **Update `prx`** — remove `packages/<pkg>` from the workspace and depend on
   `@bounded-systems/<pkg>` as an external dependency instead of a workspace ref.
   Repeat for any sibling packages that imported it.

## After the repos exist

The profile README can link `verbspec` / `prx-config` to their own repos, and
`verbspec` can move up into **Start here** alongside `prx` and `guest-room`.
That edit lives in this repo — ask and it's done.
