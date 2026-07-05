// The org-defaults contract, exercised against the real repo — so the content
// tokens and community-health defaults can't drift from a valid shape.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REQUIRED_COMMUNITY_HEALTH,
  validateContentTokens,
  validateOrgDefaults,
} from "./org-defaults.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const at = (p) => join(ROOT, p);

test("content/strings.json conforms to the content-token contract", () => {
  const obj = JSON.parse(readFileSync(at("content/strings.json"), "utf8"));
  assert.deepEqual(validateContentTokens(obj), []);
});

test("the org guarantees its community-health defaults", () => {
  const missing = validateOrgDefaults((p) => existsSync(at(p)));
  assert.deepEqual(missing, [], missing.join("; "));
});

test("validators catch violations", () => {
  assert.deepEqual(validateContentTokens({ n: { type: "name", value: "x" } }), []);
  assert.ok(validateContentTokens({ n: { type: "", value: "x" } }).length > 0, "empty type");
  assert.ok(validateContentTokens({ n: { type: "name", value: 1 } }).length > 0, "non-string value");
  assert.ok(validateContentTokens({ n: "nope" }).length > 0, "non-object token");
  assert.ok(validateContentTokens([]).length > 0, "array not object");
  assert.ok(validateOrgDefaults(() => false).length === REQUIRED_COMMUNITY_HEALTH.length, "all missing");
});
