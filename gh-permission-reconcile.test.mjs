// The claims in .github#104 and knowledge/ocap-github.md are numbers. Pin them
// here so the argument for `ocap-github` cannot quietly stop being true --
// asserting on the reconciler rather than reimplementing it, the same way
// bootstrap-pin.test.mjs asserts on its generator.
//
// Fixture-only: no network, so a docs.github.com or raw.githubusercontent
// outage cannot turn this red for reasons unrelated to the claim.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  guessSlug,
  loadDocs,
  loadSlugs,
  loadWire,
  reconcile,
} from "./scripts/gh-permission-reconcile.mjs";

process.argv.push("--offline");
const wire = await loadWire();
const docs = await loadDocs();
const slugs = await loadSlugs();
const r = reconcile(wire, docs, slugs);

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
  assert.equal(slugs["organization/Members"].slug, "members");
  assert.notEqual(guessSlug("Members", "organization"), "members");
  assert.ok("members" in wire);
  assert.ok(docs.permissions.some((p) => p.plane === "organization" && p.name === "Members"));

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

test("the grant vocabulary is parsed, not asserted", () => {
  // It was hand-transcribed once, and the first parse caught the transcription
  // recording 13 account permissions where the page publishes 14. These assert
  // the file is still derived from the page and still carries what it was
  // derived from.
  assert.match(docs.source_sha256, /^[0-9a-f]{64}$/);
  assert.match(docs.retrieved, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(docs.counts.total, docs.permissions.length);
  assert.equal(docs.counts.user, 14);

  for (const p of docs.permissions) {
    assert.ok(p.endpoints > 0, `${p.plane}/${p.name} derived from no endpoint rows`);
    assert.ok(p.levels.length > 0, `${p.plane}/${p.name} has no levels`);
    assert.ok(p.anchor.startsWith(`${p.plane}-permissions-for-`));
  }
});

test("endpoint -> permission is published, just not in the OpenAPI description", () => {
  // Correction to the first version of this claim (#104): the mapping is absent
  // from the description, but the docs page carries it as a table per
  // permission. Only GraphQL and webhooks are genuinely probe-only.
  const rows = docs.permissions.reduce((n, p) => n + p.endpoints, 0);
  assert.ok(rows > 1000, `expected a substantial endpoint table, got ${rows} rows`);

  // The level set is derived FROM those rows, which is why write-only
  // permissions fall out rather than being asserted.
  const workflows = docs.permissions.find((p) => p.name === "Workflows");
  assert.deepEqual(workflows.levels, ["write"]);
  assert.deepEqual(wire.workflows, ["write"], "grant and wire agree that workflows is write-only");
});
