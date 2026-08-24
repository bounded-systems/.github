// Behaviour of the Actions-liveness probe (#553 acceptance 3, #467).
//
// The thing under test is a JUDGEMENT and the SENTENCE it produces, so both are
// asserted. An alarm lane's whole output is the message a human reads at 3am:
// if it names the wrong cause, the lane is worse than absent, because it sends
// the next person to debug a workflow file that is fine — which is the failure
// #553 spent a full investigation on and the reason the probe exists.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assess,
  report,
  humanAge,
  stampFrom,
  fetchStamp,
  main,
  VERDICT,
  DEFAULT_MAX_AGE_HOURS,
} from "./scripts/budget-liveness.mjs";

const NOW = Date.parse("2026-08-24T12:00:00Z");
const ago = (hours) => new Date(NOW - hours * 3_600_000).toISOString();

// ── assess ──────────────────────────────────────────────────────────────────

test("a stamp inside the window is fresh", () => {
  const { verdict, ageHours } = assess({ stamp: ago(1), now: NOW });
  assert.equal(verdict, VERDICT.fresh);
  assert.equal(Math.round(ageHours), 1);
});

test("a stamp past the window is stale", () => {
  const { verdict, ageHours } = assess({ stamp: ago(5), now: NOW });
  assert.equal(verdict, VERDICT.stale);
  assert.equal(Math.round(ageHours), 5);
});

test("the boundary is exclusive — exactly at the threshold is still fresh", () => {
  // Pinned because an off-by-one here is invisible in production: it shifts
  // every alarm by an hour and nothing ever says so.
  assert.equal(assess({ stamp: ago(DEFAULT_MAX_AGE_HOURS), now: NOW }).verdict, VERDICT.fresh);
  assert.equal(
    assess({ stamp: ago(DEFAULT_MAX_AGE_HOURS + 0.01), now: NOW }).verdict,
    VERDICT.stale,
  );
});

test("the threshold is configurable and actually consulted", () => {
  // Guards the wiring, not the arithmetic: a maxAgeHours that is accepted and
  // then ignored leaves the lane looking tunable while it is not.
  assert.equal(assess({ stamp: ago(5), now: NOW, maxAgeHours: 8 }).verdict, VERDICT.fresh);
  assert.equal(assess({ stamp: ago(5), now: NOW, maxAgeHours: 2 }).verdict, VERDICT.stale);
});

test("a missing or unparseable stamp is unreadable, never stale", () => {
  // The distinction the lane's honesty rests on. `stale` sends a human to the
  // billing page; these cases have learned nothing and must not.
  for (const stamp of [undefined, null, "", "not a date", "2026-13-45T99:99:99Z"]) {
    assert.equal(
      assess({ stamp, now: NOW }).verdict,
      VERDICT.unreadable,
      `${JSON.stringify(stamp)} should be unreadable`,
    );
  }
});

test("a stamp from the future is unreadable, never fresh", () => {
  // The false-green case: a broken publisher clock must not read as health.
  assert.equal(assess({ stamp: ago(-6), now: NOW }).verdict, VERDICT.unreadable);
});

test("small negative skew is tolerated rather than alarmed on", () => {
  assert.equal(assess({ stamp: ago(-0.1), now: NOW }).verdict, VERDICT.fresh);
});

// ── the message ─────────────────────────────────────────────────────────────

test("fresh reports ok and does not mention billing", () => {
  const { ok, body } = report(assess({ stamp: ago(1), now: NOW }));
  assert.equal(ok, true);
  assert.doesNotMatch(body, /budget|billing/i);
});

