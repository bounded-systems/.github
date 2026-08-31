/**
 * @module
 * The suite for the ceremony half (`.github-private`#642).
 *
 * The property worth testing here is narrow and specific: the token this
 * produces must round-trip into the token the DOOR accepts, and the request the
 * human is shown must be the request the door will recompute. Everything else is
 * the keeper's job. So the tests below drive `runCeremony` against a scripted
 * relying party with time and sleep injected — a polling loop tested against a
 * real clock is a suite that either takes fifteen minutes or never exercises the
 * timeout at all.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { validateClaimRequest, claimDigest } from "./claim-digest.mjs";
import { parseAuthorizationToken, claimRequestFrom, CLAIM_POLICY_V1 } from "./claim-authorization.mjs";
import {
  ANNOUNCE_REPO,
  ANNOUNCE_WORKFLOW,
  announceInputs,
  handoffNotice,
  CEREMONY_WINDOW_MS,
  EXPIRY_GRACE_MS,
  announceCeremony,
  approvalPrompt,
  buildRequest,
  ceremonyWindowMs,
  encodeToken,
  freshNonce,
  runCeremony,
  stampNow,
} from "./claim-ceremony.mjs";

const DOOR = { repo: "infra", issue: "478", claimant: "claude-session/some-branch", keeperUrl: "https://keeper.bounded.tools/" };

const jsonRes = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

/** A keeper scripted turn by turn; each call shifts one scripted response. */
function scriptedKeeper(steps) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    const next = steps.shift();
    if (!next) throw new Error("the keeper was called more times than the script allows");
    return next;
  };
  return { fetchImpl, calls };
}

test("the request is valid, carries the door's policy, and names what the caller asked for", () => {
  const req = buildRequest(DOOR, { nonce: freshNonce(), issuedAt: stampNow(Date.parse("2026-08-26T13:00:00Z")) });
  assert.deepEqual(validateClaimRequest(req), []);
  assert.equal(req.policy, CLAIM_POLICY_V1);
  assert.equal(req.repo, "infra");
  assert.equal(req.issuedAt, "2026-08-26T13:00:00Z");
});

test("a fresh nonce is 43 base64url characters, and two are not the same", () => {
  const a = freshNonce();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, freshNonce());
});

test("the token round-trips into exactly what the door parses", () => {
  const nonce = freshNonce();
  const issuedAt = stampNow(Date.parse("2026-08-26T13:00:00Z"));
  const token = encodeToken({ authorizationId: "auth_1", nonce, issuedAt });
  assert.deepEqual(parseAuthorizationToken(token), { authorizationId: "auth_1", nonce, issuedAt });
});

test("the digest the human signs is the digest the door recomputes", async () => {
  // The one agreement that cannot be checked at runtime by either side alone: if
  // these two ever diverge, every ceremony verifies at the keeper and fails at
  // the door, with nothing in either log pointing at the disagreement.
  const nonce = freshNonce();
  const issuedAt = stampNow(Date.parse("2026-08-26T13:00:00Z"));
  const shown = buildRequest(DOOR, { nonce, issuedAt });
  const recomputed = claimRequestFrom(DOOR, { nonce, issuedAt });
  assert.deepEqual(shown, recomputed);
  assert.equal(await claimDigest(shown), await claimDigest(recomputed));
});

test("a completed ceremony returns a token the door accepts", async () => {
  const { fetchImpl, calls } = scriptedKeeper([
    jsonRes({ ceremonyId: "cer_1", approveUrl: "https://keeper.bounded.tools/a/cer_1", display: { action: "claim" } }),
    jsonRes({ pending: true }),
    jsonRes({ authorizationId: "auth_9" }),
  ]);
  let opened = null;
  const { token, request } = await runCeremony(DOOR, {
    fetchImpl,
    sleep: async () => {},
    onOpen: (url) => (opened = url),
  });
  assert.equal(opened, "https://keeper.bounded.tools/a/cer_1");
  assert.equal(parseAuthorizationToken(token).authorizationId, "auth_9");
  // and the request that was SENT is the one the token is bound to
  assert.deepEqual(calls[0].body.request, request);
  assert.equal(calls[0].body.requestType, request.v);
});

test("a keeper that stops sending approveUrl still yields an approvable ceremony", async () => {
  const { fetchImpl } = scriptedKeeper([
    jsonRes({ ceremonyId: "cer_2" }),
    jsonRes({ authorizationId: "auth_2" }),
  ]);
  let opened = null;
  await runCeremony(DOOR, { fetchImpl, sleep: async () => {}, onOpen: (url) => (opened = url) });
  // Note the caller passed a trailing slash; the URL must not double it.
  assert.equal(opened, "https://keeper.bounded.tools/a/cer_2");
});

test("a refused open is reported as the keeper's own words", async () => {
  const { fetchImpl } = scriptedKeeper([jsonRes({ error: "no credentials enrolled" }, 503)]);
  await assert.rejects(
    () => runCeremony(DOOR, { fetchImpl, sleep: async () => {} }),
    /no credentials enrolled/,
  );
});

