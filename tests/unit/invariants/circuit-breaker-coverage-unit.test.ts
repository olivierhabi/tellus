// ---------------------------------------------------------------------------
// F-P4-11 invariant — every external dependency boundary in `src/`
// must be wrapped with the shared `withBreaker` primitive. If a new
// call site appears without breaker coverage, or somebody reverts a
// wrapping to raw `pool.query` / `client.eval` / etc., this test
// fails.
//
// Negative test: remove the `import { withBreaker } from ...` line
// (or delete any single `withBreaker(` call) from any of the files
// listed below and this suite fails. Verified by toggling each during
// development.
//
// This is a static scan — the lifecycle test at
// tests/unit/resilience/circuitBreaker-unit.test.ts asserts the
// primitive's correctness; this test asserts the wiring stays in
// place.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../../..");

interface Site {
  file: string;
  /** Label passed to withBreaker that must appear. */
  label: string;
  /** One identifier expected to appear inside the breaker scope. */
  wrappedCallHint: string;
}

const SITES: Site[] = [
  {
    file: "src/db.ts",
    label: "PG_BREAKER_LABEL",
    wrappedCallHint: "pool.query",
  },
  {
    file: "src/services/keycloakAdminService.ts",
    label: "'kc'",
    wrappedCallHint: "fetch(",
  },
  {
    file: "src/services/kafkaProducer.ts",
    label: "KAFKA_BREAKER_LABEL",
    wrappedCallHint: "p.send",
  },
  {
    file: "src/services/storageService.ts",
    label: "S3_BREAKER_LABEL",
    wrappedCallHint: "origSend",
  },
  {
    file: "src/services/rateLimit/redisRateLimiter.ts",
    label: "REDIS_BREAKER_LABEL",
    wrappedCallHint: "client.eval",
  },
];

describe("F-P4-11 | critical-dependency call sites are breaker-wrapped", () => {
  it.each(SITES)(
    "$file imports withBreaker and wraps its dependency call",
    ({ file, label, wrappedCallHint }) => {
      const absolute = path.join(REPO_ROOT, file);
      const source = readFileSync(absolute, "utf8");

      expect(
        /from\s+['"][^'"]*resilience\/circuitBreaker['"]/.test(source),
        `${file}: missing import of withBreaker from src/resilience/circuitBreaker`,
      ).toBe(true);

      expect(
        /withBreaker\s*\(/.test(source),
        `${file}: no withBreaker(...) call found`,
      ).toBe(true);

      expect(
        source.includes(label),
        `${file}: expected breaker label ${label} not present`,
      ).toBe(true);

      expect(
        source.includes(wrappedCallHint),
        `${file}: expected wrapped call containing '${wrappedCallHint}' not present`,
      ).toBe(true);
    },
  );
});