test("stale sends the reader to billing FIRST and names the 4s fingerprint", () => {
  const { ok, title, body } = report(assess({ stamp: ago(6), now: NOW }));
  assert.equal(ok, false);
  assert.match(title, /budget/i);
  assert.match(body, /billing page/i);
  assert.match(body, /runner_id 0/);
  // The prior incidents, so the reader can find the write-ups rather than
  // re-running the investigation #553 already paid for.
  assert.match(body, /#462/);
  assert.match(body, /#553/);
});

test("stale states the inference as likely, not as fact", () => {
  // The misdirection guard. The probe cannot see billing, and a message that
  // asserts exhaustion outright would be a gate claiming something about
  // itself that it did not measure (agentic-code-hygiene rule 3).
  const { body } = report(assess({ stamp: ago(6), now: NOW }));
  assert.match(body, /MOST LIKELY CAUSE/);
  assert.match(body, /CONFIRM IT, do not assume it/);
  // …and it must offer the other causes rather than dead-ending on billing.
  assert.match(body, /IF BILLING IS FINE/);
  assert.match(body, /broker|GitHub incident/i);
});

test("stale carries the public-vs-private discriminator", () => {
  // The one cheap test that separates "budget" from "GitHub is broken", and
  // the observation this whole lane is founded on.
  const { body } = report(assess({ stamp: ago(6), now: NOW }));
  assert.match(body, /PUBLIC org repo/);
});

test("unreadable refuses to be read as either outage or all-clear", () => {
  const { ok, title, body } = report(assess({ stamp: "nonsense", now: NOW }));
  assert.equal(ok, false);
  assert.match(title, /could NOT determine/);
  assert.match(body, /PROVES NOTHING/);
  assert.doesNotMatch(body, /billing page/i);
});

test("humanAge renders hours and minutes", () => {
  assert.equal(humanAge(4.7), "4h 42m");
  assert.equal(humanAge(0), "0h 0m");
  assert.equal(humanAge(-1), "0h 0m");
});

// ── reading the stamp out of the raw blob ───────────────────────────────────

test("stampFrom pulls generated_at without parsing the whole board", () => {
  // Shaped like the real file: the stamp is a top-level key ahead of a very
  // large `items` array, which is what makes the cheap read safe.
  const raw = `{"generated_at":"2026-08-24T07:34:42Z","project":"#2","items":[{"repo":"x"}]}`;
  assert.equal(stampFrom(raw), "2026-08-24T07:34:42Z");
});

test("stampFrom returns null rather than guessing when the key is absent", () => {
  assert.equal(stampFrom(`{"items":[]}`), null);
  // …which assess must then call unreadable, not stale.
  assert.equal(assess({ stamp: stampFrom(`{"items":[]}`), now: NOW }).verdict, VERDICT.unreadable);
});

test("fetchStamp explains that a 404 is ambiguous", () => {
  // The arrival state until the door is minted. A bare "404" would read as
  // "the projection branch is gone" and send someone to the wrong repo.
  const notFound = { ok: false, status: 404, text: async () => "" };
  return assert.rejects(
    fetchStamp({ token: "t", fetchImpl: async () => notFound }),
    (err) => /404/.test(err.message) && /door/.test(err.message),
  );
});

test("fetchStamp sends the token and asks for the raw blob", () => {
  let seen;
  const impl = async (url, init) => {
    seen = { url, init };
    return { ok: true, status: 200, text: async () => `{"generated_at":"${ago(1)}"}` };
  };
  return fetchStamp({ token: "sekrit", fetchImpl: impl }).then(() => {
    assert.match(seen.url, /bounded-systems\/\.github-private/);
    assert.match(seen.url, /ref=front-desk-projection/);
    assert.equal(seen.init.headers.authorization, "Bearer sekrit");
    // Raw, not the base64 JSON envelope — the whole point of the cheap read.
    assert.match(seen.init.headers.accept, /raw/);
  });
});

// ── end to end, through main ────────────────────────────────────────────────

const capture = () => {
  const lines = [];
  return { lines, log: (l) => lines.push(l) };
};

test("main exits truthy and stays quiet about billing when the estate is live", async () => {
  const { lines, log } = capture();
  const ok = await main({
    token: "t",
    now: NOW,
    log,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => `{"generated_at":"${ago(1)}"}` }),
  });
  assert.equal(ok, true);
  assert.doesNotMatch(lines.join("\n"), /::error/);
});

test("main raises a one-line ::error annotation when the stamp is stale", async () => {
  const { lines, log } = capture();
  const ok = await main({
    token: "t",
    now: NOW,
    log,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => `{"generated_at":"${ago(9)}"}` }),
  });
  assert.equal(ok, false);

  const annotation = lines.find((l) => l.startsWith("::error"));
  assert.ok(annotation, "no ::error annotation was emitted");
  // ::error swallows everything after a newline, so the remediation steps are
  // exactly what a multi-line annotation would silently drop.
  assert.doesNotMatch(annotation, /\n/);
  assert.match(annotation, /billing page/i);
});

test("main treats a missing token as unreadable, not as an outage", async () => {
  const { lines, log } = capture();
  const ok = await main({
    token: "",
    now: NOW,
    log,
    fetchImpl: async () => {
      throw new Error("must not be called without a token");
    },
  });
  assert.equal(ok, false);
  assert.match(lines.join("\n"), /PROVES NOTHING/);
});

test("main treats a network failure as unreadable, not as an outage", async () => {
  // The case that would otherwise cry wolf every time the broker or the API
  // has a bad minute.
  const { lines, log } = capture();
  const ok = await main({
    token: "t",
    now: NOW,
    log,
    fetchImpl: async () => {
      throw new Error("ECONNRESET");
    },
  });
  assert.equal(ok, false);
  const out = lines.join("\n");
  assert.match(out, /PROVES NOTHING/);
  assert.doesNotMatch(out, /billing page/i);
});
