// Tests for the DISCOVERABILITY CHAIN of the chat/session verbs (#325).
//
// WHY THIS FILE EXISTS. On 2026-08-31 an agent was handed only a claude.ai
// share link and nothing else. It never found `.claude/chat-fetch.sh`, and
// over six dead ends it worked its way up to inventing a Cloudflare bot-gate
// bypass for the share page — the exact failure the relay was built to make
// unnecessary. The capability existed the whole time; the POINTER to it did
// not reach the model. So discoverability is a checked property here, not
// polish: a refactor that silently breaks a link in the chain fails CI now
// instead of failing a future session that has no way to know what it is
// missing.
//
// THE CHAIN, in the order a session actually traverses it:
//   .mcp.json  →  verb-server.mjs  →  tools/list (read_chat, read_session)
//                                  →  tool descriptions that TEACH (use me,
//                                     and do not fetch the vendor page)
//   .claude/chat-fetch.sh          →  the with-checkout fallback, whose
//                                     no-bearer refusal names the grant path
//   claude/context.md              →  the prose pointer for the checkout-less
//                                     session (the copy served with no repo)
//
// Every assertion below reads files or imported exports. No network, no spawn:
// the protocol behaviour is verb-server.test.mjs's job, and the script's own
// contract is chat-fetch.test.mjs's. What is pinned HERE is only that the
// links still point at each other.

import { test } from "node:test";
import assert from "node:assert/strict";
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { handle, READ_CHAT_TOOL, READ_SESSION_TOOL } from "./verb-server.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const MCP_JSON = join(ROOT, ".mcp.json");
const SERVER = join(HERE, "verb-server.mjs");
const CHAT_FETCH = join(HERE, "chat-fetch.sh");
const CONTEXT = join(ROOT, "claude", "context.md");

const read = (p) => readFileSync(p, "utf8");

// ── link 1: .mcp.json declares the server, and points at a real file ─────────

test("link 1: .mcp.json exists at the repo root and parses", () => {
  assert.ok(
    existsSync(MCP_JSON),
    `CHAIN BROKEN at link 1: ${MCP_JSON} is missing. register-mcp.mjs finds servers by ` +
      "looking for .mcp.json in each attached repo, so with no file the verbs are never " +
      "registered and a session sees no read_chat tool at all.",
  );
  assert.doesNotThrow(
    () => JSON.parse(read(MCP_JSON)),
    "CHAIN BROKEN at link 1: .mcp.json is not valid JSON. collectServers() logs a WARN and " +
      "SKIPS the repo — registration fails quietly and the session just never gets the tools.",
  );
});

test("link 1: .mcp.json declares the 'bounded-verbs' stdio server", () => {
  const servers = JSON.parse(read(MCP_JSON))?.mcpServers ?? {};
  assert.ok(
    Object.prototype.hasOwnProperty.call(servers, "bounded-verbs"),
    "CHAIN BROKEN at link 1: no 'bounded-verbs' server in .mcp.json (found: " +
      `${JSON.stringify(Object.keys(servers))}). The name is the handle every other pointer ` +
      "uses; renaming it orphans them and leaves the session with no verbs.",
  );
  const server = servers["bounded-verbs"];
  assert.equal(
    server.type,
    "stdio",
    "CHAIN BROKEN at link 1: 'bounded-verbs' is not declared as a stdio server, but " +
      "verb-server.mjs speaks only the JSON-RPC-over-stdio transport — the client would " +
      "fail to hand-shake and drop the tools.",
  );
  assert.ok(
    Array.isArray(server.args) && server.args.length > 0,
    "CHAIN BROKEN at link 1: 'bounded-verbs' declares no args, so `node` is spawned with " +
      "nothing to run and the server never comes up.",
  );
});

test("link 1→2: the declared args point at a file that EXISTS on disk", () => {
  const server = JSON.parse(read(MCP_JSON)).mcpServers["bounded-verbs"];
  // register-mcp.mjs's absolutize() treats an arg as a path exactly when it
  // names a file that exists inside the repo; an arg that does not is left
  // relative and then resolved against whatever cwd the client happened to
  // have. Same predicate here, so this test fails for the same reason
  // registration would.
  const resolved = server.args
    .filter((a) => typeof a === "string" && !a.startsWith("-"))
    .map((a) => (isAbsolute(a) ? a : join(ROOT, a)))
    .filter((p) => existsSync(p));
  assert.ok(
    resolved.length > 0,
    "CHAIN BROKEN between links 1 and 2: no arg of the 'bounded-verbs' declaration names an " +
      `existing file (args: ${JSON.stringify(server.args)}). absolutize() would leave the path ` +
      "relative, the spawn would fail with MODULE_NOT_FOUND, and the session would see the " +
      "server listed but every tool call dead.",
  );
  assert.ok(
    resolved.includes(SERVER),
    `CHAIN BROKEN between links 1 and 2: .mcp.json does not point at ${SERVER} (it resolves to ` +
      `${JSON.stringify(resolved)}). Whatever it points at instead is what actually serves the ` +
      "verbs, and the tools this suite checks are not the tools the session gets.",
  );
});

