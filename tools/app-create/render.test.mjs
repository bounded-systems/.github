import test from "node:test";
import assert from "node:assert/strict";
import { escapeHtml, creationUrl, validateManifest, renderPage } from "./render.mjs";

const OK = {
  name: "example-door",
  url: "https://example.invalid",
  description: "A door.",
  public: false,
  redirect_url: "https://hooks.example.invalid/app-created",
  default_permissions: { administration: "write", metadata: "read" },
  default_events: [],
};

/**
 * The form's action, EXACTLY. Asserting a URL by substring is what CodeQL flags
 * as incomplete URL sanitization, and it is right to: `includes()` passes for
 * `https://evil.example/?x=https://github.com/settings/apps/new`, so a
 * substring assertion cannot tell the intended endpoint from one embedded in
 * an attacker-chosen host. Extract the attribute and compare the whole value.
 */
function formAction(html) {
  const m = html.match(/<form action="([^"]*)"/);
  assert.ok(m, "the page must contain a form with an action");
  return m[1];
}

// ── the endpoint ────────────────────────────────────────────────────────────
// A private App installs ONLY on its owner, and App ownership cannot be changed
// after creation. Emitting the wrong endpoint produces an App that cannot be
// installed where it is needed, recoverable only by deleting and starting over.

test("user owner targets the personal endpoint", () => {
  assert.equal(creationUrl({ owner: "user" }), "https://github.com/settings/apps/new");
});

test("org owner targets the organization endpoint", () => {
  assert.equal(
    creationUrl({ owner: "org", org: "acme" }),
    "https://github.com/organizations/acme/settings/apps/new",
  );
});

test("org owner without --org is refused, not silently defaulted", () => {
  assert.throws(() => creationUrl({ owner: "org" }), /requires --org/);
});

test("an org name that is not a plain account name is refused", () => {
  // It lands in a URL path; refuse anything path-shaped rather than escaping it.
  // "" is deliberately not here: it trips the missing-argument guard above and
  // gets that message instead, which is the more accurate of the two refusals.
  for (const bad of ["acme/evil", "../x", "a b", "-lead"]) {
    assert.throws(() => creationUrl({ owner: "org", org: bad }), /not a plain account name/, bad);
  }
});

test("an unknown owner is refused rather than defaulting to either endpoint", () => {
  assert.throws(() => creationUrl({ owner: "" }), /must be 'user' or 'org'/);
  assert.throws(() => creationUrl({ owner: "organisation" }), /must be 'user' or 'org'/);
});

test("a user-owned page never contains the organization endpoint", () => {
  // The failure this guards is silent: both endpoints are valid URLs, so a
  // wrong one produces a working page that creates an App in the wrong place.
  const html = renderPage(OK, { owner: "user" });
  assert.equal(formAction(html), "https://github.com/settings/apps/new");
  assert.ok(!html.includes("/organizations/"), "user page must not carry an org endpoint");
});

// ── the manifest must survive the page ──────────────────────────────────────

test("the embedded manifest round-trips byte-identically", () => {
  // The one thing that can corrupt a manifest without anyone noticing: the JSON
  // goes through HTML attribute escaping, and GitHub — not a human — reads it
  // back. A mangled manifest creates an App with the wrong permissions.
  const tricky = {
    ...OK,
    description: `quotes " and ' and <script> & ampersand — em dash`,
    $comment: "line\nbreak and \\backslash\\",
  };
  const html = renderPage(tricky, { owner: "user" });
  const m = html.match(/name="manifest" value='([^']*)'/);
  assert.ok(m, "the hidden manifest field must be present");
  const unescaped = m[1]
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
  assert.deepEqual(JSON.parse(unescaped), tricky);
});

test("a quote in the manifest cannot break out of the attribute", () => {
  const html = renderPage({ ...OK, description: `'><script>alert(1)</script>` }, { owner: "user" });
  assert.ok(!html.includes("<script>alert(1)</script>"), "raw script tag must not survive");
});

test("escapeHtml covers every character that can break out", () => {
  assert.equal(escapeHtml(`<>&"'`), "&lt;&gt;&amp;&quot;&#39;");
  // Ampersand must be replaced FIRST or the other escapes get double-escaped.
  assert.equal(escapeHtml("&lt;"), "&amp;lt;");
});

// ── validation happens before an App exists ─────────────────────────────────
// There is no API to regenerate a key on an existing App, so a mis-created App
// can only be deleted and remade. Everything cheap is checked here.

test("a non slug-shaped name is rejected", () => {
  for (const bad of ["Example Door", "example_door", "ExampleDoor"]) {
    const errs = validateManifest({ ...OK, name: bad });
    assert.ok(errs.some((e) => e.includes("slug-shaped")), `${bad} should be rejected`);
  }
});

test("a slug-shaped name passes", () => {
  assert.deepEqual(validateManifest(OK), []);
});

test("a missing or non-https redirect_url is rejected", () => {
  for (const bad of [undefined, "", "http://x.invalid/cb"]) {
    const errs = validateManifest({ ...OK, redirect_url: bad });
    assert.ok(errs.some((e) => e.includes("redirect_url")), String(bad));
  }
});

test("public: true warns but does not block", () => {
  const errs = validateManifest({ ...OK, public: true });
  assert.equal(errs.length, 1);
  assert.ok(errs[0].startsWith("WARNING:"), "public is a warning, not a fatal error");
});

test("a non-object manifest is rejected", () => {
  for (const bad of [null, [], "string", 42]) {
    assert.deepEqual(validateManifest(bad), ["manifest must be a JSON object"]);
  }
});

// ── the page tells the human what they cannot undo ──────────────────────────

test("the page names the owner and warns that ownership is final", () => {
  const user = renderPage(OK, { owner: "user" });
  assert.ok(user.includes("your user account"));
  assert.ok(/cannot be changed after creation/i.test(user));

  const org = renderPage(OK, { owner: "org", org: "acme" });
  assert.equal(formAction(org), "https://github.com/organizations/acme/settings/apps/new");
});

test("the redirect_url is shown, so the human can see where the code will land", () => {
  const html = renderPage(OK, { owner: "user" });
  assert.ok(html.includes("hooks.example.invalid/app-created"));
});
