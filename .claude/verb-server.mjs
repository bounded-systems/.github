#!/usr/bin/env node
/**
 * bounded-verbs — the org's session-verb MCP server (#326, #328, #330).
 *
 * WHY TOOLS, NOT SCRIPTS. Every other discoverability channel (the injected
 * context bullet, the handoff doc, CLAUDE.md) still makes a session FIND the
 * capability — and a blind agent that cannot find it reaches for vendor-API
 * evasion instead (measured 2026-08-31: a blind agent invented a Cloudflare
 * bot-gate bypass rather than discover chat-fetch.sh). A registered MCP tool
 * needs no finding: it sits in the tool list, so the model just calls it.
 * register-mcp.mjs (installed by boot.sh) promotes this repo's .mcp.json to
 * user scope — absolute paths, no approval prompt, any cwd.
 *
 * THE TWO VERBS ARE ONE CAPABILITY, POINTED OUT AND IN:
 *   read_chat    — someone's SHARED chat, via the bounded.tools relay.
 *   read_session — YOUR OWN (or a named local) Claude Code session, via the
 *                  `path` CLI reading ~/.claude/projects. No relay, no bearer:
 *                  a local read. This is what makes a session self-aware — it
 *                  can ask what it has already done rather than trusting a
 *                  context window that may have been summarized away.
 *
 * WHAT IT IS. A thin JSON-RPC-2.0-over-stdio adapter (the MCP stdio transport:
 * one JSON object per line) over already-audited tools: `chat-fetch.sh --json`
 * for read_chat — inheriting its bearer handling, URL validation and refusal
 * sentences (#318) rather than re-implementing them — and `path p derive
 * claude` for read_session. This file adds protocol, pagination and rendering;
 * never authority, never a second transport.
 *
 * PAGINATION IS NOT OPTIONAL (#330). Dogfooding found a 112-turn chat renders
 * to 88KB and blows the tool-result ceiling; the session that built this had
 * 1,354 messages. Every read is paginated by turns, and an omitted range says
 * so in-band with the exact call to continue — a silent truncation would be
 * worse than the overflow it replaces.
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// Overridable for tests; in production these are the audited tools.
const CHAT_FETCH = process.env.CHAT_FETCH_BIN || join(HERE, "chat-fetch.sh");
const PATH_BIN = process.env.PATH_CLI_BIN || "path";

/** Turns per call. Chosen to stay well inside the tool-result ceiling with
 *  ordinary turn lengths; the per-turn cap below bounds the pathological case. */
const DEFAULT_LIMIT = 40;
const MAX_TURN_CHARS = 4000;

const PAGE_PROPS = {
  limit: {
    type: "integer",
    minimum: 1,
    maximum: 200,
    default: DEFAULT_LIMIT,
    description: `Turns to return (default ${DEFAULT_LIMIT}).`,
  },
  offset: {
    type: "integer",
    description:
      "First turn to return, 0-based. NEGATIVE counts from the end (-40 = the last 40 turns). " +
      "read_chat defaults to 0 (the beginning); read_session defaults to -40 (the most recent turns).",
  },
  mode: {
    type: "string",
    enum: ["transcript", "graph"],
    default: "transcript",
    description:
      "transcript (default): readable, paginated role/text turns. graph: the raw toolpath Graph JSON " +
      "(whole-session and unpaginated — machine consumers want it intact; large sessions may be very big). " +
      "graph REFUSES an explicit offset/limit rather than ignoring them (#371) — use transcript for a window.",
  },
};

const READ_CHAT_TOOL = {
  name: "read_chat",
  description:
    "Read a shared Claude chat (a claude.ai/share/<uuid> link) and return its transcript. " +
    "Use this for ANY claude.ai share link — do NOT fetch the share page or the vendor " +
    "snapshot API (client-rendered SPA shell; Cloudflare bot-gated; proxy-blocked). This " +
    "routes through the org relay, which reads only PUBLIC shares and holds no vendor " +
    "credential. If no relay bearer is configured the tool returns how to grant one. " +
    "Long chats are paginated — the result names the range and how to continue.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      share_url: { type: "string", description: "A https://claude.ai/share/<uuid> link." },
      ...PAGE_PROPS,
    },
    required: ["share_url"],
  },
};

