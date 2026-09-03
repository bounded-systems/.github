// Tests for verb-server.mjs (#326) — the org-verbs MCP server.
//
// Two layers: a real spawn-based JSON-RPC handshake over stdio (initialize →
// tools/list → tools/call, the way Claude Code drives it), with chat-fetch
// stubbed via CHAT_FETCH_BIN so no network is touched; plus imported-unit tests
// of the pure transcript renderer. The load-bearing cases are the ones a
// refactor could silently break: the tool appears in tools/list with a
// share-link description, a successful call renders turns, and a chat-fetch
// FAILURE surfaces verbatim (that refusal is the discoverability teach).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  renderTranscript,
  turnsOf,
  page,
  resolveSession,
  sessionSource,
  sessionLabel,
  READ_CHAT_TOOL,
  READ_SESSION_TOOL,
  DEFAULT_LIMIT,
  requestedWindow,
  GRAPH_WINDOW_REFUSAL,
  DEFAULTED_PAGE_OPTS,
} from "./verb-server.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "verb-server.mjs");

const GRAPH = {
  graph: { id: "path-claude-chat-abc" },
  paths: [
    {
      path: { id: "path-claude-chat-abc" },
      steps: [
        { step: { id: "chat-meta" }, change: { "claude-chat://x": { structural: { type: "conversation.event" } } } },
        { step: { id: "1" }, change: { "claude-chat://x": { structural: { role: "user", text: "hello there" } } } },
        { step: { id: "2" }, change: { "claude-chat://x": { structural: { role: "assistant", text: "hi back" } } } },
      ],
    },
  ],
};

/** A stub standing in for chat-fetch.sh. With --json it echoes GRAPH; a
 *  configured failure prints a refusal to stderr and exits non-zero. */
function stubDir({ fail = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "verb-server-"));
  const body = fail
    ? `echo "chat-fetch: no relay bearer. Set CLAUDE_RELAY_BEARER ... grant_relay_lease ..." >&2; exit 1`
    : `printf '%s' '${JSON.stringify(GRAPH)}'`;
  writeFileSync(join(dir, "chat-fetch.sh"), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(join(dir, "chat-fetch.sh"), 0o755);
  return dir;
}

/** Drive the server over stdio: send each message as one line, collect the
 *  id-bearing responses, resolve once we've seen `expect` of them. */
