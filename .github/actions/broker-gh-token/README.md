# `broker-gh-token` — a GitHub App token from the broker, via OIDC

The consumer side of the GitHub App credential broker (`prx-26bq`,
`infra/cloudflare/broker`). A workflow gets a short-lived App **installation
token** by proving its identity with **GitHub Actions OIDC** — **no App private
key in the repo**. The App keys live only in the broker Worker.

> **Why this lives in `bounded-systems/.github` (public).** The broker code is in
> the **private** `infra` repo, but the consumers (front-desk-sync + the per-repo
> front-desk-add fan-out) are **public**. A public repo's workflow cannot resolve a
> composite action that lives in a private repo — GitHub downloads *every*
> referenced action at job **setup**, *before* any step `if:` is evaluated, so even
> a fail-open-skipped `uses:` step fails the whole run with
> `Unable to resolve action …, not found`. Hosting the action here (public) is what
> makes it consumable org-wide. This is the canonical home; do not re-add it to a
> private repo.

```yaml
jobs:
  add:
    runs-on: ubuntu-latest
    permissions:
      id-token: write          # REQUIRED — lets the job mint an OIDC token
    steps:
      - uses: bounded-systems/.github/.github/actions/broker-gh-token@main   # pin a SHA in real use
        id: token
        with:
          app: front-desk                       # an app in the broker's GH_APPS
          broker-url: ${{ vars.FRONT_DESK_BROKER_URL }}   # an org VAR, not a secret
      - uses: actions/add-to-project@v1.0.2
        with:
          project-url: https://github.com/orgs/bounded-systems/projects/2
          github-token: ${{ steps.token.outputs.token }}
```

No `secrets: inherit`, no `FRONT_DESK_APP_PRIVATE_KEY`, no `create-github-app-token`
— just `id-token: write` + the (non-secret) broker URL. The broker enforces the
per-app policy (`repository_owner == allowedOwner`, least-privilege permissions)
and mints the token.

## How it works

1. The job grants `id-token: write`; GitHub injects `ACTIONS_ID_TOKEN_REQUEST_URL`
   + `ACTIONS_ID_TOKEN_REQUEST_TOKEN`.
2. The action requests an OIDC JWT for `audience` (default `github-app-broker`).
3. It POSTs that JWT to `<broker-url>/github/<app>`; the broker verifies it, mints
   an installation token (least-privilege, from `GH_APPS`), and returns it.
4. The token is masked and exposed as the `token` output.

## Conditional use — the resolve-at-setup gotcha

A skipped `uses:` step is **still resolved and downloaded** at job setup. So you
cannot guard the *action reference itself* behind a var with `if:`. Two safe
patterns:

- **Always-resolvable** (this action is in a public repo, so referencing it is
  always fine): gate it with `if: ${{ vars.FRONT_DESK_BROKER_URL != '' }}` and let
  it no-op when unset — the reference still resolves, the step just doesn't run.
- **Inline the two curls** instead of `uses:` when you want a hard fail-open with
  zero external reference (see `gh-project-room/front-desk-sync.yml`, which inlines
  for exactly this reason and adds a legacy-secret fallback).

## Rolling out (deploy-gated — do AFTER the broker is deployed)

This action is inert until the broker is live for the app. Order:

1. **Deploy the broker** for the app: `wrangler secret put GH_APP_FRONT_DESK_PRIVATE_KEY`,
   set the `GH_APPS` var (incl. `appId`, `installationId`, `audience`, `allowedOwner`,
   `permissions`), `wrangler deploy` (`infra/cloudflare/broker`).
2. **Set `vars.FRONT_DESK_BROKER_URL`** (org variable) to the broker URL.
3. **Repoint the front-desk workflows** onto this action (or the inline equivalent):
   - `gh-project-room/.github/workflows/front-desk-sync.yml` (the sweep) — already
     inlines the broker exchange with a legacy fallback; drop the fallback + the
     `FRONT_DESK_APP_*` secrets once the broker is proven.
   - the per-repo `front-desk-add.yml` template — swap `create-github-app-token` for
     this action. Note it uses a **different** app (`prx-projects`), which must be
     registered in the broker's `GH_APPS` first.
4. **Verify** with one PR, then remove the App private keys from the org secrets —
   at which point each App key exists in exactly one place (the broker), and the
   per-event mint no longer hammers the App installation rate limit.

Until step 1, keep the existing (best-effort, legacy-secret) front-desk workflows.
