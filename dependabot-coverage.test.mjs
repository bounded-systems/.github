import { test } from "node:test";
import assert from "node:assert/strict";
import {
  coverageReport,
  readDependabotUpdates,
  formatReport,
  ECOSYSTEM_FOR,
} from "./dependabot-coverage.mjs";

// The shared template, verbatim in the shape that matters. Eight repos carried
// this byte-identical on 2026-08-28 (blob 0376284).
const TEMPLATE = `# Keep every action pin current.
#
# ADOPTING THIS FILE
# Repo already has one (other ecosystems - npm, cargo, pip): APPEND.
version: 2
updates:
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
      day: "monday"
    groups:
      actions:
        patterns:
          - "*"
    commit-message:
      prefix: "ci"
`;

// prx: the only repo that was already right, and the multi-ecosystem case.
const PRX = `version: 2
updates:
  - package-ecosystem: "bun"
    directory: "/"
    schedule:
      interval: "weekly"
    groups:
      bun-minor-patch:
        patterns: ["*"]
        update-types: ["minor", "patch"]
  - package-ecosystem: "docker"
    directory: "/"
    schedule:
      interval: "weekly"
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
`;

// keycard: merged correctly, and the non-root `directory` case.
const KEYCARD = `version: 2
updates:
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
  - package-ecosystem: "cargo"
    directory: "/tools"
    schedule:
      interval: "weekly"
`;

test("reader: the shared template yields exactly one entry", () => {
  assert.deepEqual(readDependabotUpdates(TEMPLATE), [
    { ecosystem: "github-actions", directory: "/" },
  ]);
});

test("reader: comments mentioning other ecosystems are not entries", () => {
  // The template's prose names npm, cargo and pip. A naive grep would find
  // three ecosystems here and call the config complete - the exact way this
  // bug stayed invisible.
  const found = readDependabotUpdates(TEMPLATE).map((u) => u.ecosystem);
  assert.deepEqual(found, ["github-actions"]);
  assert.ok(TEMPLATE.includes("npm, cargo, pip"));
});

test("reader: multi-entry config keeps order and directories", () => {
  assert.deepEqual(readDependabotUpdates(PRX), [
    { ecosystem: "bun", directory: "/" },
    { ecosystem: "docker", directory: "/" },
    { ecosystem: "github-actions", directory: "/" },
  ]);
  assert.deepEqual(readDependabotUpdates(KEYCARD), [
    { ecosystem: "github-actions", directory: "/" },
    { ecosystem: "cargo", directory: "/tools" },
  ]);
});

test("reader: tolerates unquoted values and missing directory", () => {
  const t = `version: 2
updates:
  - package-ecosystem: npm
    schedule:
      interval: weekly
`;
  assert.deepEqual(readDependabotUpdates(t), [{ ecosystem: "npm", directory: "/" }]);
});

test("agent-memory: npm manifest, actions-only config -> uncovered", () => {
  const r = coverageReport({
    paths: ["package.json", "package-lock.json", ".github/workflows/deps.yml"],
    updates: readDependabotUpdates(TEMPLATE),
  });
  assert.equal(r.ok, false);
  assert.deepEqual(
    r.uncovered.map((u) => u.ecosystem),
    ["npm"],
  );
  assert.deepEqual(
    r.covered.map((u) => u.ecosystem),
    ["github-actions"],
  );
});

test("hooksmith: cargo manifest, actions-only config -> uncovered", () => {
  const r = coverageReport({
    paths: ["Cargo.toml", "Cargo.lock", ".github/workflows/deps.yml"],
    updates: readDependabotUpdates(TEMPLATE),
  });
  assert.equal(r.ok, false);
  assert.deepEqual(
    r.uncovered.map((u) => u.ecosystem),
    ["cargo"],
  );
});

test("front-desk-scheduler: no config at all -> everything uncovered", () => {
  const r = coverageReport({
    paths: ["package.json", ".github/workflows/test.yml"],
    updates: [],
  });
  assert.equal(r.ok, false);
  assert.deepEqual(
    r.uncovered.map((u) => u.ecosystem).sort(),
    ["github-actions", "npm"],
  );
});

test("THE BUN TRAP: bun.lock declared as npm is still uncovered", () => {
  // This is the failure the check exists to catch that review does not. An npm
  // entry beside a bun.lock reads as correct and updates nothing: Dependabot's
  // npm ecosystem does not parse a bun lockfile. verbspec-mcp was given `npm`
  // on 2026-08-28 for exactly this reason and needed a follow-up to `bun`.
  const npmOnly = `version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
`;
  const r = coverageReport({
    paths: ["package.json", "bun.lock"],
    updates: readDependabotUpdates(npmOnly),
  });
  assert.equal(r.ok, false);
  assert.deepEqual(
    r.uncovered.map((u) => u.ecosystem),
    ["bun"],
  );
});

test("prx: bun + docker + actions is fully covered", () => {
  const r = coverageReport({
    paths: [
      "package.json",
      "bun.lock",
      "Dockerfile",
      ".github/workflows/ci.yml",
    ],
    updates: readDependabotUpdates(PRX),
  });
  assert.equal(r.ok, true, formatReport("prx", r));
  assert.equal(r.uncovered.length, 0);
});