test("GONE and TIMEOUT are distinct failures, because they mean different things", async () => {
  const gone = scriptedKeeper([
    jsonRes({ ceremonyId: "cer_3" }),
    jsonRes({ error: "nothing to collect" }, 410),
  ]);
  await assert.rejects(
    () => runCeremony(DOOR, { fetchImpl: gone.fetchImpl, sleep: async () => {} }),
    /Nobody approved this claim/,
  );

  // Time is injected: the loop must give up at the window, not spin forever.
  let clock = 0;
  const pending = [jsonRes({ ceremonyId: "cer_4" })];
  for (let i = 0; i < 10; i++) pending.push(jsonRes({ pending: true }));
  const timeout = scriptedKeeper(pending);
  await assert.rejects(
    () =>
      runCeremony(DOOR, {
        fetchImpl: timeout.fetchImpl,
        sleep: async () => {
          clock += CEREMONY_WINDOW_MS;
        },
        now: () => clock,
      }),
    /no passkey approval within the ceremony window/,
  );
});

test("the printed window derives from the keeper's response, never from this file", async () => {
  // #256: the script promised 15 minutes while the keeper expired claims at 2.
  // `ttlSeconds` outranks `expiresAt` (a duration cannot be clock-skewed), and
  // both spellings must work — a sibling lane lands the field, so it is
  // consumed defensively.
  assert.equal(ceremonyWindowMs({ ttlSeconds: 120 }, 0), 120_000);
  assert.equal(ceremonyWindowMs({ expiresAt: new Date(300_000).toISOString() }, 0), 300_000);
  assert.equal(ceremonyWindowMs({ ttlSeconds: 120, expiresAt: new Date(9_000_000).toISOString() }, 0), 120_000);
  // a keeper naming a window past the fallback cap is capped, not believed
  assert.equal(ceremonyWindowMs({ ttlSeconds: 86_400 }, 0), CEREMONY_WINDOW_MS);
  // malformed or absent reads as "no window named", never as a NaN deadline
  assert.equal(ceremonyWindowMs({}, 0), null);
  assert.equal(ceremonyWindowMs({ ttlSeconds: "soon", expiresAt: "tomorrowish" }, 0), null);
  assert.equal(approvalPrompt(120_000), "Approve with your passkey (2 minutes):");

  // and runCeremony hands that window to the caller who prints it
  const { fetchImpl } = scriptedKeeper([
    jsonRes({ ceremonyId: "cer_5", ttlSeconds: 120 }),
    jsonRes({ authorizationId: "auth_5" }),
  ]);
  let window = null;
  await runCeremony(DOOR, {
    fetchImpl,
    sleep: async () => {},
    onOpen: (_url, _display, windowMs) => (window = windowMs),
  });
  assert.equal(window, 120_000);
});

test("polling stops at the keeper's stated expiry, not the fallback cap", async () => {
  // ttl 120s plus the grace puts the deadline at 130s. Polls land at 0s, 60s,
  // 120s and 180s — exactly four; the script holds no fifth response, so a loop
  // that ran on to the 15-minute cap would die on the script, not the window.
  let clock = 0;
  const steps = [jsonRes({ ceremonyId: "cer_6", ttlSeconds: 120 })];
  for (let i = 0; i < 4; i++) steps.push(jsonRes({ pending: true }));
  const { fetchImpl, calls } = scriptedKeeper(steps);
  await assert.rejects(
    () =>
      runCeremony(DOOR, {
        fetchImpl,
        sleep: async () => {
          clock += 60_000;
        },
        now: () => clock,
      }),
    /no passkey approval within the ceremony window/,
  );
  assert.equal(calls.length, 5); // the start call + four polls, none past the expiry
  assert.ok(EXPIRY_GRACE_MS < 60_000); // the poll arithmetic above depends on it
});

test("with no expiry from the keeper, the wording never claims 15 minutes as the ceremony's own window", () => {
  // CEREMONY_WINDOW_MS is how long WE poll an older keeper, not how long the
  // ceremony lives — the keeper sets that per request type, and a claim's has
  // been 2 minutes (#256).
  const fallback = approvalPrompt(null);
  assert.match(fallback, /Approve with your passkey/);
  assert.match(fallback, /as short as 2 minutes/);
  assert.doesNotMatch(fallback, /15 minutes/);
  // and the CLI prints through approvalPrompt — the hardcoded promise is gone
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "claim-ceremony.mjs"), "utf8");
  assert.match(src, /\$\{approvalPrompt\(windowMs\)\}/);
  assert.doesNotMatch(src, /passkey \(15 minutes\)/);
});

test("org-defaults.yml actually runs this suite", () => {
  // Same ratchet as claim-authorization.test.mjs, for the same reason: this repo
  // enumerates its test files one `run:` step at a time, and it has already
  // shipped a suite that never executed in CI.
  const root = dirname(fileURLToPath(import.meta.url));
  const wf = readFileSync(join(root, ".github/workflows/org-defaults.yml"), "utf8");
  assert.match(wf, /node --test claim-ceremony\.test\.mjs/);
});

