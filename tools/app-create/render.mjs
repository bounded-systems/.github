#!/usr/bin/env node
/**
 * @module
 * Render the GitHub App Manifest creation page for a manifest.
 *
 *   node tools/app-create/render.mjs <manifest.json> --owner user            > create.html
 *   node tools/app-create/render.mjs <manifest.json> --owner org --org acme  > create.html
 *
 * ── WHY A GENERATOR AND NOT A SERVICE ───────────────────────────────────────
 * GitHub's App Manifest flow is the only machine-readable delivery of an App
 * private key, and it turns on one API fact: the manifest must arrive as a form
 * POST. It CANNOT ride a GET URL. So a manifest is not clickable on its own —
 * something has to render a form, which is why a hosted receiver exists at all.
 *
 * But the renderer handles nothing secret: manifest in, HTML out. No auth, no
 * state, no credential — the one-time code never passes through it, it lands on
 * the manifest's `redirect_url` afterwards. A pure function does not need to be
 * a service, and its most portable form is a generator: no Worker, no domain,
 * no availability dependency, and nothing to keep in sync between zones.
 *
 * ── WHAT THIS DOES NOT DO ───────────────────────────────────────────────────
 * It does not exchange the code, assert the created slug, or store the private
 * key. That half belongs in a gated lane with access to wherever keys live, and
 * it is already owner-agnostic. This replaces the form-rendering step only.
 *
 * Dependency-free on purpose — the same "runs anywhere" property org-defaults.mjs
 * keeps, and the reason this can be run from a zone that has no toolchain set up.
 */

import { readFileSync } from "node:fs";

/** HTML-escape for both text nodes and single-quoted attribute values. */
export function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * The creation endpoint. A private App installs ONLY on its owner, so this is
 * not cosmetic: choosing `org` for an App that must install on a user account
 * produces an App that cannot be installed where it is needed, and the only
 * remedy is deleting it and starting over — App ownership cannot be changed.
 */
export function creationUrl({ owner, org }) {
  if (owner === "user") return "https://github.com/settings/apps/new";
  if (owner === "org") {
    if (!org) throw new Error("--owner org requires --org <name>");
    if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(org)) {
      throw new Error(`--org '${org}' is not a plain account name`);
    }
    return `https://github.com/organizations/${org}/settings/apps/new`;
  }
  throw new Error(`--owner must be 'user' or 'org', got '${owner}'`);
}

/**
 * Validate the fields the downstream lane depends on. Failing here is cheap;
 * failing after an App exists is not, because there is no API to regenerate a
 * key on an existing App — a mis-created App can only be deleted and remade.
 */
export function validateManifest(m) {
  const errs = [];
  if (m === null || typeof m !== "object" || Array.isArray(m)) {
    return ["manifest must be a JSON object"];
  }
  if (typeof m.name !== "string" || m.name.length === 0) {
    errs.push("manifest.name must be a non-empty string");
  } else if (!/^[a-z0-9-]+$/.test(m.name)) {
    // GitHub slugifies the name. Keeping name and slug identical BY
    // CONSTRUCTION is what lets a later step assert that the App it exchanged
    // is the App this manifest declared, rather than comparing two spellings.
    errs.push(
      `manifest.name '${m.name}' is not slug-shaped (lowercase, digits, dashes) — ` +
        `name and the App's future slug must be identical by construction`,
    );
  }
  if (typeof m.redirect_url !== "string" || !/^https:\/\//.test(m.redirect_url)) {
    // Without it GitHub shows the code in its own UI instead of handing it to a
    // page that can pass it on, which is how a one-time credential gets copied
    // through a human by hand.
    errs.push("manifest.redirect_url must be an https URL — it is where the one-time code lands");
  }
  if (m.public === true) {
    // Not fatal: a public App is legitimate for something meant to be widely
    // installable. It is a loud warning because it is the wrong answer for
    // every privileged door, and the mistake is invisible once created.
    errs.push(
      "WARNING: manifest.public is true — a public App can be installed by anyone who finds it. " +
        "For a privileged door this is almost certainly wrong.",
    );
  }
  return errs;
}

/**
 * Remove local annotation keys before the manifest is POSTed.
 *
 * GitHub's App Manifest schema has a FIXED field set, and it rejects a payload
 * carrying fields it does not know. `$comment` is this org's convention for
 * recording why a manifest looks the way it does — every manifest in
 * `bounded-systems/infra` `github-admin/app-manifests/` has one — and
 * `create-app.yml` strips it for exactly this reason before POSTing.
 *
 * `$` prefixes no GitHub manifest field, so stripping the prefix generally is
 * safer than special-casing one key name: the next annotation someone invents
 * is handled without anyone remembering to come back here.
 */
export function stripLocalKeys(manifest) {
  return Object.fromEntries(
    Object.entries(manifest).filter(([k]) => !k.startsWith("$")),
  );
}

