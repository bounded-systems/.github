# app-create — the App Manifest creation page, as a generator

Creating a GitHub App from a manifest is the **only** machine-readable delivery
of an App private key. Every other route is a human clicking "Generate a private
key" and downloading a PEM — and there is **no API to regenerate a key on an
existing App**, so an App created the other way can never be moved into that
custody model afterwards. It rotates through a browser, forever.

## Why this is a generator and not a service

The manifest must reach GitHub as a form **POST**. It cannot ride a GET URL, so
a manifest is not clickable on its own — something has to render a form.

But the renderer handles **nothing secret**: manifest in, HTML out. No auth, no
state, no credential. The one-time code never passes through it; that lands on
the manifest's `redirect_url` afterwards.

A pure function does not need to be a service. As a generator it has no domain,
no Worker, no availability dependency, and nothing to keep in sync between the
zones that use it.

## Use

```sh
node tools/app-create/render.mjs manifest.json --owner user            > create.html
node tools/app-create/render.mjs manifest.json --owner org --org acme  > create.html
```

Open `create.html`, review the manifest, click **Create GitHub App**. GitHub
redirects to the manifest's `redirect_url` with a one-time code, valid one hour,
which is exchanged for the private key by whatever lane stores keys.

## `--owner` is not cosmetic

A **private** App installs only on its owner. Choosing `org` for an App that
must install on a user account produces an App that cannot be installed where it
is needed — and **App ownership cannot be changed after creation**. The only
remedy is deleting it and starting over.

Both endpoints are valid URLs, so the wrong one yields a page that works and
creates the wrong App. That is why the test asserts a user-owned page contains
no `/organizations/` path at all, rather than merely asserting the right one is
present.

## Local annotation keys are stripped

GitHub's manifest schema has a **fixed field set** and rejects a payload carrying
fields it does not know. `$comment` is a convention for recording *why* a
manifest looks the way it does — every manifest in `bounded-systems/infra`
`github-admin/app-manifests/` has one — so any `$`-prefixed top-level key is
removed before the manifest is embedded.

The annotation is still shown to the reviewer, **above** the payload rather than
inside it, and the page displays exactly what GitHub receives. Those two must not
drift: a page that renders the annotated manifest while POSTing the stripped one
still works, and silently makes the review step meaningless.

## What this does not do

It does not exchange the code, assert the created App's slug, or store the
private key. That half belongs in a gated lane with access to wherever keys
live — see `bounded-systems/infra` `create-app.yml`, whose phase 2 is already
owner-agnostic. This replaces the form-rendering step only.
