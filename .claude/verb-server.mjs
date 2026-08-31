#!/usr/bin/env node
/**
 * bounded-verbs — the org's session-verb MCP server (.github#326).
 *
 * WHY A TOOL, NOT A SCRIPT. Every other discoverability channel (the injected
 * context bullet, the handoff doc, CLAUDE.md) still makes a session FIND the
 * capability — and a blind agent that cannot find it reaches for vendor-API
 * evasion instead (measured 2026-08-31: a blind agent invented a Cloudflare
 * bot-gate bypass rather than discover chat-fetch.sh). A registered MCP tool
 * needs no finding: it sits in the tool list with its own description, so the
 * model just calls it. register-mcp.mjs (installed by boot.sh) promotes this
 * repo's .mcp.json to user scope — absolute paths, no approval prompt, any cwd.
 *
 * WHAT IT IS. A thin JSON-RPC-2.0-over-stdio adapter (the MCP stdio transport:
 * one JSON object per line, no embedded newlines) over the ALREADY-AUDITED
 * `chat-fetch.sh --json`. Every security property of that script — bearer off
 * argv, full-match URL validation, the grant-path refusal sentence (#318) —
 * is inherited rather than re-implemented; this file adds protocol and a
 * dependency-free transcript renderer, never authority or a second transport.
 * No `path` binary and no node-fetch/proxy dance: curl inside chat-fetch is the
 * one proven egress path in these environments.
 *
 * GROWTH. read_chat is verb one. archive_chat (claim-mode door upload) and
 * board reads join THIS server rather than spawning parallel rooms — one
 * org-verbs room, one registration path.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// Overridable for tests; in production it is the audited script beside us.
const CHAT_FETCH = process.env.CHAT_FETCH_BIN || join(HERE, "chat-fetch.sh");

const READ_CHAT_TOOL = {
  name: "read_chat",
  description:
    "Read a shared Claude chat (a claude.ai/share/<uuid> link) and return its transcript. " +
    "Use this for ANY claude.ai share link — do NOT fetch the share page or the vendor " +
    "snapshot API (client-rendered SPA shell; Cloudflare bot-gated; proxy-blocked). This " +
    "routes through the org relay, which reads only PUBLIC shares and holds no vendor " +
    "credential. If no relay bearer is configured the tool returns how to grant one.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      share_url: {
        type: "string",
        description: "A https://claude.ai/share/<uuid> link.",
      },
      mode: {
        type: "string",
        enum: ["transcript", "graph"],
        default: "transcript",
        description:
          "transcript (default): readable role/text turns. graph: the raw toolpath Graph JSON.",
      },
    },
    required: ["share_url"],
  },
};

/** Render a toolpath Graph into a readable transcript — dependency-free, so the
 *  server never needs the `path` binary. Mirrors the converter's shape: one
 *  path, a leading metadata step (no role), then role/text turns. */
function renderTranscript(graph) {
  const steps = graph?.paths?.[0]?.steps ?? [];
  const lines = [`# Shared chat — ${Math.max(0, steps.length - 1)} turns\n`];
  for (const s of steps) {
    const change = s?.change ?? {};
    const src = Object.keys(change)[0];
    const st = src ? change[src]?.structural : undefined;
    if (!st || !st.role) continue; // skip the chat-meta step
    const text = typeof st.text === "string" ? st.text.trim() : "";
    if (!text) continue;
    lines.push(`\n## ${st.role}\n\n${text}`);
  }
  return lines.join("\n");
}

function readChat(args) {
  const shareUrl = args?.share_url;
  if (typeof shareUrl !== "string" || shareUrl.length === 0) {
    return { content: [{ type: "text", text: "read_chat requires a share_url string" }], isError: true };
  }
  const mode = args?.mode === "graph" ? "graph" : "transcript";

  // The audited script does the fetch, the bearer handling, the URL validation
  // and the refusal messaging. We only ever ask it for --json (the branch that
  // needs no `path` binary) and render locally.
  const res = spawnSync("bash", [CHAT_FETCH, shareUrl, "--json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) {
    // chat-fetch already names the remedy (grant path, withdrawn share, etc.);
    // surface it verbatim so the tool teaches exactly as the script does.
    const msg = (res.stderr || res.stdout || "chat-fetch failed with no output").trim();
    return { content: [{ type: "text", text: msg }], isError: true };
  }
  if (mode === "graph") {
    return { content: [{ type: "text", text: res.stdout.trim() }] };
  }
  let graph;
  try {
    graph = JSON.parse(res.stdout);
  } catch {
    return { content: [{ type: "text", text: "relay returned non-JSON; try mode: \"graph\"" }], isError: true };
  }
  return { content: [{ type: "text", text: renderTranscript(graph) }] };
}

// ── JSON-RPC 2.0 over stdio (the MCP stdio transport) ────────────────────────

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function handle(req) {
  const { id, method, params } = req;
  const isRequest = id !== undefined && id !== null;
  switch (method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id,
        result: {
          // Echo the client's version when it names one — forward-compatible
          // without pinning us to a version the client may not speak.
          protocolVersion: params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "bounded-verbs", version: "0.1.0" },
        },
      });
      return;
    case "notifications/initialized":
    case "initialized":
      return; // notification — no response
    case "ping":
      if (isRequest) send({ jsonrpc: "2.0", id, result: {} });
      return;
    case "tools/list":
      if (isRequest) send({ jsonrpc: "2.0", id, result: { tools: [READ_CHAT_TOOL] } });
      return;
    case "tools/call": {
      if (!isRequest) return;
      const { name, arguments: toolArgs } = params ?? {};
      if (name !== "read_chat") {
        send({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool: ${name}` } });
        return;
      }
      send({ jsonrpc: "2.0", id, result: readChat(toolArgs ?? {}) });
      return;
    }
    default:
      // Unknown request → method-not-found; unknown notification → ignore.
      if (isRequest) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

function serve() {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let req;
      try {
        req = JSON.parse(line);
      } catch {
        continue; // a malformed line is not a framed message; drop it
      }
      try {
        handle(req);
      } catch (e) {
        if (req && req.id !== undefined && req.id !== null) {
          send({ jsonrpc: "2.0", id: req.id, error: { code: -32603, message: String(e?.message ?? e) } });
        }
      }
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

// Wire stdin only when run as the entrypoint — so a unit test can import the
// pure functions below without the read loop attaching and hanging its process.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) serve();

export { READ_CHAT_TOOL, renderTranscript, readChat, handle, serve };