const READ_SESSION_TOOL = {
  name: "read_session",
  description:
    "Read a Claude Code session's own transcript from local disk (~/.claude/projects, via the " +
    "`path` CLI) — no relay and no credential. With no arguments it reads THE CURRENT SESSION's " +
    "most recent turns: use it to recall what this session has already done, decided, claimed or " +
    "pushed when the context window may have been summarized. Pass session_id to read a different " +
    "local session. Long sessions are paginated — the result names the range and how to continue.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      session_id: {
        type: "string",
        description:
          "Session UUID. Omit for the current session ($CLAUDE_CODE_SESSION_ID). NOTE: inside an " +
          "in-process subagent that variable holds the PARENT's session, so omitting this reads the " +
          "parent's transcript, not yours (.github#343). A subagent CANNOT read its own transcript " +
          "through this tool at all — agent ids are not session ids and do not resolve here. Read the " +
          "file directly instead: ~/.claude/projects/<project-slug>/<parent-session-id>/subagents/" +
          "agent-*.jsonl, yours identified by mtime and the sibling agent-<id>.meta.json `description`.",
      },
      project: {
        type: "string",
        description: "Project path the session belongs to. Omit to resolve it from the session list.",
      },
      ...PAGE_PROPS,
    },
    required: [],
  },
};

// ── graph → turns → paginated transcript ─────────────────────────────────────

/** Flatten a toolpath Graph into {role, text} turns, dropping non-turn steps
 *  (the leading metadata step, tool events) and empty text. */
export function turnsOf(graph) {
  const steps = graph?.paths?.[0]?.steps ?? [];
  const turns = [];
  for (const s of steps) {
    const change = s?.change ?? {};
    const src = Object.keys(change)[0];
    const st = src ? change[src]?.structural : undefined;
    if (!st || !st.role) continue;
    const text = typeof st.text === "string" ? st.text.trim() : "";
    if (!text) continue;
    turns.push({ role: st.role, text });
  }
  return turns;
}

/** Resolve a page window. Negative offset counts back from the end, so
 *  "the last N turns" needs no separate flag. */
export function page(total, { limit = DEFAULT_LIMIT, offset = 0 } = {}) {
  const lim = Math.max(1, Math.min(200, Number.isInteger(limit) ? limit : DEFAULT_LIMIT));
  const off = Number.isInteger(offset) ? offset : 0;
  const start = off < 0 ? Math.max(0, total + off) : Math.min(Math.max(0, off), total);
  const end = Math.min(start + lim, total);
  return { start, end, next: end < total ? end : null };
}

/** Render a page of turns. The range and the continuation call are stated
 *  IN-BAND: an omitted range that does not announce itself is a silent
 *  truncation, which is worse than the overflow this replaces (#330). */
export function renderTranscript(graph, opts = {}, label = "Shared chat") {
  const turns = turnsOf(graph);
  const { start, end, next } = page(turns.length, opts);
  const lines = [
    `# ${label} — turns ${turns.length ? start + 1 : 0}–${end} of ${turns.length}`,
    `_A turn is one user or assistant message carrying text; tool calls, tool results and empty messages are not turns._\n`,
  ];
  for (const t of turns.slice(start, end)) {
    const text =
      t.text.length > MAX_TURN_CHARS
        ? `${t.text.slice(0, MAX_TURN_CHARS)}\n\n… [turn truncated — ${t.text.length} chars total]`
        : t.text;
    lines.push(`\n## ${t.role}\n\n${text}`);
  }
  if (next !== null) {
    lines.push(`\n\n— ${turns.length - end} more turn(s). Continue with offset: ${next}.`);
  }
  return lines.join("\n");
}

// ── the verbs ────────────────────────────────────────────────────────────────

const ok = (text) => ({ content: [{ type: "text", text }] });
const err = (text) => ({ content: [{ type: "text", text }], isError: true });

