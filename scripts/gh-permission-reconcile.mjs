#!/usr/bin/env node
// Reconcile GitHub's two App-permission vocabularies against each other.
//
// GitHub publishes the same concept twice and the two do not agree:
//
//   wire      components.schemas.app-permissions in github/rest-api-description
//             -- what `default_permissions` and the token-mint `permissions`
//             object actually accept. Machine-readable, carries exact levels.
//   grant     the "Permissions required for GitHub Apps" docs page
//             -- what an installer sees and approves. Published as HTML only,
//             parsed into scripts/gh-permissions-docs.json by
//             scripts/gen-gh-permissions-docs.mjs.
//
// The display-name -> slug correspondences that normalization cannot derive are
// authored in scripts/gh-permission-slugs.json, deliberately separate so the
// generated file stays generated.
//
// Neither is a superset of the other, and the display name does not determine
// the slug (`Members` -> `members`, with no `organization_` prefix, is the
// case that kills the prefix-as-plane heuristic). This script measures the
// gap rather than papering over it: whatever it cannot resolve is reported as
// unresolved, because the unresolved set IS the work item (see .github#104).
//
// This is an instrument, not a gate. It is deliberately not wired into CI:
// gating on a divergence nobody has triaged would make the first triage a
// merge blocker. `--check` exists for when that changes.
//
//   node scripts/gh-permission-reconcile.mjs             human-readable report
//   node scripts/gh-permission-reconcile.mjs --json      machine-readable
//   node scripts/gh-permission-reconcile.mjs --offline    use the cached fixture
//   node scripts/gh-permission-reconcile.mjs --check      exit 1 on any divergence
//
// Findings this reproduces (measured 2026-08-06, api.github.com description):
//   - 55 wire slugs; 8 deviate from read/write (4 admit admin, 2 write-only,
//     2 read-only), so `read < write < admin` is wrong as a universal lattice.
//   - `workflows` is write-only: `workflows: read` is unconstructible.
//   - `organization_issue_types` has no wire slug, and org Issue Types is
//     gh-issues-room's declared door.
//   - API version is not the drift axis: 2022-11-28 and 2026-03-10 yield
//     byte-identical app-permissions.

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = join(root, "scripts", "gh-permissions-docs.json");
const SLUGS = join(root, "scripts", "gh-permission-slugs.json");
const FIXTURE = join(root, "scripts", "gh-app-permissions.fixture.json");
const SRC =
  "https://raw.githubusercontent.com/github/rest-api-description/main" +
  "/descriptions/api.github.com/api.github.com.json";

const args = new Set(process.argv.slice(2));

/** Naive display-name -> slug guess. Its failures are the point, not a bug. */
export const guessSlug = (name, plane) => {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return plane === "organization" && !base.startsWith("organization_")
    ? `organization_${base}`
    : plane === "enterprise" && !base.startsWith("enterprise_")
      ? `enterprise_${base}`
      : base;
};

export async function loadWire() {
  if (args.has("--offline")) {
    return JSON.parse(await readFile(FIXTURE, "utf8"));
  }
  const res = await fetch(SRC, { headers: { "User-Agent": "bounded-systems-ocap-github" } });
  if (!res.ok) throw new Error(`${res.status} fetching ${SRC}`);
  const doc = JSON.parse(await res.text());
  const props = doc.components?.schemas?.["app-permissions"]?.properties;
  if (!props) throw new Error("app-permissions schema not found in description");
  const wire = {};
  for (const [slug, spec] of Object.entries(props)) wire[slug] = spec.enum ?? [];
  if (args.has("--write-fixture")) {
    await writeFile(FIXTURE, `${JSON.stringify(wire, null, 2)}\n`);
  }
  return wire;
}