test("keycard: cargo in a subdirectory is matched on directory, not just ecosystem", () => {
  const paths = ["tools/Cargo.toml", ".github/workflows/pr.yml"];
  const ok = coverageReport({ paths, updates: readDependabotUpdates(KEYCARD) });
  assert.equal(ok.ok, true, formatReport("keycard", ok));

  // Same manifest, cargo declared at the ROOT instead: must NOT count.
  const wrongDir = `version: 2
updates:
  - package-ecosystem: "github-actions"
    directory: "/"
  - package-ecosystem: "cargo"
    directory: "/"
`;
  const bad = coverageReport({ paths, updates: readDependabotUpdates(wrongDir) });
  assert.equal(bad.ok, false);
  assert.equal(bad.uncovered[0].directory, "/tools");
});

test("deno is uncoverable, reported, and never fails the check", () => {
  const r = coverageReport({
    paths: ["deno.json", "deno.lock", ".github/workflows/deps.yml"],
    updates: readDependabotUpdates(TEMPLATE),
  });
  assert.equal(r.ok, true, "deno alone must not fail - no config can fix it");
  assert.equal(r.uncoverable.length, 2);
  assert.match(formatReport("fold-engine", r), /no Dependabot ecosystem for deno/);
});

test("static-mcp: npm uncovered AND deno noted, independently", () => {
  const r = coverageReport({
    paths: ["package.json", "package-lock.json", "deno.json", "deno.lock"],
    updates: readDependabotUpdates(TEMPLATE),
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.uncovered.map((u) => u.ecosystem), ["npm"]);
  assert.equal(r.uncoverable.length, 2);
});

test("guest-room: a package.json with no lockfile still wants npm", () => {
  // guest-room declares no dependencies today, so actions-only is defensible -
  // but the moment it gains one, this must go red rather than stay quiet.
  const r = coverageReport({
    paths: ["package.json"],
    updates: [],
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.uncovered.map((u) => u.ecosystem), ["npm"]);
});

test("package.json beside a lockfile is not double-counted", () => {
  const r = coverageReport({
    paths: ["package.json", "package-lock.json"],
    updates: [{ ecosystem: "npm", directory: "/" }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.covered.length, 1);
});

test("no manifests at all is ok", () => {
  assert.equal(coverageReport({ paths: ["README.md"], updates: [] }).ok, true);
});

test("every ECOSYSTEM_FOR value is a real Dependabot ecosystem name", () => {
  const REAL = new Set([
    "npm", "bun", "cargo", "gomod", "pip", "uv", "bundler", "composer",
    "docker", "github-actions", "gradle", "maven", "nuget", "pub", "swift",
    "terraform", "devcontainers", "elm", "gitsubmodule", "mix", "helm",
  ]);
  for (const eco of ECOSYSTEM_FOR.values()) {
    assert.ok(REAL.has(eco), `${eco} is not a Dependabot ecosystem`);
  }
});

test("workspace members are covered by the workspace root", () => {
  // hooksmith is one cargo workspace with 28 member crates. Reporting each as
  // a separate missing directory is technically true and practically useless -
  // a root cargo entry updates them all.
  const paths = [
    "Cargo.toml",
    "Cargo.lock",
    "crates/core/Cargo.toml",
    "crates/tools/Cargo.toml",
    "crates/tools/migrate-to-monorepo/Cargo.toml",
  ];
  const workspaces = [{ ecosystem: "cargo", directory: "/" }];

  const missing = coverageReport({ paths, updates: [], workspaces });
  assert.deepEqual(
    missing.uncovered.map((u) => `${u.ecosystem} ${u.directory}`),
    ["cargo /"],
    "one finding for the workspace, not one per member",
  );

  const declared = coverageReport({
    paths,
    updates: [{ ecosystem: "cargo", directory: "/" }],
    workspaces,
  });
  assert.equal(declared.ok, true, formatReport("hooksmith", declared));
});

test("a manifest OUTSIDE the workspace is still reported", () => {
  // hooksmith's js/package.json is not a cargo workspace member and must not
  // be swallowed by the cargo root.
  const r = coverageReport({
    paths: ["Cargo.toml", "js/package.json"],
    updates: [{ ecosystem: "cargo", directory: "/" }],
    workspaces: [{ ecosystem: "cargo", directory: "/" }],
  });
  assert.equal(r.ok, false);
  assert.deepEqual(
    r.uncovered.map((u) => `${u.ecosystem} ${u.directory}`),
    ["npm /js"],
  );
});

test("a bun workspace root covers npm-shaped members", () => {
  // prx declares `bun` at the root and has workspace members under packages/*.
  const r = coverageReport({
    paths: ["package.json", "bun.lock", "packages/a/package.json"],
    updates: [{ ecosystem: "bun", directory: "/" }],
    workspaces: [{ ecosystem: "bun", directory: "/" }],
  });
  assert.equal(r.ok, true, formatReport("prx", r));
});

test("workspace roots do not cover a DIFFERENT ecosystem", () => {
  const r = coverageReport({
    paths: ["Cargo.toml", "sub/requirements.txt"],
    updates: [{ ecosystem: "cargo", directory: "/" }],
    workspaces: [{ ecosystem: "cargo", directory: "/" }],
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.uncovered.map((u) => u.ecosystem), ["pip"]);
});
