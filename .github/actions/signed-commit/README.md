# signed-commit

Publish a generated file to a branch as a **GitHub-signed** commit, verify it was
actually signed, and optionally open a PR.

## The problem

Actions hands a job a **token, not a signing key**. There is nothing on a runner
to sign with, so this:

```yaml
- run: |
    git config user.name ci
    git add generated.sql && git commit -m "regenerate" && git push
```

produces an **unsigned** commit. The moment a repo turns on
`Commits must have verified signatures`, every PR that workflow opens is blocked
and can only be merged with a rule bypass. That is how this action came about —
see bounded-systems/front-desk-scheduler#27.

A commit created through the **Contents API** is constructed *server-side*, which
is the precondition for GitHub signing it. Same content, same branch, same PR;
the difference is who assembles the commit object.

## The part that is easy to get wrong

**"Written through the API" does not by itself imply "signed."**

Observed 2026-07-28: a Contents API write came back with `%G? = N` — no
signature at all — while GitHub's own squash-merges on the *same repo* were
signed as `GitHub <noreply@github.com>`. Signing depends on the **identity that
authenticated**, not on the endpoint you called.

So this action reads `.commit.verification.verified` back and reports it, rather
than assuming the write did it. If you take one thing from this README: check
`verified`, don't trust the mechanism.

## Usage

```yaml
permissions:
  contents: write
  pull-requests: write   # only if you set pr-title

steps:
  - uses: actions/checkout@<sha>
  - run: node scripts/generate.ts        # produces schema/mirror.live.sql

  - id: publish
    uses: bounded-systems/.github/.github/actions/signed-commit@<sha>
    with:
      path: schema/mirror.live.sql
      branch: schema/regenerated
      message: "schema: regenerate projection"
      token: ${{ steps.apptoken.outputs.token || github.token }}
      pr-title: "schema: regenerate projection"
      pr-body-file: /tmp/pr-body.md

  - if: steps.publish.outputs.verified != 'true'
    run: echo "unsigned — ${{ steps.publish.outputs.reason }}"
```

### Inputs

| input | required | default | notes |
|---|---|---|---|
| `path` | yes | | repo-relative path to write |
| `content-file` | no | `path` | local file whose bytes to publish |
| `branch` | yes | | created from `base` if absent, written onto if present |
| `base` | no | `github.ref_name` | branch to cut from / PR into |
| `message` | yes | | commit message |
| `token` | yes | | needs `contents:write` (+ `pull-requests:write` for a PR). **Determines whether the commit gets signed.** |
| `repository` | no | `github.repository` | |
| `fail-if-unsigned` | no | `false` | `true` fails the step on an unsigned commit |
| `pr-title` | no | — | set to open a PR; omit to only write the commit |
| `pr-body-file` | no | — | |
| `pr-draft` | no | `true` | |

### Outputs

`changed`, `commit`, `verified`, `reason`, `pr-url`.

## Behaviour worth knowing

- **Unchanged content is skipped explicitly.** The action compares the encoded
  bytes against the blob already on the branch rather than relying on the API to
  no-op. An unexplained empty commit is exactly the kind of thing nobody
  investigates later.
- **New files work.** A 404 on the existing blob means "create", and the
  Contents API takes no `sha` in that case.
- **`--head`/`--base` are explicit on the PR.** `gh` infers them from the
  checked-out branch, and this action never checks `branch` out — without them
  `gh` would target whatever the job has checked out.
- **A failed PR is not a failed commit.** The commit is on the branch either way,
  and the warning distinguishes the two failure modes, which need opposite fixes:
  a missing App `Pull requests: write` permission, versus the org setting for
  Actions creating PRs. Enabling that org checkbox also grants *approve*, which
  would let workflows self-approve — prefer fixing the App.
- **`fail-if-unsigned` defaults to `false`.** When the content is the product of
  expensive upstream work (a migration that already applied), a red step would
  misreport work that succeeded, and a human can still merge with a bypass. Set
  it to `true` where an unsigned commit is worse than no commit.

## Status

Not yet exercised by a GitHub App installation token — the first real consumer
(`front-desk-scheduler`'s `mirror-migrate`) is the proving ground. Since signing
depends on the authenticating identity, treat `verified` from the first real run
as the fact, not this README.