function readChat(args) {
  const shareUrl = args?.share_url;
  if (typeof shareUrl !== "string" || shareUrl.length === 0) {
    return err("read_chat requires a share_url string");
  }
  // The audited script does the fetch, bearer handling, URL validation and
  // refusal messaging. We only ever ask for --json (the branch needing no
  // `path` binary) and render locally.
  const res = spawnSync("bash", [CHAT_FETCH, shareUrl, "--json"], {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  if (res.status !== 0) {
    return err((res.stderr || res.stdout || "chat-fetch failed with no output").trim());
  }
  // read_chat does no defaulting, so the caller's args are also the render options.
  return renderOrGraph(res.stdout, { rawArgs: args, label: "Shared chat" });
}

/** Resolve which local session to read: the argument, else this session. */
export function resolveSession(args, env = process.env) {
  const id = typeof args?.session_id === "string" && args.session_id ? args.session_id : env.CLAUDE_CODE_SESSION_ID;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** Was the session chosen by the caller, or inherited from the environment? */
export function sessionSource(args) {
  return typeof args?.session_id === "string" && args.session_id ? "argument" : "env";
}

/** The transcript header.
 *
 *  WHY IT SAYS WHERE THE ID CAME FROM (.github#343, measured on #337 P5):
 *  inside an in-process SUBAGENT, $CLAUDE_CODE_SESSION_ID is the PARENT's, so
 *  an argument-less read returns the parent's transcript. It is not an error
 *  and cannot be detected from here — a subagent looks like any other process.
 *  P5 only noticed because it happened to recognise the id:
 *
 *    "a subagent that trusts read_session will silently read its parent's
 *     history believing it is its own."
 *
 *  Plausible wrong data with no signal is the worst failure this server can
 *  have, so the header states the provenance and names the subagent case
 *  explicitly. Naming the session was never enough: the reader has to already
 *  know which id is theirs for a bare id to carry the warning.
 */
export function sessionLabel(sessionId, source) {
  const short = sessionId.slice(0, 8);
  return source === "argument"
    ? `Session ${short}`
    : `Session ${short} (from $CLAUDE_CODE_SESSION_ID — in a subagent that is the PARENT's session, not yours; pass session_id to be sure)`;
}

function readSession(args) {
  const sessionId = resolveSession(args);
  if (!sessionId) {
    return err(
      "read_session: no session_id given and $CLAUDE_CODE_SESSION_ID is unset — pass session_id explicitly " +
        `(list them with: ${PATH_BIN} p list claude --json).`,
    );
  }
  // Resolve the project path from the session list unless told, so the caller
  // never has to know where the session lives.
  let project = typeof args?.project === "string" && args.project ? args.project : null;
  if (!project) {
    const list = spawnSync(PATH_BIN, ["p", "list", "claude", "--json"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    if (list.status !== 0) {
      return err(
        `read_session: could not list local sessions (${(list.stderr || "").trim() || "is the `path` CLI installed? setup-toolpath.sh installs it in the background at session start"})`,
      );
    }
    try {
      const found = (JSON.parse(list.stdout).sessions ?? []).find((s) => s.session_id === sessionId);
      project = found?.project_path ?? null;
    } catch {
      /* fall through to the error below */
    }
    if (!project) {
      return err(
        `read_session: session ${sessionId} not found on this machine. Sessions that are: ${PATH_BIN} p list claude --json`,
      );
    }
  }
  const res = spawnSync(PATH_BIN, ["p", "derive", "claude", "-p", project, "-s", sessionId], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
  if (res.status !== 0) {
    return err(`read_session: ${PATH_BIN} p derive failed: ${(res.stderr || "").trim() || "no output"}`);
  }
  // Self-reads default to the MOST RECENT turns: "what have I just been doing"
  // is the question this verb exists for. The default goes on a COPY that is
  // stamped DEFAULTED_PAGE_OPTS: `args` stays exactly what the caller sent, so
  // requestedWindow() below can still tell the two apart (#371).
  const opts = { ...args, [DEFAULTED_PAGE_OPTS]: true };
  if (!Number.isInteger(opts.offset)) opts.offset = -(Number.isInteger(opts.limit) ? opts.limit : DEFAULT_LIMIT);
  return renderOrGraph(res.stdout, { rawArgs: args, opts, label: sessionLabel(sessionId, sessionSource(args)) });
}

/** Stamped onto a page-options object that has had defaults filled in, so a
 *  defaulted copy can never be mistaken for the caller's original arguments.
 *  A Symbol, not a string key: it survives `{...opts}` but is invisible to
 *  JSON, to the JSON-RPC wire, and to `additionalProperties: false`. */
const DEFAULTED_PAGE_OPTS = Symbol("defaulted-page-opts");

/** The refusal for a windowed graph read (#371). It names WHY (graph is
 *  whole-session by design) and WHAT TO DO instead, because the failure this
 *  replaces landed at the harness token ceiling, where the message was about
 *  size rather than about the mode. */
export const GRAPH_WINDOW_REFUSAL =
  'mode: "graph" is whole-session by design and cannot be paginated, so it refuses offset/limit ' +
  "rather than accepting them and silently returning everything (.github#371). " +
  'Drop offset/limit for the whole Graph, or use mode: "transcript" (the default) to read a window of turns.';

/** Did the CALLER actually ask for a page window?
 *
 *  THIS QUESTION CAN ONLY BE ASKED OF THE CALLER'S ORIGINAL ARGUMENTS — never
 *  of the options the renderer receives. read_session fills `offset` in for a
 *  self-read (see readSession above) BEFORE anything downstream looks at it, so
 *  by then every session read carries a window and a refusal that consulted
 *  those options would fire on the commonest call there is: an argument-less
 *  `read_session mode=graph`. That is the bug the obvious one-line fix
 *  introduces, so the two objects are kept separate by construction:
 *
 *    rawArgs — exactly what the caller sent. Never written to. Provenance.
 *    opts    — the defaulted copy, stamped DEFAULTED_PAGE_OPTS. Rendering only.
 *
 *  Passing a defaulted copy in here throws instead of quietly answering "yes",
 *  so a future refactor that collapses the two objects fails loudly in tests.
 */
export function requestedWindow(rawArgs) {
  if (rawArgs && rawArgs[DEFAULTED_PAGE_OPTS]) {
    throw new Error("requestedWindow: given defaulted page options; pass the caller's original arguments (.github#371)");
  }
  return rawArgs?.offset !== undefined || rawArgs?.limit !== undefined;
}

/** Hand back the raw Graph, or render a paginated transcript.
 *
 *  Named arguments on purpose: `rawArgs` and `opts` are different objects with
 *  different jobs (see requestedWindow) and a positional signature makes them
 *  trivially swappable. `opts` defaults to `rawArgs` for callers that do no
 *  defaulting of their own.
 */
function renderOrGraph(stdout, { rawArgs, opts = rawArgs, label }) {
  if (opts?.mode === "graph") {
    if (requestedWindow(rawArgs)) return err(GRAPH_WINDOW_REFUSAL);
    return ok(stdout.trim());
  }
  let graph;
  try {
    graph = JSON.parse(stdout);
  } catch {
    return err('returned non-JSON; try mode: "graph"');
  }
  return ok(renderTranscript(graph, opts ?? {}, label));
}

const TOOLS = { read_chat: readChat, read_session: readSession };

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
          protocolVersion: params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "bounded-verbs", version: "0.2.0" },
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
      if (isRequest) send({ jsonrpc: "2.0", id, result: { tools: [READ_CHAT_TOOL, READ_SESSION_TOOL] } });
      return;
    case "tools/call": {
      if (!isRequest) return;
      const { name, arguments: toolArgs } = params ?? {};
      const fn = Object.prototype.hasOwnProperty.call(TOOLS, name) ? TOOLS[name] : null;
      if (!fn) {
        send({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool: ${name}` } });
        return;
      }
      send({ jsonrpc: "2.0", id, result: fn(toolArgs ?? {}) });
      return;
    }
    default:
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

// Wire stdin only as the entrypoint, so a unit test can import the pure
// functions without the read loop attaching and hanging its process.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) serve();

export { READ_CHAT_TOOL, READ_SESSION_TOOL, readChat, readSession, handle, serve, DEFAULT_LIMIT, DEFAULTED_PAGE_OPTS };
