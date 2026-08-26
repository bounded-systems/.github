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
  CEREMONY_WINDOW_MS,
  buildRequest,
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

test("org-defaults.yml actually runs this suite", () => {
  // Same ratchet as claim-authorization.test.mjs, for the same reason: this repo
  // enumerates its test files one `run:` step at a time, and it has already
  // shipped a suite that never executed in CI.
  const root = dirname(fileURLToPath(import.meta.url));
  const wf = readFileSync(join(root, ".github/workflows/org-defaults.yml"), "utf8");
  assert.match(wf, /node --test claim-ceremony\.test\.mjs/);
});
