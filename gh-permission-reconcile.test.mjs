// The claims in .github#104 and knowledge/ocap-github.md are numbers. Pin them
// here so the argument for `ocap-github` cannot quietly stop being true --
// asserting on the reconciler rather than reimplementing it, the same way
// bootstrap-pin.test.mjs asserts on its generator.
//
// Fixture-only: no network, so a docs.github.com or raw.githubusercontent
// outage cannot turn this red for reasons unrelated to the claim.

import assert from "node:assert/strict";
import { test } from "node:test";

import { guessSlug, loadDocs, loadWire, reconcile } from "./scripts/gh-permission-reconcile.mjs";

process.argv.push("--offline");
const wire = await loadWire();
const docs = await loadDocs();
const r = reconcile(wire, docs);

const levels = (slug) => wire[slug];

test("the lattice is not read < write < admin", () => {
  const admin = r.nonUniform.filter((p) => p.levels.includes("admin")).map((p) => p.slug);
  const single = r.nonUniform.filter((p) => p.levels.length === 1);

  assert.equal(r.nonUniform.length, 8, "8 of 55 slugs deviate from read/write");
  assert.deepEqual(admin.sort(), [
    "enterprise_custom_properties_for_organizations",
    "organization_custom_properties",
    "organization_projects",
    "repository_projects",
  ]);
  assert.deepEqual(
    single.map((p) => `${p.slug}:${p.levels[0]}`).sort(),
    ["organization_events:read", "organization_plan:read", "profile:write", "workflows:write"],
  );
});

test("workflows: read is unconstructible", () => {
  // The claim a string map cannot state. Asserted on the level set, not on a
  // count, because a count would still pass if `read` were added.
  assert.deepEqual(levels("workflows"), ["write"]);
});

test("organization_projects -- the Front Desk door -- admits admin", () => {
  assert.ok(levels("organization_projects").includes("admin"));
});

test("the display name does not determine the slug", () => {
  // `Members` is an organization permission whose slug carries no
  // `organization_` prefix. Prefix-as-plane is therefore unsound, and so is any
  // probe that derives its target from the slug.
  const members = docs.permissions.find((p) => p.plane === "organization" && p.name === "Members");
  assert.equal(members.slug, "members");
  assert.notEqual(guessSlug(members.name, members.plane), members.slug);
  assert.ok("members" in wire);

  const handAsserted = r.resolved.filter((x) => x.asserted);
  assert.ok(
    handAsserted.length >= 4,
    "at least four correspondences survive only because a slug was asserted by hand",
  );
});

test("the two vocabularies diverge in both directions", () => {
  assert.ok(r.unresolved.length > 0, "grant entries with no wire slug");
  assert.ok(r.orphans.length > 0, "wire slugs no grant entry claims");

  // The worked example: a door already planned in org-map.md that the
  // machine-readable source cannot express.
  assert.ok(
    r.unresolved.some((u) => u.name === "Issue Types" && u.plane === "organization"),
    "organization Issue Types -- gh-issues-room's door -- has no wire slug",
  );
  assert.ok(!("organization_issue_types" in wire));
});

test("the fixture is the schema, not a hand-written enum", () => {
  assert.equal(Object.keys(wire).length, 55);
  for (const [slug, l] of Object.entries(wire)) {
    assert.ok(Array.isArray(l) && l.length > 0, `${slug} has no levels`);
    assert.ok(l.every((x) => ["read", "write", "admin"].includes(x)), `${slug}: ${l}`);
  }
});

test("the transcription declares whether a human has checked it", () => {
  // `verified: false` is not a failure -- it is the file admitting what it is.
  // This asserts the field exists, so the admission cannot be dropped silently.
  assert.equal(typeof docs.verified, "boolean");
  assert.match(docs.retrieved, /^\d{4}-\d{2}-\d{2}$/);
});
