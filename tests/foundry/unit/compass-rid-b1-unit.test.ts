/**
 * B1 — RID library unit tests.
 *
 * Source contracts: tasks/files-projects/contracts.md (B1-C-01 .. B1-C-05,
 *                   B1-C-30, B1-C-42).
 * Spec:             tasks/files-projects/files-projects-tasks.md:47-138.
 *
 * Pure unit tests — no DB, no Docker. They run in `pnpm test:unit`.
 *
 * Each `describe` block cites the contract IDs it proves and explains *what
 * would fail if the contract were violated*. Tests must fail when the
 * implementation regresses; tautological "presence" assertions are forbidden
 * by the brief.
 */

import { describe, expect, it } from "vitest";
import {
  RID_REGEX,
  ROOT_SPACE_RID,
  assertRid,
  formatRid,
  isRid,
  isUuidV4Locator,
  mintRid,
  parseRid,
  tryParseRid,
  unsafeAsRid,
  InvalidRidFormatError,
  type Rid,
} from "../../../src/lib/rid";

// Examples taken from Blueprint §1.2 (Compass Replication Blueprint) and the
// task spec's literal RID strings (e.g. lines 105, 168-170, 519-520, 836).
const SPEC_RIDS = [
  "ri.compass.main.project.123e4567-e89b-42d3-a456-426614174000",
  "ri.compass.main.compass-folder.6d3f2c1a-b7e0-4d34-89ab-12cb47011fa1",
  "ri.compass.main.foundry-dataset.a1b2c3d4-e5f6-4789-9abc-def012345678",
  "ri.compass.main.space.00000000-0000-0000-0000-000000000000",
  "ri.branch..branch.4e5f6a7b-8c9d-4e0f-9a1b-2c3d4e5f6a7b",
  "ri.ontology.main.ontology.1234abcd-5678-4ef0-9123-456789abcdef",
  "ri.object-set.main.versioned-object-set.aaaaaaaa-bbbb-4ccc-9ddd-eeeeffff0000",
  "ri.foundry.dev.dataset.fa11ba00-cafe-4b0b-9000-1234deadbeef",
];

describe("B1-C-01 / B1-C-02 — parseRid grammar (round-trips spec examples)", () => {
  for (const rid of SPEC_RIDS) {
    it(`accepts ${rid}`, () => {
      // If parseRid rejects a valid spec RID, the regex / structure check is
      // wrong — the entire downstream system will refuse to address its own
      // resources. This is the highest-leverage assertion in B1.
      const parsed = parseRid(rid);
      expect(parsed).toMatchObject({
        service: expect.any(String),
        instance: expect.any(String),
        type: expect.any(String),
        locator: expect.any(String),
      });
      // Round-trip property: B1-C-03.
      expect(formatRid(parsed)).toBe(rid);
    });
  }

  it("preserves an empty instance segment (default-instance form)", () => {
    const parsed = parseRid("ri.branch..branch.4e5f6a7b-8c9d-4e0f-9a1b-2c3d4e5f6a7b");
    expect(parsed.instance).toBe("");
    expect(formatRid(parsed)).toBe("ri.branch..branch.4e5f6a7b-8c9d-4e0f-9a1b-2c3d4e5f6a7b");
  });

  it("preserves a multi-dot locator (e.g., versioned suffix)", () => {
    // The grammar's locator is `.+`, so dots inside the locator are legal.
    const rid = "ri.compass.main.project.legacy.7d6c5b4a-3e2f-41ab-8c9d-0a1b2c3d4e5f";
    const parsed = parseRid(rid);
    expect(parsed.locator).toBe("legacy.7d6c5b4a-3e2f-41ab-8c9d-0a1b2c3d4e5f");
    expect(formatRid(parsed)).toBe(rid);
  });
});