export function reconcile(wire, docs, slugs = {}) {
  const claimed = new Map(); // slug -> grant entry that claimed it
  const resolved = [];
  const unresolved = [];

  for (const entry of docs.permissions) {
    const asserted = slugs[`${entry.plane}/${entry.name}`]?.slug;
    const slug = asserted ?? guessSlug(entry.name, entry.plane);
    if (!(slug in wire)) {
      unresolved.push({ ...entry, tried: slug });
      continue;
    }
    // A slug claimed twice means the transcription is wrong, not GitHub.
    const collision = claimed.get(slug);
    if (collision) unresolved.push({ ...entry, tried: slug, collidesWith: collision });
    else {
      claimed.set(slug, `${entry.plane}/${entry.name}`);
      resolved.push({ ...entry, slug, wireLevels: wire[slug], asserted: Boolean(asserted) });
    }
  }

  const orphans = Object.keys(wire)
    .filter((s) => !claimed.has(s))
    .map((s) => ({ slug: s, levels: wire[s] }));

  const levelDivergence = resolved.filter(
    (r) => JSON.stringify(r.levels) !== JSON.stringify(r.wireLevels),
  );

  const nonUniform = Object.entries(wire)
    .filter(([, l]) => JSON.stringify(l) !== JSON.stringify(["read", "write"]))
    .map(([slug, levels]) => ({ slug, levels }));

  return { resolved, unresolved, orphans, levelDivergence, nonUniform };
}

export const digest = (wire) =>
  createHash("sha256").update(JSON.stringify(wire, Object.keys(wire).sort())).digest("hex");

function report(r, wire, docs) {
  const line = (s = "") => console.log(s);
  line(`wire  : ${Object.keys(wire).length} slugs   (app-permissions, sha256 ${digest(wire).slice(0, 16)})`);
  const c = docs.counts;
  line(
    `grant : ${docs.permissions.length} entries  (parsed ${docs.retrieved}, page sha256 ` +
      `${docs.source_sha256.slice(0, 16)})`,
  );
  line(`        enterprise ${c.enterprise}, organization ${c.organization}, ` +
    `repository ${c.repository}, user ${c.user} -- plane exists only here`);

  line(`\n## lattice -- ${r.nonUniform.length} of ${Object.keys(wire).length} slugs deviate from read/write`);
  for (const { slug, levels } of r.nonUniform) line(`  ${slug.padEnd(48)} ${levels.join("/")}`);
  line("  A universal `read < write < admin` is wrong for every row above.");

  line(`\n## unresolved -- ${r.unresolved.length} grant entries with no wire slug`);
  for (const u of r.unresolved) {
    const why = u.collidesWith ? `collides with ${u.collidesWith}` : `tried ${u.tried}`;
    line(`  ${u.plane}/${u.name}`.padEnd(58) + why);
  }

  line(`\n## orphans -- ${r.orphans.length} wire slugs no grant entry claims`);
  for (const o of r.orphans) line(`  ${o.slug.padEnd(48)} ${o.levels.join("/")}`);

  line(`\n## level divergence -- ${r.levelDivergence.length} resolved pairs disagree on levels`);
  for (const d of r.levelDivergence) {
    line(`  ${d.slug.padEnd(40)} grant ${d.levels.join("/").padEnd(18)} wire ${d.wireLevels.join("/")}`);
  }

  const asserted = r.resolved.filter((x) => x.asserted).length;
  line(
    `\nresolved ${r.resolved.length} (${asserted} only because a slug was asserted by hand; ` +
      `naive normalization would have missed them)`,
  );
}

export const loadDocs = async () => JSON.parse(await readFile(DOCS, "utf8"));
export const loadSlugs = async () => JSON.parse(await readFile(SLUGS, "utf8")).slugs;

// Importing this module must not run the CLI -- the test drives the pure
// functions over the fixture, with no network.
if (import.meta.url === `file://${process.argv[1]}`) {
  const wire = await loadWire();
  const docs = await loadDocs();
  const r = reconcile(wire, docs, await loadSlugs());

  if (args.has("--json")) {
    console.log(JSON.stringify({ digest: digest(wire), ...r }, null, 2));
  } else {
    report(r, wire, docs);
  }

  if (args.has("--check")) {
    const n = r.unresolved.length + r.orphans.length + r.levelDivergence.length;
    if (n > 0) {
      console.error(`\ngh-permission-reconcile: ${n} divergence(s); see .github#104`);
      process.exit(1);
    }
  }
}
