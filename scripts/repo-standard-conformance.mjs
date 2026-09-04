#!/usr/bin/env bun
// repo-standard-conformance — which PUBLIC repos call repo-standard.yml, with
// what configuration, and whether that lane ran green on their default branch.
// The projection behind `.github`#381; the tiers it answers are laid out in
// `.github-private`#912.
//
// ── Why this exists ──────────────────────────────────────────────────────────
// The fleet feed (hooks.bounded.tools/ci.json, .github-private#481) lists RED
// workflow runs per repo and publishes green as a COUNT. So a repo with no
// `standard` caller at all, or with `test: false` while it carries a Cargo.toml,
// is indistinguishable from a healthy one: nothing reds, nothing is listed.
// That is failing open, and the only record of who calls the standard is a hand
// survey dated 2026-08-17 (`.github-private` → docs/ci-green-survey.md).
//
// This turns that state into a row per repo, daily, with an asserted
// denominator, so absence becomes a fact a page can show and — in strict mode —
// a check can refuse.
//
// ── What it measures, and what it deliberately does not ──────────────────────
//   - PUBLIC repos only. The enumeration is `type=public`, verified EXACTLY
//     against /orgs/{org}.public_repos. No private name can enter a public
//     branch or a public log because none is ever read. Private repos'
//     conformance is `.github-private`'s own pr.yml.
//   - A FINDING is a defect of the repo (no caller, unpinned ref, filtered
//     pull_request trigger, a toolchain with no test lane, a red run). A
//     MEASUREMENT GAP is a limit of this lane (a listing it could not read, a
//     runs endpoint that answered 403). The two are kept in different fields
//     and never summed, because "we could not tell" is not "there is nothing"
//     — the same rule desk's overview applies per section.
//   - Runtime mismatch and repo-specific workflows are REPORTED, not findings:
//     keycard legitimately runs `runtime: none` and installs elan in its test
//     command, and a `ci.yml` may be exactly the thing that should fold into
//     the standard next. A human decides; the row gives them the material.
//
// ── Seams ────────────────────────────────────────────────────────────────────
// Every decision below is a pure function of already-fetched data, so the test
// suite pins them against fixtures taken from real callers without a network.
// The sweep (`main`) takes `fetchImpl`, so the denominator refusal and the
// per-row unreadable states are exercised with a fake fetch rather than trusted.

export const ORG = "bounded-systems";
export const STANDARD_REPO = `${ORG}/.github`;
export const STANDARD_PATH = ".github/workflows/repo-standard.yml";
export const STANDARD_USES = `${STANDARD_REPO}/${STANDARD_PATH}`;
export const SELFTEST_FILE = "repo-standard-selftest.yml";
export const FLEET_FEED = "https://hooks.bounded.tools/ci.json";
export const FEED_NAME = "repo-standard-conformance";
export const SNAPSHOT_BRANCH = "repo-standard-conformance";
export const SNAPSHOT_FILE = "repo-standard-conformance.json";

/**
 * Workflows the org rolls out from a template or a shared lane, by basename.
 * Anything else under .github/workflows/ is repo-specific and listed as `extra`
 * — the material for "should this fold into the standard, and if not, why".
 * Basename, not content, because that is how the survey counted and how the
 * re-roll lanes address them; the row still records what each one `uses:`.
 */
export const ORG_MANAGED = new Map([
  ["standard.yml", "repo-standard.yml (this repo)"],
  ["deps.yml", "ci-workflows osv-scan.yml"],
  ["front-desk-add.yml", ".github-private docs/handoffs/front-desk-add.yml"],
  ["pr-claim.yml", "_pr-claim.yml (this repo)"],
  ["claim-sweep.yml", "_claim-sweep.yml (this repo)"],
  ["version.yml", "mint version.yml"],
  ["dependabot-auto-merge.yml", ".github-private docs/handoffs/dependabot-auto-merge.yml"],
  ["lease-key-rotation.yml", ".github-private docs/handoffs/lease-key-rotation.yml"],
  ["gate.yml", ".github-private docs/handoffs/gate.yml"],
]);

/**
 * The inputs repo-standard.yml declares, with its defaults, so a row reports the
 * EFFECTIVE configuration rather than only what the caller wrote. Kept in step
 * with the reusable workflow by hand; the selftest caller in this repo is one
 * of the fixtures, so a drift shows up as a test failure here.
 */
