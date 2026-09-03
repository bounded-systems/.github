// The pre-stage ordering, as a check rather than a retrospective (#343 follow-up).
import { test } from "node:test";
import assert from "node:assert/strict";
import { probe, verdict } from "./payload-staged.mjs";

const D = "bb9f9e207099f45d570d9b90c03ea6f601e7c2b419a8fd1781a899c1ca37cba4";

test("an unchanged boot.sh has nothing to stage", () => {
  const v = verdict({ changed: false, digest: D, status: null });
  assert.equal(v.ok, true);
  assert.match(v.message, /unchanged/);
});

test("a changed boot.sh whose digest the store serves may merge", () => {
  assert.equal(verdict({ changed: true, digest: D, status: 200 }).ok, true);
});

test("a changed boot.sh the store does not hold is RED, and the message is the remedy", () => {
  const v = verdict({ changed: true, digest: D, status: 404, headRef: "bootstrap-pin/bump" });
  assert.equal(v.ok, false);
  assert.match(v.message, /gen-payloads\.mjs --add bootstrap-pin\/bump/, "the red must say exactly what to run");
  assert.match(v.message, /boot-manifest red on\nmain/, "and why it matters");
});

test("any answer that is not 200 or 404 is also red — fail closed", () => {
  // A check that cannot establish the property must not report it held. A 5xx
  // or a dropped connection on a PR is not permission to merge.
  for (const status of [500, 502, 403, null]) {
    const v = verdict({ changed: true, digest: D, status });
    assert.equal(v.ok, false, `status ${status} was treated as staged`);
    assert.match(v.message, /cannot establish/);
  }
});

test("probe reports the status and never throws", async () => {
  const fetchImpl = async () => ({ status: 404, arrayBuffer: async () => new ArrayBuffer(0) });
  assert.equal(await probe(D, { fetchImpl }), 404);
  const broken = async () => { throw new Error("ECONNRESET"); };
  assert.equal(await probe(D, { fetchImpl: broken }), null);
});

test("probe asks for exactly <store>/<digest>.sh", async () => {
  let asked;
  const fetchImpl = async (url) => { asked = url; return { status: 200, arrayBuffer: async () => new ArrayBuffer(0) }; };
  await probe(D, { fetchImpl, store: "https://example.test" });
  assert.equal(asked, `https://example.test/${D}.sh`);
});
