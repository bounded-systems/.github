#!/usr/bin/env node
// Render the @bounded-systems knowledge-graph diagram into profile/README.md.
//
// Single public source: bounded-systems/site/data/registry.json (itself
// generated from each package's package.json `bounded.*`). GitHub renders the
// Mermaid block natively on the org profile. The block between
// `<!-- registry-graph:start … -->` / `<!-- registry-graph:end -->` is GENERATED.
//
//   node scripts/gen-registry-graph.mjs           rewrite the marked region
//   node scripts/gen-registry-graph.mjs --check    exit 1 if stale (CI drift gate)
//   node scripts/gen-registry-graph.mjs --offline   render from a local file (tests)

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const README = join(root, "profile", "README.md");
const SRC = "https://raw.githubusercontent.com/bounded-systems/site/main/data/registry.json";
const START = "<!-- registry-graph:start";
const END = "<!-- registry-graph:end -->";
const args = new Set(process.argv.slice(2));
const id = (s) => s.replace(/[^a-zA-Z0-9]/g, "_");

async function loadRegistry() {
  if (args.has("--offline")) {
    return JSON.parse(await readFile(join(root, "scripts", "registry.fixture.json"), "utf8"));
  }
  const res = await fetch(SRC, { headers: { "User-Agent": "bounded-systems-profile" } });
  if (!res.ok) throw new Error(`${res.status} fetching ${SRC}`);
  return res.json();
}

function render({ nodes, edges }) {
  const decls = nodes.map((n) => `  ${id(n.name)}["${n.name} · ${n.role}"]`);
  const links = edges.map((e) => `  ${id(e.from)} --> ${id(e.to)}`);
  const nouns = nodes.filter((n) => n.facet === "noun").map((n) => id(n.name));
  const verbs = nodes.filter((n) => n.facet === "verb").map((n) => id(n.name));
  const counts = `${verbs.length} verbs (capabilities) · ${nouns.length} nouns (data) · ${edges.length} typed edges`;
  return [
    "",
    `Every \`@bounded-systems/*\` library is a typed node: a **verb** (a capability that acts) or a **noun** (data that flows), declared in its own \`package.json\`. An arrow \`A → B\` means A's contract consumes B's. Generated from [each package's \`bounded.*\`](https://github.com/bounded-systems/site/blob/main/data/registry.json) and drift-checked in CI — *${counts}.*`,
    "",
    "```mermaid",
    "flowchart TD",
    ...decls,
    ...links,
    "  classDef noun fill:#1f6f43,stroke:#2ea043,color:#fff;",
    "  classDef verb fill:#1f4f8f,stroke:#388bfd,color:#fff;",
    `  class ${nouns.join(",")} noun;`,
    `  class ${verbs.join(",")} verb;`,
    "```",
    "",
  ].join("\n");
}

function splice(md, body) {
  const s = md.indexOf(START), e = md.indexOf(END);
  if (s === -1 || e === -1) throw new Error("registry-graph markers not found in profile/README.md");
  const afterStart = md.indexOf("-->", s) + 3;
  return `${md.slice(0, afterStart)}\n${body}\n${md.slice(e)}`;
}

const reg = await loadRegistry();
const md = await readFile(README, "utf8");
const next = splice(md, render(reg));

if (args.has("--check")) {
  if (next !== md) {
    console.error("✗ knowledge-graph in profile/README.md is stale — run: node scripts/gen-registry-graph.mjs");
    process.exit(1);
  }
  console.log("✓ knowledge-graph is in sync with the registry");
  process.exit(0);
}
if (next !== md) {
  await writeFile(README, next);
  console.log("✓ regenerated knowledge-graph in profile/README.md");
} else {
  console.log("✓ already up to date");
}