export const STANDARD_INPUT_DEFAULTS = {
  security: true,
  "security-gate": false,
  spell: false,
  quality: true,
  test: false,
  descriptor: false,
  runtime: "none",
  "test-command": "",
};

/**
 * A root-level manifest implies a toolchain, and a toolchain with no `test:
 * true` is a repo whose tests — if any — gate nothing. That is the fail-closed
 * rule from the direction: an absent test lane fails open, so its absence is a
 * finding. The runtime each manifest implies is the soft half: which `runtime:`
 * values would be consistent with it.
 */
export const MANIFEST_RUNTIME = new Map([
  ["deno.json", "deno"],
  ["deno.jsonc", "deno"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "node"],
  ["npm-shrinkwrap.json", "node"],
  ["pnpm-lock.yaml", "node"],
  ["yarn.lock", "node"],
  ["package.json", "node"],
  ["Cargo.toml", "cargo"],
  ["lakefile.lean", "lean"],
  ["lakefile.toml", "lean"],
  ["lean-toolchain", "lean"],
  ["go.mod", "go"],
  ["pyproject.toml", "python"],
  ["requirements.txt", "python"],
  ["flake.nix", "nix"],
]);

/** Which `runtime:` inputs are consistent with each implied toolchain. */
export const RUNTIME_ACCEPTS = new Map([
  ["deno", ["deno", "nix"]],
  ["bun", ["bun", "nix"]],
  ["node", ["node", "bun", "nix"]],
  // The runner ships cargo/go/python; lean is installed by the test command
  // (keycard). `none` is the honest declaration for all of these.
  ["cargo", ["none", "nix"]],
  ["lean", ["none", "nix"]],
  ["go", ["none", "nix"]],
  ["python", ["none", "nix"]],
  ["nix", ["nix", "none"]],
]);

/** Run conclusions that mean the lane RAN and REFUSED. Cancelled and skipped are neither — same split the fleet reducer makes. */
export const RED_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure", "action_required"]);

const SHA = /^[0-9a-f]{40}$/;

// ── pure classification ──────────────────────────────────────────────────────

/** Is this `uses:` the standard? Returns the pin (or "local" for this repo's own caller) or null. */
export function matchStandard(uses) {
  if (typeof uses !== "string") return null;
  if (uses.startsWith(`${STANDARD_USES}@`)) {
    return { pin: uses.slice(STANDARD_USES.length + 1).trim().split(/\s+/)[0], local: false };
  }
  if (uses === `./${STANDARD_PATH}`) return { pin: "local", local: true };
  return null;
}

/**
 * The `pull_request` trigger predicate from the ci-green survey: a required
 * context must REPORT on every PR, which needs the trigger present, unfiltered
 * by paths, and re-firing on `synchronize`. `on:` may be a string, a list, or
 * a map, and Bun.YAML keeps the key as the string "on" (YAML 1.2 — not the 1.1
 * boolean the survey warns about).
 */
export function pullRequestTrigger(on) {
  if (typeof on === "string") return on === "pull_request" ? { present: true, unfiltered: true, synchronize: true } : { present: false };
  if (Array.isArray(on)) return on.includes("pull_request") ? { present: true, unfiltered: true, synchronize: true } : { present: false };
  if (on && typeof on === "object" && Object.prototype.hasOwnProperty.call(on, "pull_request")) {
    const pr = on.pull_request && typeof on.pull_request === "object" ? on.pull_request : {};
    const filtered = Boolean(pr.paths || pr["paths-ignore"]);
    const synchronize = !Array.isArray(pr.types) || pr.types.includes("synchronize");
    return { present: true, unfiltered: !filtered, synchronize };
  }
  return { present: false };
}

/** Does `on:` run on pushes to the default branch (or all pushes)? */
export function pushesDefault(on, defaultBranch) {
  if (typeof on === "string") return on === "push";
  if (Array.isArray(on)) return on.includes("push");
  if (on && typeof on === "object" && Object.prototype.hasOwnProperty.call(on, "push")) {
    const push = on.push && typeof on.push === "object" ? on.push : {};
    if (!Array.isArray(push.branches)) return true;
    return push.branches.some((b) => b === defaultBranch || b === "**" || b === "*");
  }
  return false;
}

/** Trigger names of a workflow, for the `extra` list. */
export function triggerNames(on) {
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.map(String);
  if (on && typeof on === "object") return Object.keys(on);
  return [];
}

