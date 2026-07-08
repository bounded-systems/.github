/**
 * @module
 * The org-defaults contract — the semantics of what bounded-systems/.github
 * guarantees org-wide. Two pieces of static data get a checkable schema:
 *
 *   1. content/strings.json — the content-token map ({ key: { type, value } }),
 *      the source the org's content-token catalog aggregates.
 *   2. the community-health defaults every repo inherits (CODE_OF_CONDUCT,
 *      CONTRIBUTING, SECURITY, the profile README).
 *
 * Dependency-free — the same "schema as contract" the org's Zod specs express,
 * kept plain so it runs anywhere. org-defaults.test.mjs validates the real files.
 */

// ── content tokens (content/strings.json) ────────────────────────────────────

/** A content token: a typed, named string the sites/tooling resolve. */
export function validateContentTokens(obj) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return ["strings.json must be an object of { key: { type, value } } tokens"];
  }
  const errs = [];
  for (const [key, tok] of Object.entries(obj)) {
    if (tok === null || typeof tok !== "object" || Array.isArray(tok)) {
      errs.push(`${key}: not a token object`);
      continue;
    }
    if (typeof tok.type !== "string" || tok.type.length === 0) {
      errs.push(`${key}: token.type must be a non-empty string`);
    }
    if (typeof tok.value !== "string") {
      errs.push(`${key}: token.value must be a string`);
    }
  }
  return errs;
}

// ── org-defaults manifest ────────────────────────────────────────────────────

/** The community-health defaults .github guarantees org-wide. */
export const REQUIRED_COMMUNITY_HEALTH = [
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "profile/README.md",
];

/** Validate the org guarantees its defaults; `has(path)` reports presence. */
export function validateOrgDefaults(has) {
  return REQUIRED_COMMUNITY_HEALTH
    .filter((f) => !has(f))
    .map((f) => `missing org default: ${f}`);
}
