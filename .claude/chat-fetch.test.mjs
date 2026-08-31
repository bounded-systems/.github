// Tests for chat-fetch.sh (#313) — the session-side consumer of the
// bounded.tools Claude chat relay.
//
// Stubbed `curl` and `path` binaries on PATH, not a live relay: what this suite
// pins is the script's own contract — argument grammar, bearer resolution and
// its refusal sentence, the exact request it builds, which mode invokes which
// `path` verb, and that a relay refusal surfaces the relay's body verbatim.
// The relay's behaviour has its own suite in bounded.tools.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "chat-fetch.sh");
const SHARE = "https://claude.ai/share/2d5c237b-1428-4022-9a75-b4346fcaf006";

// Each fixture gets its own bin dir and HOME, so bearer files and stub logs
// never leak between cases — the same hermetic posture as the Stop hook suite.
function fixture({ curlStatus = "200", curlBody = '{"graph":{"id":"g"}}' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "chat-fetch-"));
  writeFileSync(
    join(dir, "curl"),
    `#!/usr/bin/env bash
printf '%s\\n' "$@" > "${dir}/curl.args"
cat > "${dir}/curl.stdin" || true
out=""
while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done
printf '%s' '${curlBody}' > "$out"
printf '${curlStatus}'
`,
  );
  writeFileSync(
    join(dir, "path"),
    `#!/usr/bin/env bash
printf '%s\\n' "$@" > "${dir}/path.args"
echo "path-stub-ran"
`,
  );
  chmodSync(join(dir, "curl"), 0o755);
  chmodSync(join(dir, "path"), 0o755);
  return dir;
}

function run(dir, args, env = {}) {
  try {
    const stdout = execFileSync("bash", [SCRIPT, ...args], {
      encoding: "utf8",
      env: {
        PATH: `${dir}:/usr/bin:/bin`,
        HOME: dir,
        CHAT_RELAY_URL: "https://relay.test/claude/sessions",
        ...env,
      },
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return { code: e.status ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

test("no bearer refuses with the sentence that names the grant path", () => {
  const dir = fixture();
  try {
    const r = run(dir, [SHARE]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /grant_relay_lease/);
    assert.match(r.stderr, /CLAUDE_RELAY_BEARER/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("non-share URLs and unknown flags refuse before any network round-trip", () => {
  const dir = fixture();
  try {
    for (const args of [
      ["https://evil.example/share/x"],
      [SHARE, "--frobnicate"],
      [],
      [`${SHARE}", "claim": {"repo": "x`], // JSON-injection shape — full-match regex refuses it (#318)
      ["https://claude.ai/share/not-a-uuid"],
      [SHARE, "--json", "surplus"], // surplus args refuse like a bad flag (#318)
    ]) {
      const r = run(dir, args, { CLAUDE_RELAY_BEARER: "tok" });
      assert.notEqual(r.code, 0, JSON.stringify(args));
    }
    assert.throws(() => readFileSync(join(dir, "curl.args")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("default mode POSTs the share link with the bearer and renders via `path p render md`", () => {
  const dir = fixture();
  try {
    const r = run(dir, [SHARE], { CLAUDE_RELAY_BEARER: "tok-from-env" });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /path-stub-ran/);
    const curlArgs = readFileSync(join(dir, "curl.args"), "utf8");
    assert.match(curlArgs, /https:\/\/relay\.test\/claude\/sessions/);
    assert.doesNotMatch(curlArgs, /tok-from-env/); // the bearer must never ride argv (#318)
    assert.match(readFileSync(join(dir, "curl.stdin"), "utf8"), /authorization: Bearer tok-from-env/);
    assert.match(curlArgs, new RegExp(`"share_url":"${SHARE.replaceAll("/", "\\/")}"`));
    const pathArgs = readFileSync(join(dir, "path.args"), "utf8").split("\n");
    assert.deepEqual(pathArgs.slice(0, 4), ["p", "render", "md", "--input"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the bearer file is the fallback, and --incept forwards the project dir", () => {
  const dir = fixture();
  try {
    writeFileSync(join(dir, ".relay-lease-bearer"), "tok-from-file");
    const r = run(dir, [SHARE, "--incept", "/work/proj"]);
    assert.equal(r.code, 0);
    assert.doesNotMatch(readFileSync(join(dir, "curl.args"), "utf8"), /tok-from-file/);
    assert.match(readFileSync(join(dir, "curl.stdin"), "utf8"), /Bearer tok-from-file/);
    const pathArgs = readFileSync(join(dir, "path.args"), "utf8").split("\n");
    assert.deepEqual(pathArgs.slice(0, 3), ["p", "incept", "claude"]);
    assert.ok(pathArgs.includes("--project") && pathArgs.includes("/work/proj"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--json emits the raw graph and never needs `path`", () => {
  const dir = fixture();
  try {
    rmSync(join(dir, "path")); // no `path` binary at all — --json must still work
    const r = run(dir, [SHARE, "--json"], { CLAUDE_RELAY_BEARER: "tok" });
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), '{"graph":{"id":"g"}}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a relay refusal surfaces the relay's own sentence, verbatim, on stderr", () => {
  const dir = fixture({ curlStatus: "404", curlBody: "snapshot not found — the chat is not (or no longer) shared" });
  try {
    const r = run(dir, [SHARE], { CLAUDE_RELAY_BEARER: "tok" });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /HTTP 404/);
    assert.match(r.stderr, /no longer\) shared/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