export function renderPage(manifest, { owner, org }) {
  const action = creationUrl({ owner, org });
  // THE PAYLOAD, and what the human reviews, must be the SAME OBJECT. Strip
  // once, then serialise it twice — compact for the form field, pretty for the
  // page. Rendering the annotated manifest while POSTing the stripped one would
  // quietly defeat the review step this page exists for: the reviewer would be
  // approving something GitHub never sees.
  const payload = stripLocalKeys(manifest);
  const compact = JSON.stringify(payload);
  const pretty = JSON.stringify(payload, null, 2);
  // The annotation still has value to a reviewer — it is the "why" — so it is
  // shown as context ABOVE the payload rather than inside it.
  const comment = typeof manifest.$comment === "string" ? manifest.$comment : null;
  const target = owner === "user" ? "your user account" : `the <code>${escapeHtml(org)}</code> organization`;

  return `<!doctype html>
<meta charset="utf-8">
<title>Create ${escapeHtml(manifest.name)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.55 ui-sans-serif, system-ui, sans-serif; max-width: 46rem;
         margin: 3rem auto; padding: 0 1.25rem; }
  h1 { font-size: 1.35rem; margin-bottom: .25rem; }
  .sub { opacity: .75; margin-top: 0; }
  pre { background: rgba(127,127,127,.12); border: 1px solid rgba(127,127,127,.25);
        border-radius: 8px; padding: 1rem; overflow-x: auto; font-size: 13px; }
  button { font: inherit; font-weight: 600; background: #1f883d; color: #fff;
           border: 0; border-radius: 7px; padding: .7rem 1.15rem; cursor: pointer; }
  .note { border-left: 3px solid #d0a215; background: rgba(208,162,21,.10);
          padding: .8rem 1rem; border-radius: 0 6px 6px 0; margin: 1.5rem 0; }
  code { background: rgba(127,127,127,.15); padding: .1rem .3rem; border-radius: 4px; }
  footer { opacity: .7; font-size: 13px; margin-top: 2rem; }
  .why { background: rgba(127,127,127,.08); border-radius: 6px; padding: .75rem 1rem;
         font-size: 13.5px; }
</style>

<h1>Create the GitHub App <code>${escapeHtml(manifest.name)}</code></h1>
<p class="sub">Owned by ${target}.</p>

<div class="note">
<strong>Review the manifest below before clicking.</strong> This page exists because
GitHub requires the manifest to arrive as a form <code>POST</code> — it cannot be a link —
and because creating an App requires a browser session. That click is irreducible.
<br><br>
Afterwards GitHub redirects to <code>${escapeHtml(manifest.redirect_url ?? "the manifest's redirect_url")}</code>
with a <strong>one-time code, valid one hour</strong>, which is exchanged for the App's
private key. Hand that code to the lane that stores the key; nobody needs to hold it.
</div>

${comment ? `<p class="why"><strong>Why this App exists:</strong> ${escapeHtml(comment)}</p>\n` : ""}<p class="sub">This is exactly what GitHub receives:</p>
<pre>${escapeHtml(pretty)}</pre>

<form action="${escapeHtml(action)}" method="post">
  <input type="hidden" name="manifest" value='${escapeHtml(compact)}'>
  <button type="submit">Create GitHub App</button>
</form>

<footer>
Generated by <code>tools/app-create/render.mjs</code> in <code>bounded-systems/.github</code>.
Ownership cannot be changed after creation — if this says the wrong account, stop and
re-render rather than clicking.
</footer>
`;
}

function parseArgs(argv) {
  const args = { manifest: null, owner: null, org: null };
  const rest = [...argv];
  while (rest.length > 0) {
    const a = rest.shift();
    if (a === "--owner") args.owner = rest.shift();
    else if (a === "--org") args.org = rest.shift();
    else if (a === "-h" || a === "--help") args.help = true;
    else if (a.startsWith("-")) throw new Error(`unknown option '${a}'`);
    else if (args.manifest === null) args.manifest = a;
    else throw new Error(`unexpected argument '${a}'`);
  }
  return args;
}

const USAGE = `usage: render.mjs <manifest.json> --owner user
       render.mjs <manifest.json> --owner org --org <name>

Emits the App creation page on stdout. Redirect it to a file and open that file.`;

// Only run when invoked directly, so the exports stay unit-testable.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`render.mjs: ${e.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (args.help || args.manifest === null || args.owner === null) {
    console.error(USAGE);
    process.exit(args.help ? 0 : 2);
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(args.manifest, "utf8"));
  } catch (e) {
    console.error(`render.mjs: cannot read ${args.manifest}: ${e.message}`);
    process.exit(1);
  }

  const problems = validateManifest(manifest);
  const fatal = problems.filter((p) => !p.startsWith("WARNING:"));
  for (const p of problems) console.error(`render.mjs: ${p}`);
  if (fatal.length > 0) process.exit(1);

  try {
    process.stdout.write(renderPage(manifest, { owner: args.owner, org: args.org }));
  } catch (e) {
    console.error(`render.mjs: ${e.message}`);
    process.exit(2);
  }
}