describe("B1-C-02 — parseRid rejects malformed RIDs (every test must fail when the check is removed)", () => {
  // Pair of (input, expected reason fragment). We inspect the error to ensure
  // the right *check* fired — otherwise a buggy implementation that always
  // throws would pass these tests.
  const negatives: Array<{ input: unknown; reasonContains: string }> = [
    { input: "", reasonContains: "empty" },
    { input: "not-a-rid", reasonContains: "grammar" },
    { input: "ri.compass.main.project", reasonContains: "grammar" }, // missing locator
    { input: "ri.Compass.main.project.x", reasonContains: "grammar" }, // uppercase service
    { input: "ri.compass.MAIN.project.x", reasonContains: "grammar" }, // uppercase instance
    { input: "ri.compass.main.PROJECT.x", reasonContains: "grammar" }, // uppercase type
    { input: "ri..main.project.x", reasonContains: "grammar" }, // empty service
    { input: "ri.compass.main..x", reasonContains: "grammar" }, // empty type
    { input: "ri.-bad.main.project.x", reasonContains: "grammar" }, // service starts with '-'
    { input: "ri.compass.main.project.", reasonContains: "grammar" }, // empty locator
    { input: 42, reasonContains: "string" },
    { input: null, reasonContains: "string" },
    { input: undefined, reasonContains: "string" },
    { input: "ri.compass.main.project." + "x".repeat(2000), reasonContains: "ceiling" },
  ];

  for (const { input, reasonContains } of negatives) {
    it(`rejects ${JSON.stringify(input)} (reason ~ "${reasonContains}")`, () => {
      let caught: unknown = null;
      try {
        parseRid(input);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(InvalidRidFormatError);
      const err = caught as InvalidRidFormatError;
      // B1-C-30: error code is `INVALID_RID_FORMAT (400)`.
      expect(err.errorCode).toBe("INVALID_RID_FORMAT");
      expect(err.statusCode).toBe(400);
      // The reason must reflect *which* check failed — not a generic
      // catch-all. This makes the test fail meaningfully on regressions.
      expect(err.parameters.reason.toLowerCase()).toContain(reasonContains);
    });
  }
});

describe("B1-C-04 — mintRid produces UUIDv4-locator RIDs that round-trip", () => {
  it("emits an empty-instance RID by default", () => {
    const rid = mintRid("compass", "project");
    const parsed = parseRid(rid);
    expect(parsed).toMatchObject({ service: "compass", instance: "", type: "project" });
    expect(isUuidV4Locator(parsed.locator)).toBe(true);
  });

  it("honours an explicit non-empty instance", () => {
    const rid = mintRid("compass", "project", { instance: "shadow" });
    expect(parseRid(rid).instance).toBe("shadow");
  });

  it("preserves an explicit locator override (used by backfill)", () => {
    const rid = mintRid("compass", "project", { locator: "legacy-1234" });
    expect(parseRid(rid).locator).toBe("legacy-1234");
  });

  it("rejects an invalid service argument before producing a RID", () => {
    expect(() => mintRid("Bad-Service", "project")).toThrow(InvalidRidFormatError);
  });

  it("emits 50 unique RIDs in a row (no UUID collisions across calls)", () => {
    const rids = new Set<string>();
    for (let i = 0; i < 50; i++) rids.add(mintRid("compass", "project"));
    expect(rids.size).toBe(50);
  });
});

describe("B1-C-03 — formatRid validates each component independently", () => {
  it("rejects an invalid service", () => {
    expect(() => formatRid({ service: "BAD", instance: "", type: "project", locator: "x" })).toThrow(
      InvalidRidFormatError,
    );
  });
  it("rejects an empty locator", () => {
    expect(() => formatRid({ service: "compass", instance: "", type: "project", locator: "" })).toThrow(
      InvalidRidFormatError,
    );
  });
  it("accepts the canonical empty-instance shape", () => {
    expect(formatRid({ service: "branch", instance: "", type: "branch", locator: "x" })).toBe("ri.branch..branch.x");
  });
});

describe("B1-C-05 — branding & guard helpers", () => {
  it("isRid returns true for a valid RID and false otherwise", () => {
    expect(isRid("ri.compass.main.project.aaaaaaaa-bbbb-4ccc-9ddd-eeeeffff0000")).toBe(true);
    expect(isRid("nope")).toBe(false);
    expect(isRid(null)).toBe(false);
  });

  it("assertRid narrows a string to Rid or throws", () => {
    const candidate: unknown = "ri.compass.main.project.aaaaaaaa-bbbb-4ccc-9ddd-eeeeffff0000";
    assertRid(candidate);
    // After assertRid, `candidate` is typed as `Rid`. The next line type-checks only because of the narrowing.
    const branded: Rid = candidate;
    expect(branded.startsWith("ri.")).toBe(true);

    expect(() => assertRid("nope")).toThrow(InvalidRidFormatError);
  });

  it("unsafeAsRid is a no-op brand cast (use only for trusted DB-derived strings)", () => {
    const branded = unsafeAsRid("ri.compass.main.project.aaaaaaaa-bbbb-4ccc-9ddd-eeeeffff0000");
    expect(branded).toBe("ri.compass.main.project.aaaaaaaa-bbbb-4ccc-9ddd-eeeeffff0000");
  });
});

describe("RID_REGEX is the single source of truth (DB CHECK and runtime parser must agree)", () => {
  it("matches every spec example", () => {
    for (const rid of SPEC_RIDS) {
      expect(RID_REGEX.test(rid)).toBe(true);
    }
  });

  it("rejects every malformed example", () => {
    for (const bad of [
      "",
      "ri",
      "ri.compass.main.project",
      "ri.compass.main.project.",
      "ri..main.project.x",
      "ri.compass.main..x",
      "ri.compass.main.PROJECT.x",
    ]) {
      expect(RID_REGEX.test(bad)).toBe(false);
    }
  });
});

describe("ROOT_SPACE_RID is the well-known root space RID", () => {
  it("matches the literal seed value used by the migration", () => {
    expect(ROOT_SPACE_RID).toBe("ri.compass.main.space.00000000-0000-0000-0000-000000000000");
    expect(parseRid(ROOT_SPACE_RID).type).toBe("space");
  });
});

describe("tryParseRid", () => {
  it("returns ParsedRid for valid input", () => {
    expect(tryParseRid(SPEC_RIDS[0])).not.toBeNull();
  });
  it("returns null for invalid input (no throw)", () => {
    expect(tryParseRid("nope")).toBeNull();
    expect(tryParseRid(123)).toBeNull();
  });
});