/** Every reusable workflow a workflow calls (`jobs.*.uses`). */
export function reusableCalls(doc) {
  const jobs = doc?.jobs && typeof doc.jobs === "object" ? doc.jobs : {};
  return Object.values(jobs)
    .map((j) => (j && typeof j.uses === "string" ? j.uses : null))
    .filter(Boolean);
}

/**
 * Find the job that calls repo-standard across a repo's parsed workflows.
 * First match wins; a repo calling the standard twice is not a shape the
 * survey found, and the row still lists every workflow.
 */
export function findCaller(files, defaultBranch = "main") {
  for (const f of files) {
    if (!f.doc || f.error) continue;
    const jobs = f.doc.jobs && typeof f.doc.jobs === "object" ? f.doc.jobs : {};
    for (const [id, job] of Object.entries(jobs)) {
      const m = matchStandard(job?.uses);
      if (!m) continue;
      const written = job.with && typeof job.with === "object" ? job.with : {};
      const effective = { ...STANDARD_INPUT_DEFAULTS, ...written };
      return {
        state: "present",
        path: f.path,
        job: id,
        uses: job.uses,
        pin: m.pin,
        pinned: m.local || SHA.test(m.pin),
        with: written,
        effective,
        pull_request: pullRequestTrigger(f.doc.on),
        push_default: pushesDefault(f.doc.on, defaultBranch),
      };
    }
  }
  return { state: "absent" };
}

/** Toolchains the root listing implies, and whether the configured runtime is consistent with any of them. */
export function runtimeExpectation(rootNames, configured) {
  const expected = [...new Set(rootNames.map((n) => MANIFEST_RUNTIME.get(n)).filter(Boolean))].sort();
  if (expected.length === 0) return { expected, configured, match: null };
  const ok = expected.some((e) => (RUNTIME_ACCEPTS.get(e) || []).includes(configured));
  return { expected, configured, match: ok };
}

/**
 * One repo → one row. `files` are parsed workflows ({path, doc, error}) or null
 * when the listing could not be read; `root` is the root listing's names or
 * null; `run` is the latest completed run of the caller on the default branch
 * ({conclusion, url, sha, at} | {unreadable} | null); `fleet` is the per-repo
 * slice of ci.json or null when the feed was unavailable.
 */
