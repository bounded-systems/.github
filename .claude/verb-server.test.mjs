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

import { renderTranscript, READ_CHAT_TOOL } from "./verb-server.mjs";

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
function rpc(messages, { expect, chatFetch }) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [SERVER], {
      env: { ...process.env, CHAT_FETCH_BIN: chatFetch },
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
    assert.equal(list.result.tools.length, 1);
    assert.equal(list.result.tools[0].name, "read_chat");
    assert.match(list.result.tools[0].description, /share/i);
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
  const text = renderTranscript(GRAPH);
  assert.match(text, /2 turns/);
  assert.doesNotMatch(text, /conversation\.event/);
  assert.equal((text.match(/## /g) || []).length, 2); // two turns (header is a single #)
});

test("the tool schema requires share_url and bounds mode", () => {
  assert.deepEqual(READ_CHAT_TOOL.inputSchema.required, ["share_url"]);
  assert.deepEqual(READ_CHAT_TOOL.inputSchema.properties.mode.enum, ["transcript", "graph"]);
});