function rpc(messages, { expect, chatFetch, env = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [SERVER], {
      env: { ...process.env, CHAT_FETCH_BIN: chatFetch, ...env },
      stdio: ["pipe", "pipe", "inherit"],
    });
    const out = [];
    let buf = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timeout: got ${out.length}/${expect} responses`));
    }, 10000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) out.push(JSON.parse(line));
        if (out.length >= expect) {
          clearTimeout(timer);
          child.stdin.end();
          child.kill();
          resolve(out);
        }
      }
    });
    child.on("error", reject);
    for (const m of messages) child.stdin.write(JSON.stringify(m) + "\n");
  });
}

test("initialize handshake reports the tools capability and server name", async () => {
  const dir = stubDir();
  try {
    const [init] = await rpc(
      [{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }],
      { expect: 1, chatFetch: join(dir, "chat-fetch.sh") },
    );
    assert.equal(init.id, 1);
    assert.equal(init.result.protocolVersion, "2025-06-18"); // echoes the client's version
    assert.ok(init.result.capabilities.tools);
    assert.equal(init.result.serverInfo.name, "bounded-verbs");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tools/list advertises read_chat, and a notification draws no response", async () => {
  const dir = stubDir();
  try {
    const res = await rpc(
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        { jsonrpc: "2.0", method: "notifications/initialized" }, // no id → no reply
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
      ],
      { expect: 2, chatFetch: join(dir, "chat-fetch.sh") },
    );
    const list = res.find((m) => m.id === 2);
    assert.deepEqual(list.result.tools.map((x) => x.name).sort(), ["read_chat", "read_session"]);
    assert.match(list.result.tools.find((x) => x.name === "read_chat").description, /share/i);
    assert.match(list.result.tools.find((x) => x.name === "read_session").description, /own transcript|current session/i);
    // the notification produced nothing: exactly two id-bearing responses
    assert.equal(res.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tools/call read_chat renders the transcript from the stubbed graph", async () => {
  const dir = stubDir();
  try {
    const res = await rpc(
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_chat", arguments: { share_url: "https://claude.ai/share/x" } } },
      ],
      { expect: 2, chatFetch: join(dir, "chat-fetch.sh") },
    );
    const call = res.find((m) => m.id === 2);
    assert.ok(!call.result.isError);
    const text = call.result.content[0].text;
    assert.match(text, /## user\n\nhello there/);
    assert.match(text, /## assistant\n\nhi back/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("graph mode returns the raw JSON, not a rendering", async () => {
  const dir = stubDir();
  try {
    const res = await rpc(
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_chat", arguments: { share_url: "https://claude.ai/share/x", mode: "graph" } } },
      ],
      { expect: 2, chatFetch: join(dir, "chat-fetch.sh") },
    );
    const call = res.find((m) => m.id === 2);
    assert.equal(JSON.parse(call.result.content[0].text).graph.id, "path-claude-chat-abc");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a chat-fetch failure surfaces verbatim as an isError result (the teach)", async () => {
  const dir = stubDir({ fail: true });
  try {
    const res = await rpc(
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_chat", arguments: { share_url: "https://claude.ai/share/x" } } },
      ],
      { expect: 2, chatFetch: join(dir, "chat-fetch.sh") },
    );
    const call = res.find((m) => m.id === 2);
    assert.equal(call.result.isError, true);
    assert.match(call.result.content[0].text, /grant_relay_lease/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unknown tool is a JSON-RPC error, not a crash", async () => {
  const dir = stubDir();
  try {
    const res = await rpc(
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "delete_everything", arguments: {} } },
      ],
      { expect: 2, chatFetch: join(dir, "chat-fetch.sh") },
    );
    const call = res.find((m) => m.id === 2);
    assert.equal(call.error.code, -32602);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── pure unit: the renderer, imported directly ───────────────────────────────

test("renderTranscript skips the meta step and empty turns", () => {
  const text = renderTranscript(GRAPH, {});
  assert.match(text, /turns 1–2 of 2/);
  assert.doesNotMatch(text, /conversation\.event/);
  assert.equal((text.match(/## /g) || []).length, 2); // two turns (header is a single #)
});

test("the tool schema requires share_url and bounds mode", () => {
  assert.deepEqual(READ_CHAT_TOOL.inputSchema.required, ["share_url"]);
  assert.deepEqual(READ_CHAT_TOOL.inputSchema.properties.mode.enum, ["transcript", "graph"]);
});

// ── pagination (#330) — the defect dogfooding found: a real chat overflowed ──

const BIG = {
  paths: [
    {
      steps: [
        { step: { id: "chat-meta" }, change: { "s://x": { structural: { type: "conversation.event" } } } },
        ...Array.from({ length: 100 }, (_, i) => ({
          step: { id: String(i) },
          change: { "s://x": { structural: { role: i % 2 ? "assistant" : "user", text: `turn ${i}` } } },
        })),
      ],
    },
  ],
};

test("turnsOf drops non-turn steps and empty text", () => {
  assert.equal(turnsOf(BIG).length, 100);
  assert.equal(turnsOf({ paths: [{ steps: [] }] }).length, 0);
  assert.equal(turnsOf(undefined).length, 0);
});

test("page: positive offset walks forward, negative counts from the end", () => {
  assert.deepEqual(page(100, { limit: 40, offset: 0 }), { start: 0, end: 40, next: 40 });
  assert.deepEqual(page(100, { limit: 40, offset: 80 }), { start: 80, end: 100, next: null });
  assert.deepEqual(page(100, { limit: 40, offset: -40 }), { start: 60, end: 100, next: null });
  // out-of-range and non-integer inputs clamp rather than throw
  assert.deepEqual(page(10, { limit: 40, offset: 999 }), { start: 10, end: 10, next: null });
  assert.deepEqual(page(10, { limit: 999, offset: -999 }), { start: 0, end: 10, next: null });
});

test("a truncated page announces the omitted range and the exact continuation", () => {
  const text = renderTranscript(BIG, { limit: 10, offset: 0 });
  assert.match(text, /turns 1–10 of 100/);
  assert.match(text, /90 more turn\(s\)\. Continue with offset: 10\./);
  assert.match(text, /## user\n\nturn 0/);
  assert.doesNotMatch(text, /turn 10\b/); // 11th turn is not in this page
});

test("the last page says nothing about continuing", () => {
  const text = renderTranscript(BIG, { limit: 10, offset: -10 });
  assert.match(text, /turns 91–100 of 100/);
  assert.doesNotMatch(text, /Continue with offset/);
});

test("one enormous turn is capped so it cannot blow the budget alone", () => {
  const huge = {
    paths: [{ steps: [{ step: { id: "1" }, change: { "s://x": { structural: { role: "user", text: "z".repeat(20000) } } } }] }],
  };
  const text = renderTranscript(huge, {});
  assert.ok(text.length < 8000);
  assert.match(text, /turn truncated — 20000 chars total/);
});

// ── read_session (#328) — the same capability pointed inward ─────────────────

test("resolveSession prefers the argument, falls back to the session env var", () => {
  assert.equal(resolveSession({ session_id: "abc" }, {}), "abc");
  assert.equal(resolveSession({}, { CLAUDE_CODE_SESSION_ID: "env-id" }), "env-id");
  assert.equal(resolveSession({}, {}), null);
});

test("read_session tool: no required args, and it documents the self-read", () => {
  assert.deepEqual(READ_SESSION_TOOL.inputSchema.required, []);
  assert.equal(READ_SESSION_TOOL.inputSchema.properties.limit.default, DEFAULT_LIMIT);
  assert.match(READ_SESSION_TOOL.description, /no relay and no credential/i);
});

test("read_session reads the current session via a stubbed path CLI, newest turns first", async () => {
  const dir = stubDir();
  try {
    // A `path` stub: p list claude --json → one session; p derive → BIG graph.
    writeFileSync(
      join(dir, "path"),
      `#!/usr/bin/env bash
if [ "$2" = "list" ]; then printf '%s' '${JSON.stringify({ sessions: [{ session_id: "sess-1", project_path: "/home/user" }] })}'; exit 0; fi
printf '%s' '${JSON.stringify(BIG)}'
`,
    );
    chmodSync(join(dir, "path"), 0o755);
    const res = await rpc(
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_session", arguments: { limit: 5 } } },
      ],
      { expect: 2, chatFetch: join(dir, "chat-fetch.sh"), env: { PATH_CLI_BIN: join(dir, "path"), CLAUDE_CODE_SESSION_ID: "sess-1" } },
    );
    const call = res.find((m) => m.id === 2);
    assert.ok(!call.result.isError, JSON.stringify(call.result));
    const text = call.result.content[0].text;
    assert.match(text, /Session sess-1/);
    assert.match(text, /turns 96–100 of 100/); // defaults to the most recent turns
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read_session with no id and no env var names the remedy", async () => {
  const dir = stubDir();
  try {
    const res = await rpc(
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_session", arguments: {} } },
      ],
      { expect: 2, chatFetch: join(dir, "chat-fetch.sh"), env: { CLAUDE_CODE_SESSION_ID: "" } },
    );
    const call = res.find((m) => m.id === 2);
    assert.equal(call.result.isError, true);
    assert.match(call.result.content[0].text, /p list claude --json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── whose transcript is this? (.github#343, measured on #337 P5) ─────────────
// A subagent inherits the PARENT's $CLAUDE_CODE_SESSION_ID, so an argument-less
// read returns the parent's history with no error. It cannot be detected here,
// so the header has to say where the id came from. P5: "a subagent that trusts
// read_session will silently read its parent's history believing it is its own."

test("sessionSource distinguishes a chosen session from an inherited one", () => {
  assert.equal(sessionSource({ session_id: "abc" }), "argument");
  assert.equal(sessionSource({}), "env");
  assert.equal(sessionSource({ session_id: "" }), "env");
  assert.equal(sessionSource(undefined), "env");
});

test("an inherited read warns about the subagent case; an explicit one does not", () => {
  const explicit = sessionLabel("f5d05876-dea3-5ae8-af85-4b70ff1a358d", "argument");
  assert.equal(explicit, "Session f5d05876");
  assert.doesNotMatch(explicit, /PARENT/);

  const inherited = sessionLabel("f5d05876-dea3-5ae8-af85-4b70ff1a358d", "env");
  assert.match(inherited, /^Session f5d05876/); // still names it, as before
  assert.match(inherited, /CLAUDE_CODE_SESSION_ID/); // says where it came from
  assert.match(inherited, /PARENT/); // names the failure case
  assert.match(inherited, /pass session_id/); // and the remedy
});

test("the warning survives into the rendered header, which is where a reader sees it", () => {
  const graph = { paths: [{ steps: [{ change: { a: { structural: { role: "user", text: "hi" } } } }] }] };
  const text = renderTranscript(graph, {}, sessionLabel("abcdef1234", "env"));
  assert.match(text, /# Session abcdef12 \(from \$CLAUDE_CODE_SESSION_ID/);
  assert.match(text, /PARENT/);
});

test("the tool description warns before the call, not only after it", () => {
  const d = READ_SESSION_TOOL.inputSchema.properties.session_id.description;
  assert.match(d, /subagent/);
  assert.match(d, /PARENT/);
  // It used to end "Pass it explicitly when you need your own." — measured: there
  // is no such value. A subagent that found its own transcript on disk and passed
  // that agent id got "not found on this machine"; agent ids are not session ids.
  // The schema now says the remedy that exists, because it is text a model acts on.
  assert.match(d, /CANNOT read its own transcript/);
  assert.match(d, /do not resolve/);
  assert.match(d, /subagents\/agent-\*\.jsonl/); // the file to read instead
  assert.match(d, /meta\.json/); // and how to tell which one is yours
  assert.doesNotMatch(d, /Pass it explicitly when you need your own/);
});

test("an unresolvable session names a command that actually enumerates sessions", async () => {
  // The hint was "… --json shows what is" — neither runnable nor English.
  const result = await callTool("read_session", { session_id: "no-such-session" }, { withPath: true });
  assert.equal(result.isError, true);
  const text = result.content[0].text;
  assert.match(text, /not found on this machine/);
  assert.match(text, /p list claude --json$/); // ends with the pasteable command
  assert.doesNotMatch(text, /shows what is/);
});

test("the transcript header says what a turn IS, since the count is otherwise unitless", () => {
  // Measured: 729 turns for a 7,475-line JSONL. Without the unit a reader has to
  // reverse-engineer it from the number.
  const text = renderTranscript(GRAPH, {});
  assert.match(text, /turns 1–2 of 2/);
  assert.match(text, /A turn is one user or assistant message carrying text/);
  assert.match(text, /tool calls, tool results and empty messages are not turns/);
});

// ── graph mode refuses a window rather than ignoring it (#371) ───────────────
// Measured before the fix: `read_chat mode=graph limit=2` returned 314,098
// chars and `read_session mode=graph offset=-2 limit=2` returned 8,011,561 —
// both windows were two turns, both returned everything. renderOrGraph returned
// raw stdout before renderTranscript, the only caller of page(), so offset and
// limit were validated, defaulted, threaded down and dropped.
//
// THE TRAP these tests exist to hold shut: read_session DEFAULTS offset before
// rendering, so "did the caller ask for a window?" cannot be asked of the
// options the renderer sees — every self-read has one by then. The last two
// cases below are the ones that fail if that distinction is ever collapsed.

/** A `path` CLI stub: `p list claude --json` → one session; anything else → a graph. */
function pathStub(dir, graph = BIG) {
  writeFileSync(
    join(dir, "path"),
    `#!/usr/bin/env bash
if [ "$2" = "list" ]; then printf '%s' '${JSON.stringify({ sessions: [{ session_id: "sess-1", project_path: "/home/user" }] })}'; exit 0; fi
printf '%s' '${JSON.stringify(graph)}'
`,
  );
  chmodSync(join(dir, "path"), 0o755);
  return join(dir, "path");
}

const SESSION_ENV = { CLAUDE_CODE_SESSION_ID: "sess-1" };

/** One tools/call, with chat-fetch (and optionally `path`) stubbed. */
async function callTool(name, args, { fail = false, withPath = false } = {}) {
  const dir = stubDir({ fail });
  try {
    const env = withPath ? { PATH_CLI_BIN: pathStub(dir), ...SESSION_ENV } : {};
    const res = await rpc(
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } },
      ],
      { expect: 2, chatFetch: join(dir, "chat-fetch.sh"), env },
    );
    return res.find((m) => m.id === 2).result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("requestedWindow answers from the caller's original arguments only", () => {
  assert.equal(requestedWindow(undefined), false);
  assert.equal(requestedWindow({}), false);
  assert.equal(requestedWindow({ mode: "graph" }), false);
  assert.equal(requestedWindow({ limit: 2 }), true);
  assert.equal(requestedWindow({ offset: 0 }), true); // offset 0 is still a request
  assert.equal(requestedWindow({ offset: -2, limit: 2 }), true);
});

test("requestedWindow throws on a defaulted copy rather than answering it", () => {
  // The guard that makes the read_session default impossible to mistake for a
  // caller-supplied window if the two objects are ever collapsed.
  assert.throws(() => requestedWindow({ offset: -40, [DEFAULTED_PAGE_OPTS]: true }), /original arguments/);
});

test("read_chat graph mode refuses an explicit window and names the remedy", async () => {
  const result = await callTool("read_chat", { share_url: "https://claude.ai/share/x", mode: "graph", limit: 2 });
  assert.equal(result.isError, true);
  const text = result.content[0].text;
  assert.equal(text, GRAPH_WINDOW_REFUSAL);
  assert.match(text, /whole-session by design/); // why
  assert.match(text, /mode: "transcript"/); // what to do instead
  assert.doesNotMatch(text, /path-claude-chat-abc/); // and no 8MB payload
});

test("read_session graph mode refuses the window the issue measured", async () => {
  const result = await callTool("read_session", { mode: "graph", offset: -2, limit: 2 }, { withPath: true });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, GRAPH_WINDOW_REFUSAL);
});

test("read_chat graph mode with no window still returns the whole Graph", async () => {
  const result = await callTool("read_chat", { share_url: "https://claude.ai/share/x", mode: "graph" });
  assert.ok(!result.isError, JSON.stringify(result));
  assert.equal(JSON.parse(result.content[0].text).graph.id, "path-claude-chat-abc");
});

test("THE TRAP: an argument-less read_session graph self-read is NOT a windowed request", async () => {
  // read_session fills offset in for this exact call. A refusal that asked the
  // renderer's options instead of the caller's arguments would reject it — the
  // commonest graph call there is, and one that passed no window at all.
  const result = await callTool("read_session", { mode: "graph" }, { withPath: true });
  assert.ok(!result.isError, JSON.stringify(result));
  assert.equal(turnsOf(JSON.parse(result.content[0].text)).length, 100);
});

test("transcript mode is unaffected: windows are still honoured, both verbs", async () => {
  const chat = await callTool("read_chat", { share_url: "https://claude.ai/share/x", limit: 1, offset: 0 });
  assert.ok(!chat.isError);
  assert.match(chat.content[0].text, /turns 1–1 of 2/);

  const session = await callTool("read_session", { limit: 5, offset: 0 }, { withPath: true });
  assert.ok(!session.isError, JSON.stringify(session));
  assert.match(session.content[0].text, /turns 1–5 of 100/);

  const bare = await callTool("read_session", {}, { withPath: true });
  assert.ok(!bare.isError, JSON.stringify(bare));
  assert.match(bare.content[0].text, /turns 61–100 of 100/); // still defaults to the newest turns
});

test("the mode schema warns that graph refuses a window, before the call", () => {
  assert.match(READ_SESSION_TOOL.inputSchema.properties.mode.description, /REFUSES/);
  assert.match(READ_CHAT_TOOL.inputSchema.properties.mode.description, /transcript for a window/);
});