export function classifyRepo({ repo, archived = false, defaultBranch = "main", files, filesError = null, root, rootError = null, run = null, fleet = null, headSha = null, tier = null }) {
  const findings = [];
  const gaps = [];
  const row = { repo: `${ORG}/${repo}`, archived, default_branch: defaultBranch, tier };

  // workflows
  if (!files) {
    row.workflows = { read: false, reason: filesError || "unreadable" };
    row.caller = { state: "unreadable" };
    gaps.push("workflows-unreadable");
  } else {
    const parseErrors = files.filter((f) => f.error).map((f) => f.path);
    row.workflows = { read: true, count: files.length, parse_errors: parseErrors };
    row.caller = findCaller(files, defaultBranch);
    if (row.caller.state === "absent") findings.push("caller-absent");
    else {
      if (!row.caller.pinned) findings.push("pin-not-sha");
      row.caller.pin_is_head = headSha && row.caller.pin !== "local" ? row.caller.pin === headSha : null;
      // The trigger predicate is the survey's "a required context must report
      // on every PR". It is not applied to the standard's OWN repo: its local
      // caller is repo-standard-selftest.yml, path-filtered on purpose, and
      // that repo's required context is `schema`. Everything else about the
      // local caller — pin, inputs, test lane, run — is measured like any other.
      const pr = row.caller.pull_request;
      if (row.caller.pin === "local") row.caller.trigger_predicate = "not applied: the standard's own repo gates on schema";
      else if (!pr.present) findings.push("pull-request-missing");
      else {
        if (!pr.unfiltered) findings.push("pull-request-filtered");
        if (!pr.synchronize) findings.push("pull-request-no-synchronize");
      }
    }
    row.managed = files.map((f) => f.path.split("/").pop()).filter((b) => ORG_MANAGED.has(b)).sort();
    row.extra = files
      .filter((f) => !ORG_MANAGED.has(f.path.split("/").pop()))
      .map((f) => ({
        path: f.path,
        name: f.doc && typeof f.doc.name === "string" ? f.doc.name : null,
        on: f.doc ? triggerNames(f.doc.on) : [],
        uses: f.doc ? reusableCalls(f.doc) : [],
        parse_error: f.error || null,
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  // manifests → test lane, runtime
  if (!root) {
    row.manifests = null;
    row.test_lane = "unmeasured";
    row.runtime = null;
    gaps.push(rootError ? `root-unreadable:${rootError}` : "root-unreadable");
  } else {
    row.manifests = root.filter((n) => MANIFEST_RUNTIME.has(n)).sort();
    const configured = row.caller.state === "present" ? String(row.caller.effective.runtime) : null;
    row.runtime = runtimeExpectation(row.manifests, configured);
    if (row.manifests.length === 0) row.test_lane = "n/a";
    else if (row.caller.state === "present" && row.caller.effective.test === true) row.test_lane = "present";
    else if (row.caller.state === "present") { row.test_lane = "absent"; findings.push("test-lane-absent"); }
    else row.test_lane = "absent"; // no caller at all: already a finding; do not count it twice
  }

  // the caller's latest completed run on the default branch
  if (row.caller.state !== "present") row.standard_run = null;
  else if (!run) { row.standard_run = { state: "none" }; gaps.push("standard-run-none"); }
  else if (run.unreadable) { row.standard_run = { state: "unreadable", reason: run.unreadable }; gaps.push("standard-run-unreadable"); }
  else {
    const red = RED_CONCLUSIONS.has(run.conclusion);
    row.standard_run = { state: red ? "red" : run.conclusion === "success" ? "green" : "other", ...run };
    if (red) findings.push("standard-run-red");
  }

  row.fleet = fleet;
  row.findings = findings;
  row.gaps = gaps;
  return row;
}

/** The denominator: enumeration must equal what the org says it has. Exact, not a floor. */
export function assertDenominator({ enumerated, publicRepos }) {
  if (!Number.isInteger(publicRepos)) return { ok: false, reason: `/orgs/${ORG} reported no integer public_repos (${String(publicRepos)})` };
  if (enumerated !== publicRepos) {
    return { ok: false, reason: `enumerated ${enumerated} public repos but /orgs/${ORG} reports ${publicRepos} — a short page or a scope gap, and this run is NOT evidence about the fleet` };
  }
  return { ok: true };
}

export function summarize(rows) {
  const t = {
    rows: rows.length,
    caller: { present: 0, absent: 0, unreadable: 0 },
    pinned: 0,
    test_lane: { present: 0, absent: 0, "n/a": 0, unmeasured: 0 },
    standard_run: { green: 0, red: 0, other: 0, none: 0, unreadable: 0 },
    runtime_mismatch: 0,
    extra_workflows: 0,
    with_findings: 0,
    findings: 0,
    gaps: 0,
  };
  for (const r of rows) {
    t.caller[r.caller.state]++;
    if (r.caller.state === "present" && r.caller.pinned) t.pinned++;
    t.test_lane[r.test_lane]++;
    if (r.standard_run) t.standard_run[r.standard_run.state]++;
    if (r.runtime && r.runtime.match === false) t.runtime_mismatch++;
    t.extra_workflows += r.extra ? r.extra.length : 0;
    if (r.findings.length) t.with_findings++;
    t.findings += r.findings.length;
    t.gaps += r.gaps.length;
  }
  return t;
}

/** Rows with findings first (most first), then by name — the worst repo is the first row a reader sees. */
export function orderRows(rows) {
  return [...rows].sort((a, b) => b.findings.length - a.findings.length || a.repo.localeCompare(b.repo));
}

export function buildSnapshot({ now, rows, denominator, fleet, standard, strict }) {
  const ordered = orderRows(rows);
  return {
    generated_at: now,
    feed: FEED_NAME,
    org: ORG,
    visibility: "public repos only — the enumeration is type=public, so no private repository is read or named",
    strict: Boolean(strict),
    standard,
    denominator,
    fleet,
    totals: summarize(ordered),
    repos: ordered,
  };
}

/** The step summary — public numbers only, which is every number here. */
export function renderSummary(snap, limit = 25) {
  const t = snap.totals;
  const lines = [];
  lines.push(`## repo-standard conformance — ${snap.generated_at}${snap.strict ? " (strict)" : " (report-only)"}`);
  lines.push("");
  lines.push(`Denominator: ${snap.denominator.enumerated} public repos (${snap.denominator.archived} archived, excluded) — verified against /orgs/${snap.org}: ${snap.denominator.verified ? "yes" : "NO"}.`);
  const s = snap.standard?.selftest;
  lines.push(`Standard: ${snap.standard?.head_sha ? snap.standard.head_sha.slice(0, 12) : "?"} on main; selftest ${s ? (s.state === "unreadable" ? `unreadable (${s.reason})` : `${s.conclusion} — ${s.url}`) : "not measured"}.`);
  if (snap.fleet?.generated_at) lines.push(`Fleet feed: ${snap.fleet.repos_observed}/${snap.fleet.repos_known} observed, coverage_complete=${snap.fleet.coverage_complete}, generated ${snap.fleet.generated_at}.`);
  else lines.push(`Fleet feed: unavailable (${snap.fleet?.unavailable ?? "?"}) — rows carry no fleet join this run.`);
  lines.push("");
  lines.push("| | count |");
  lines.push("|---|---:|");
  lines.push(`| rows | ${t.rows} |`);
  lines.push(`| caller present / absent / unreadable | ${t.caller.present} / ${t.caller.absent} / ${t.caller.unreadable} |`);
  lines.push(`| pinned to a SHA | ${t.pinned} |`);
  lines.push(`| test lane present / absent / n/a / unmeasured | ${t.test_lane.present} / ${t.test_lane.absent} / ${t.test_lane["n/a"]} / ${t.test_lane.unmeasured} |`);
  lines.push(`| standard run green / red / other / none / unreadable | ${t.standard_run.green} / ${t.standard_run.red} / ${t.standard_run.other} / ${t.standard_run.none} / ${t.standard_run.unreadable} |`);
  lines.push(`| runtime mismatch (reported) | ${t.runtime_mismatch} |`);
  lines.push(`| repo-specific workflows (reported) | ${t.extra_workflows} |`);
  lines.push(`| repos with findings | ${t.with_findings} (${t.findings} findings) |`);
  lines.push(`| measurement gaps | ${t.gaps} |`);
  lines.push("");
  const bad = snap.repos.filter((r) => r.findings.length);
  if (bad.length) {
    lines.push(`### Findings (${Math.min(bad.length, limit)} of ${bad.length})`);
    lines.push("");
    lines.push("| repo | findings | extra workflows |");
    lines.push("|---|---|---|");
    for (const r of bad.slice(0, limit)) lines.push(`| ${r.repo} | ${r.findings.join(", ")} | ${(r.extra || []).map((e) => e.path.split("/").pop()).join(", ")} |`);
    lines.push("");
  }
  const gapped = snap.repos.filter((r) => r.gaps.length);
  if (gapped.length) {
    lines.push(`### Measurement gaps (${gapped.length} repos) — limits of this lane, not defects of the repo`);
    lines.push("");
    for (const r of gapped.slice(0, limit)) lines.push(`- ${r.repo}: ${r.gaps.join(", ")}`);
    lines.push("");
  }
  return lines.join("\n");
}

// ── the sweep ────────────────────────────────────────────────────────────────

const RAW = "https://raw.githubusercontent.com";

function ghHeaders(token) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
    "user-agent": FEED_NAME,
  };
}

/** GET one API path. Returns {status, body} — never throws on HTTP status, so callers name the state. */
async function api(fetchImpl, token, path) {
  const res = await fetchImpl(`https://api.github.com${path}`, { headers: ghHeaders(token) });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body, link: res.headers.get("link") || "" };
}

/** Follow Link: rel="next" over a list endpoint. */
async function apiPaginated(fetchImpl, token, path) {
  const out = [];
  let url = `https://api.github.com${path}`;
  for (let page = 0; page < 50 && url; page++) {
    const res = await fetchImpl(url, { headers: ghHeaders(token) });
    if (res.status !== 200) throw new Error(`GET ${url} answered ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body)) throw new Error(`GET ${url} did not answer a list`);
    out.push(...body);
    const m = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") || "");
    url = m ? m[1] : null;
  }
  return out;
}

/** Parse workflow YAML. Bun's parser; injected so the classifier's tests can run anywhere. */
export function parseYaml(text) {
  if (typeof Bun === "undefined" || !Bun.YAML) throw new Error("parseYaml needs Bun.YAML (run under bun)");
  return Bun.YAML.parse(text);
}

async function fetchRepo({ fetchImpl, token, name, defaultBranch, parse, log }) {
  const full = `${ORG}/${name}`;
  const [wfList, rootList, props] = await Promise.all([
    api(fetchImpl, token, `/repos/${full}/contents/.github/workflows?ref=${encodeURIComponent(defaultBranch)}`),
    api(fetchImpl, token, `/repos/${full}/contents/?ref=${encodeURIComponent(defaultBranch)}`),
    api(fetchImpl, token, `/repos/${full}/properties/values`),
  ]);

  let files = null;
  let filesError = null;
  if (wfList.status === 404) files = [];
  else if (wfList.status !== 200 || !Array.isArray(wfList.body)) filesError = `${wfList.status}`;
  else {
    const entries = wfList.body.filter((e) => e.type === "file" && /\.ya?ml$/.test(e.name));
    files = await Promise.all(entries.map(async (e) => {
      // Raw, not the contents API: public bytes, and it does not spend the
      // token's hourly budget on the largest number of calls this sweep makes.
      const res = await fetchImpl(`${RAW}/${full}/${defaultBranch}/${e.path}`);
      if (res.status !== 200) return { path: e.path, doc: null, error: `raw ${res.status}` };
      const text = await res.text();
      try { return { path: e.path, doc: parse(text), error: null }; }
      catch (err) { return { path: e.path, doc: null, error: `parse: ${err.message}` }; }
    }));
  }

  let root = null;
  let rootError = null;
  if (rootList.status === 200 && Array.isArray(rootList.body)) root = rootList.body.map((e) => e.name);
  else rootError = `${rootList.status}`;

  let tier = null;
  if (props.status === 200 && Array.isArray(props.body)) {
    const p = props.body.find((x) => x.property_name === "tier");
    tier = p && typeof p.value === "string" ? p.value : null;
  }

  // The caller's own latest completed run on the default branch. This is the
  // one call whose permission is UNVERIFIED for another public repo under
  // GITHUB_TOKEN (#381); a 403 lands in the row as a measurement gap and the
  // first scheduled run is what measures it.
  let run = null;
  const caller = files ? findCaller(files, defaultBranch) : { state: "unreadable" };
  if (caller.state === "present") {
    const base = caller.path.split("/").pop();
    const r = await api(fetchImpl, token, `/repos/${full}/actions/workflows/${encodeURIComponent(base)}/runs?branch=${encodeURIComponent(defaultBranch)}&status=completed&per_page=1&exclude_pull_requests=true`);
    if (r.status === 200 && Array.isArray(r.body?.workflow_runs)) {
      const w = r.body.workflow_runs[0];
      run = w ? { conclusion: w.conclusion, url: w.html_url, sha: w.head_sha, at: w.updated_at, event: w.event } : null;
    } else run = { unreadable: `${r.status}` };
  }

  log(`  ${full}: caller ${caller.state}${files ? ` (${files.length} workflows)` : ""}`);
  return { name, files, filesError, root, rootError, run, tier };
}

export async function fetchFleet(fetchImpl) {
  try {
    const res = await fetchImpl(FLEET_FEED);
    if (res.status !== 200) return { source: FLEET_FEED, unavailable: `HTTP ${res.status}` };
    const body = await res.json();
    if (!body || typeof body.generated_at !== "string" || Number.isNaN(Date.parse(body.generated_at)) || !Number.isInteger(body.repos_known)) {
      return { source: FLEET_FEED, unavailable: "malformed: no parseable generated_at or repos_known" };
    }
    return { source: FLEET_FEED, body };
  } catch (e) {
    return { source: FLEET_FEED, unavailable: e.message };
  }
}

/** The per-repo slice of the fleet feed. */
export function fleetSlice(fleetBody, full) {
  if (!fleetBody) return null;
  const unobserved = Array.isArray(fleetBody.unobserved) && fleetBody.unobserved.includes(full);
  const red = (Array.isArray(fleetBody.red) ? fleetBody.red : []).filter((r) => r.repo === full).map((r) => ({ workflow: r.workflow, conclusion: r.conclusion, since: r.since, run_url: r.run_url }));
  return { unobserved, red };
}

export async function sweep({ fetchImpl = fetch, token, now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), strict = false, headSha = null, parse = parseYaml, log = (s) => console.error(s) } = {}) {
  if (!token) throw new Error("GH_TOKEN is empty — nothing can be enumerated, so there is no snapshot to publish.");

  // 1. the denominator, exact
  const org = await api(fetchImpl, token, `/orgs/${ORG}`);
  const repos = await apiPaginated(fetchImpl, token, `/orgs/${ORG}/repos?type=public&per_page=100`);
  const den = assertDenominator({ enumerated: repos.length, publicRepos: org.body?.public_repos });
  if (!den.ok) throw new Error(`DENOMINATOR: ${den.reason}`);
  const live = repos.filter((r) => !r.archived);
  log(`${repos.length} public repos enumerated (${repos.length - live.length} archived) — verified against /orgs/${ORG}.`);

  // 2. the standard itself
  const selftestRes = await api(fetchImpl, token, `/repos/${STANDARD_REPO}/actions/workflows/${SELFTEST_FILE}/runs?branch=main&status=completed&per_page=1`);
  let selftest;
  if (selftestRes.status === 200 && Array.isArray(selftestRes.body?.workflow_runs)) {
    const w = selftestRes.body.workflow_runs[0];
    selftest = w ? { state: RED_CONCLUSIONS.has(w.conclusion) ? "red" : w.conclusion === "success" ? "green" : "other", conclusion: w.conclusion, url: w.html_url, sha: w.head_sha, at: w.updated_at } : { state: "none" };
  } else selftest = { state: "unreadable", reason: `${selftestRes.status}` };
  const standard = { repo: STANDARD_REPO, path: STANDARD_PATH, head_sha: headSha, selftest };

  // 3. the fleet feed
  const fleet = await fetchFleet(fetchImpl);
  const fleetBody = fleet.body || null;
  const fleetBlock = fleetBody
    ? { source: FLEET_FEED, generated_at: fleetBody.generated_at, repos_known: fleetBody.repos_known, repos_observed: fleetBody.repos_observed ?? null, coverage_complete: fleetBody.coverage_complete ?? null, unobserved: Array.isArray(fleetBody.unobserved) ? fleetBody.unobserved : [] }
    : { source: FLEET_FEED, unavailable: fleet.unavailable };

  // 4. the rows — a few repos at a time; the budget is the token's hourly limit, not wall clock
  const rows = [];
  const queue = [...live];
  const workers = Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const r = queue.shift();
      const got = await fetchRepo({ fetchImpl, token, name: r.name, defaultBranch: r.default_branch || "main", parse, log });
      rows.push(classifyRepo({ repo: r.name, archived: false, defaultBranch: r.default_branch || "main", ...got, fleet: fleetSlice(fleetBody, `${ORG}/${r.name}`), headSha }));
    }
  });
  await Promise.all(workers);

  const readable = rows.filter((r) => r.workflows.read).length;
  if (rows.length && readable === 0) throw new Error(`every one of ${rows.length} repos was unreadable — the credential, not the fleet, is what this run measured. No snapshot.`);

  return buildSnapshot({
    now,
    rows,
    denominator: { public_repos: org.body.public_repos, enumerated: repos.length, verified: true, archived: repos.length - live.length, rows: rows.length },
    fleet: fleetBlock,
    standard,
    strict,
  });
}

// ── CLI ──────────────────────────────────────────────────────────────────────
//   bun scripts/repo-standard-conformance.mjs [--out FILE] [--summary FILE] [--strict]
// Exit 0: snapshot written. Exit 2: the lane could not measure (no token, short
// denominator, nothing readable) — no snapshot, by design. `--strict` does NOT
// change the exit code here: the workflow's verdict step reads totals.findings
// so the snapshot publishes before the verdict reds.
async function main(argv) {
  const opt = { out: null, summary: process.env.GITHUB_STEP_SUMMARY || null, strict: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") opt.out = argv[++i];
    else if (argv[i] === "--summary") opt.summary = argv[++i];
    else if (argv[i] === "--strict") opt.strict = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  const snap = await sweep({ token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "", strict: opt.strict, headSha: process.env.GITHUB_SHA || null });
  const json = JSON.stringify(snap, null, 2) + "\n";
  if (opt.out) await Bun.write(opt.out, json); else process.stdout.write(json);
  const md = renderSummary(snap);
  if (opt.summary) await Bun.write(opt.summary, (await Bun.file(opt.summary).exists() ? await Bun.file(opt.summary).text() : "") + md + "\n");
  console.error(md);
}

if (typeof Bun !== "undefined" && Bun.main === import.meta.path) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`::error title=repo-standard conformance did NOT run::${e.message}`);
    process.exit(2);
  });
}