// ── link 2: the server advertises both verbs in tools/list ──────────────────

/** Drive one JSON-RPC request through the real handler, capturing what it
 *  writes to stdout. Importing beats spawning (the module wires stdin only as
 *  an entrypoint), and going through handle() rather than reading the exported
 *  constants means this pins what a CLIENT is actually told. */
function rpc(req) {
  const written = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  try {
    handle(req);
  } finally {
    process.stdout.write = original;
  }
  return written.join("").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("link 2: verb-server.mjs exists and its tools/list advertises read_chat and read_session", () => {
  assert.ok(
    existsSync(SERVER),
    `CHAIN BROKEN at link 2: ${SERVER} is missing — .mcp.json points into thin air and the ` +
      "session's tool list is empty.",
  );
  const [res] = rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const names = (res?.result?.tools ?? []).map((t) => t.name);
  for (const want of ["read_chat", "read_session"]) {
    assert.ok(
      names.includes(want),
      `CHAIN BROKEN at link 2: tools/list does not advertise '${want}' (advertised: ` +
        `${JSON.stringify(names)}). A tool that is not in the list cannot be called and, worse, ` +
        "cannot be discovered — this is precisely the 2026-08-31 state where the model reached " +
        "for a vendor-API bypass instead.",
    );
  }
  // The exported constants are what the rest of the tree (and this suite's
  // description checks) reads; if they drift from what tools/list sends, the
  // checks below stop describing reality.
  assert.deepEqual(
    res.result.tools,
    [READ_CHAT_TOOL, READ_SESSION_TOOL],
    "CHAIN BROKEN at link 2: tools/list no longer sends the exported READ_CHAT_TOOL / " +
      "READ_SESSION_TOOL objects, so every description check in this file is testing text the " +
      "session never sees.",
  );
});

// ── link 3: the descriptions TEACH — the tool list is the only teaching surface ──

test("link 3: read_chat's description names the share link and warns off the vendor page", () => {
  const d = READ_CHAT_TOOL.description;
  assert.match(
    d,
    /claude\.ai\/share/,
    "CHAIN BROKEN at link 3: read_chat's description no longer names a claude.ai/share link. " +
      "A session holding a share link matches its task against the description text; without " +
      "the literal URL shape it does not recognise this tool as the answer and starts fetching.",
  );
  assert.match(
    d,
    /do NOT fetch/i,
    "CHAIN BROKEN at link 3: read_chat's description no longer warns against fetching. The warn " +
      "is the load-bearing half: the 2026-08-31 agent's six dead ends were all fetches, and a " +
      "description that only offers an alternative does not stop them.",
  );
  assert.match(
    d,
    /snapshot API|vendor/i,
    "CHAIN BROKEN at link 3: read_chat's description no longer names the vendor snapshot API as " +
      "off-limits. Naming the specific wrong door is what makes the warning actionable — the " +
      "measured failure was an invented Cloudflare bot-gate bypass, not a vague fetch.",
  );
});

test("link 3: read_session's description names the CURRENT session and warns off fetching", () => {
  const d = READ_SESSION_TOOL.description;
  assert.match(
    d,
    /current session/i,
    "CHAIN BROKEN at link 3: read_session's description no longer says it reads THE CURRENT " +
      "SESSION. That is the whole discovery cue for 'what have I already done' — without it a " +
      "session with a summarized-away context window has no idea the answer is one call away.",
  );
  assert.match(
    d,
    /no relay and no credential|local disk|~\/\.claude\/projects/i,
    "CHAIN BROKEN at link 3: read_session's description no longer says the read is LOCAL. A " +
      "session that thinks it needs a relay bearer for its own transcript will not try.",
  );
});

// ── link 4: chat-fetch.sh, the with-checkout fallback ────────────────────────

test("link 4: chat-fetch.sh exists and is executable", () => {
  assert.ok(
    existsSync(CHAT_FETCH),
    `CHAIN BROKEN at link 4: ${CHAT_FETCH} is missing. read_chat spawns it for every call, so ` +
      "the MCP tool fails too — both the tool and the fallback go down together.",
  );
  assert.doesNotThrow(
    () => accessSync(CHAT_FETCH, constants.X_OK),
    "CHAIN BROKEN at link 4: chat-fetch.sh is not executable (mode " +
      `${(statSync(CHAT_FETCH).mode & 0o777).toString(8)}). A session that found it by grepping ` +
      "runs it directly and gets 'Permission denied' — which reads as 'this is not the way'.",
  );
});

test("link 4: the no-bearer refusal names the grant path", () => {
  const src = read(CHAT_FETCH);
  assert.match(
    src,
    /no relay bearer/,
    "CHAIN BROKEN at link 4: chat-fetch.sh no longer refuses with a recognisable 'no relay " +
      "bearer' sentence. read_chat surfaces this text verbatim, and the refusal IS the teach: a " +
      "bare error tells the session the door is shut, not how to open it.",
  );
  assert.match(
    src,
    /CLAUDE_RELAY_BEARER/,
    "CHAIN BROKEN at link 4: the refusal no longer names $CLAUDE_RELAY_BEARER, so a session that " +
      "HAS a bearer to hand cannot tell where to put it.",
  );
  assert.match(
    src,
    /grant_relay_lease/,
    "CHAIN BROKEN at link 4: the refusal no longer names grant_relay_lease — the dispatch that " +
      "actually mints a bearer. Without it the session is told 'set a bearer' with no way to get " +
      "one, which is the shape of a named mechanism that does not resolve.",
  );
});

// ── link 5: the prose pointer, for the session with NO checkout ──────────────

// THE ASSERTION THAT MAKES #346 UNREPEATABLE.
//
// What a session must type is neither of the two strings this repo stores. It is
// their COMPOSITION: `mcp__` + the server key from .mcp.json + `__` + the tool
// name from verb-server.mjs. Nothing owned that composition, so #346 shipped a
// context.md naming the tools `read_chat` / `read_session` -- true to the server,
// useless to a caller, and measured by three independent probes on #337 as
// `No matching deferred tools found`.
//
// The old assertion here was `assert.match(ctx, /read_chat/)`, which the pre-#346
// text SATISFIES: a bare name is a substring of a prefixed one. The gate meant to
// prevent that defect would have passed it. So derive the name the way the client
// does and assert THAT, and the two halves can no longer drift apart silently --
// rename the server key in .mcp.json and this fails rather than context.md
// quietly becoming wrong again.
export function composedToolName(serverKey, toolName) {
  return `mcp__${serverKey}__${toolName}`;
}

test("link 5: context.md names the tools by the name a client must actually type", () => {
  const ctx = read(CONTEXT);
  const serverKey = Object.keys(JSON.parse(read(MCP_JSON)).mcpServers)[0];
  for (const tool of [READ_CHAT_TOOL, READ_SESSION_TOOL]) {
    const composed = composedToolName(serverKey, tool.name);
    assert.ok(
      ctx.includes(composed),
      `CHAIN BROKEN at link 5: claude/context.md does not contain '${composed}'. That is the ` +
        `string a session must type -- '${tool.name}' alone does NOT resolve (measured on #337: ` +
        `ToolSearch answers 'No matching deferred tools found'). This is the copy injected into a ` +
        `session with NO checkout, so this bullet is its only pointer, and a pointer that does not ` +
        `resolve is worse than none: it spends the session's trust before it spends its time.`,
    );
  }
  assert.match(
    ctx,
    /do not fetch|don't fetch|never fetch/i,
    "CHAIN BROKEN at link 5: claude/context.md names the tool but no longer warns against " +
      "fetching the share page. Offering the right door without closing the wrong one is what " +
      "left six dead ends on the record.",
  );
});

// The composed name has a SECOND producer, and it is the one that serves the
// session this whole chain exists for. A checkout-less session never reads the
// repo's .mcp.json: boot.sh writes its own declaration into the fetch cache
// (#325). If those two keys drift, context.md is right for attached sessions and
// wrong for exactly the population it was written for -- and every existing check
// here reads only the committed copy, so nothing would say so.
test("link 5: boot.sh's fetch-cache declaration uses the SAME server key as the repo's", () => {
  const repoKey = Object.keys(JSON.parse(read(MCP_JSON)).mcpServers)[0];
  const boot = read(join(HERE, "boot.sh"));
  const declared = [...boot.matchAll(/"([A-Za-z0-9_-]+)":\s*\{\s*\n\s*"type":\s*"stdio"/g)].map((m) => m[1]);
  assert.ok(
    declared.length > 0,
    "CHAIN BROKEN at link 5: boot.sh no longer writes a stdio server declaration into the fetch " +
      "cache, so a session without .github registers no verbs at all (#325).",
  );
  for (const key of declared) {
    assert.equal(
      key,
      repoKey,
      `CHAIN BROKEN at link 5: boot.sh declares the server as '${key}' but .mcp.json declares it ` +
        `as '${repoKey}'. The tool name a session must type is composed from that key, so a ` +
        `checkout-less session would need 'mcp__${key}__read_chat' while context.md tells it to ` +
        `type 'mcp__${repoKey}__read_chat'. One of those populations is being lied to.`,
    );
  }
});