// ── The announce lane (#305) ─────────────────────────────────────────────────
//
// The property under test is that this is a CONVENIENCE and cannot become a
// gate. Every failure below must be reported and survived, because the ceremony
// is what authorizes and a notification that did not send changes nothing about
// whether a human can approve.

test("with no GitHub token it skips cleanly, and says so", async () => {
  // The session case this exists for: `claim-ceremony.mjs` run where no token
  // is exported. Throwing here would take out the ceremony over a notification.
  let called = false;
  const r = await announceCeremony(
    { repo: "desk", issue: "61", claimant: "c", approveUrl: "https://keeper.bounded.tools/a/x" },
    { env: {}, fetchImpl: async () => { called = true; } },
  );
  assert.equal(r.announced, false);
  assert.match(r.reason, /no GitHub token/);
  assert.equal(called, false, "it must not reach the network without a token");
});

test("a 204 is the only success, and it dispatches the pinned lane", async () => {
  let seen;
  const r = await announceCeremony(
    { repo: "desk", issue: "61", claimant: "claude/x", approveUrl: "https://keeper.bounded.tools/a/x" },
    {
      env: { GH_TOKEN: "t" },
      fetchImpl: async (url, init) => { seen = { url, init }; return { status: 204 }; },
    },
  );
  assert.equal(r.announced, true);
  assert.equal(seen.url,
    `https://api.github.com/repos/${ANNOUNCE_REPO}/actions/workflows/${ANNOUNCE_WORKFLOW}/dispatches`);
  const body = JSON.parse(seen.init.body);
  assert.equal(body.ref, "main");
  // The notice must name what is being approved: "an approval is waiting" is
  // unactionable on a phone.
  assert.match(body.inputs.title, /desk#61/);
  assert.match(body.inputs.body, /desk#61/);
  assert.equal(body.inputs.url, "https://keeper.bounded.tools/a/x");
});

test("an API refusal and a transport error are both survived, and distinguishable", async () => {
  const refused = await announceCeremony(
    { repo: "d", issue: "1", claimant: "c", approveUrl: "https://keeper.bounded.tools/a/x" },
    { env: { GH_TOKEN: "t" }, fetchImpl: async () => ({ status: 403 }) },
  );
  assert.equal(refused.announced, false);
  assert.match(refused.reason, /HTTP 403/);

  const threw = await announceCeremony(
    { repo: "d", issue: "1", claimant: "c", approveUrl: "https://keeper.bounded.tools/a/x" },
    { env: { GH_TOKEN: "t" }, fetchImpl: async () => { throw new Error("ECONNRESET"); } },
  );
  assert.equal(threw.announced, false);
  assert.match(threw.reason, /ECONNRESET/);
});

// ── The hand-off, when the dispatch cannot happen (#305) ─────────────────────
//
// MEASURED 2026-08-31: this process's env token carries `actions: read` and
// GitHub itself refuses the dispatch POST with `Resource not accessible by
// integration`. It is not a transient. So the failure branch is the branch that
// runs in a session, every time, and what it prints is the whole of its value.
//
// The property under test is ANTI-DRIFT, not wording. A hand-off is only worth
// printing if following it produces the notice this file would have sent; a
// second copy of the text that quietly diverges is a message that can only see
// its own scaffolding.

test("the hand-off names exactly the inputs the dispatch would have sent", async () => {
  const args = {
    repo: "bounded-systems/.github",
    issue: "305",
    claimant: "claude/x",
    approveUrl: "https://keeper.bounded.tools/a/abc",
  };
  let seen;
  await announceCeremony(args, {
    env: { GH_TOKEN: "t" },
    fetchImpl: async (_u, init) => { seen = JSON.parse(init.body); return { status: 204 }; },
  });

  const text = handoffNotice(args);
  // Bound to the ACTUAL request body, not to a literal repeated here. A second
  // rendering of the title or body in either path breaks this.
  for (const [k, v] of Object.entries(seen.inputs)) {
    assert.ok(text.includes(v), `the hand-off omits the ${k} the dispatch sends: ${v}`);
  }
  assert.deepEqual(seen.inputs, announceInputs(args));
  // The REF is the fourth thing a session has to type, and desk pins the ref as
  // tightly as it pins the file. Bound to the dispatch's own ref for the same
  // reason as the inputs: moving one and not the other is silent here otherwise.
  assert.ok(text.includes(`ref ${seen.ref}`), `the hand-off names a ref the dispatch does not use: ${seen.ref}`);
});

test("the hand-off names the lane desk allowlists, at the ref it allowlists", async () => {
  // desk pins ONE workflow at ONE ref. A hand-off pointing at anything else
  // sends a session to dispatch something that cannot notify.
  const text = handoffNotice({
    repo: "d", issue: "1", claimant: "c", approveUrl: "https://keeper.bounded.tools/a/x",
  });
  assert.ok(text.includes(ANNOUNCE_WORKFLOW), "names no workflow");
  assert.ok(text.includes(ANNOUNCE_REPO), "names no repo");
  assert.match(text, /\bmain\b/);
});
