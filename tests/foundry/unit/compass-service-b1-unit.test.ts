/**
 * B1 — compassService unit tests (input validation only, no live DB).
 *
 * Source contracts: tasks/files-projects/contracts.md (B1-C-21, B1-C-30, B1-C-32).
 * Spec:             tasks/files-projects/files-projects-tasks.md:47-138.
 *
 * The DB-touching code paths are exercised by the B1 integration test (next
 * iteration). The brief mandates "every error code listed in the taxonomy
 * is reachable from at least one test"; for B1 the three codes are
 * `INVALID_RID_FORMAT`, `RESOURCE_NOT_FOUND`, `BATCH_TOO_LARGE`. This file
 * proves the two that don't require Postgres (`INVALID_RID_FORMAT`,
 * `BATCH_TOO_LARGE`); the integration suite covers `RESOURCE_NOT_FOUND`.
 *
 * Pure unit lane — runs in `pnpm test:unit` (vitest.unit.config.ts).
 */

import { describe, expect, it } from "vitest";

import {
  BATCH_GET_MAX,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  getResource,
  getResourcesBatch,
  getChildren,
  getResourceByPath,
  mintRid,
} from "../../../src/services/compassService";
import { OntologyError } from "../../../src/utils/queryErrors";

const VALID_RID = "ri.compass.main.project.aaaaaaaa-bbbb-4ccc-9ddd-eeeeffff0000";

async function expectOntologyError(
  fn: () => Promise<unknown>,
  code: string,
  status: number,
): Promise<OntologyError> {
  let caught: unknown = null;
  try {
    await fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(OntologyError);
  const err = caught as OntologyError;
  expect(err.code).toBe(code);
  expect(err.statusCode).toBe(status);
  return err;
}

describe("B1-C-30 — getResource: INVALID_RID_FORMAT before any DB call", () => {
  it("rejects empty string", async () => {
    await expectOntologyError(() => getResource(""), "INVALID_RID_FORMAT", 400);
  });
  it("rejects malformed RID", async () => {
    await expectOntologyError(() => getResource("not-a-rid"), "INVALID_RID_FORMAT", 400);
  });
  it("rejects RID with uppercase service segment", async () => {
    await expectOntologyError(
      () => getResource("ri.Compass.main.project.aaaaaaaa-bbbb-4ccc-9ddd-eeeeffff0000"),
      "INVALID_RID_FORMAT",
      400,
    );
  });
});

describe("B1-C-21, B1-C-32 — getResourcesBatch input validation", () => {
  it("BATCH_TOO_LARGE at len = BATCH_GET_MAX + 1", async () => {
    const rids = Array.from({ length: BATCH_GET_MAX + 1 }, () => VALID_RID);
    const err = await expectOntologyError(
      () => getResourcesBatch(rids),
      "BATCH_TOO_LARGE",
      400,
    );
    expect(err.parameters.limit).toBe(BATCH_GET_MAX);
    expect(err.parameters.actual).toBe(BATCH_GET_MAX + 1);
  });

  it("returns an empty Map for [] (no DB round-trip needed)", async () => {
    const out = await getResourcesBatch([]);
    expect(out.size).toBe(0);
  });

  it("rejects a single malformed RID before any DB call", async () => {
    await expectOntologyError(
      () => getResourcesBatch([VALID_RID, "nope", VALID_RID]),
      "INVALID_RID_FORMAT",
      400,
    );
  });
});

describe("B1-C-23 — getChildren input validation", () => {
  it("rejects an invalid parent RID", async () => {
    await expectOntologyError(
      () => getChildren("not-a-rid"),
      "INVALID_RID_FORMAT",
      400,
    );
  });

  it("rejects a non-positive pageSize", async () => {
    await expectOntologyError(
      () => getChildren(VALID_RID, { pageSize: 0 }),
      "VALIDATION_ERROR",
      400,
    );
  });

  it("rejects a non-integer pageSize", async () => {
    await expectOntologyError(
      () => getChildren(VALID_RID, { pageSize: 3.14 }),
      "VALIDATION_ERROR",
      400,
    );
  });

  it("rejects a malformed pageToken", async () => {
    await expectOntologyError(
      () => getChildren(VALID_RID, { pageToken: "not-base64-json" }),
      "INVALID_PAGE_TOKEN",
      400,
    );
  });
});

describe("B1-C-22 — getResourceByPath input validation", () => {
  it("rejects an empty path", async () => {
    await expectOntologyError(
      () => getResourceByPath(""),
      "VALIDATION_ERROR",
      400,
    );
  });

  it("rejects a path that does not start with '/'", async () => {
    await expectOntologyError(
      () => getResourceByPath("Root/X"),
      "VALIDATION_ERROR",
      400,
    );
  });
});

describe("B1-C-21 — page-size constants are exported and within spec", () => {
  it("PAGE_SIZE_DEFAULT is 100 (per spec B3 §234)", () => {
    expect(PAGE_SIZE_DEFAULT).toBe(100);
  });
  it("PAGE_SIZE_MAX is 1000 (per spec B3 §234)", () => {
    expect(PAGE_SIZE_MAX).toBe(1000);
  });
  it("BATCH_GET_MAX is 1000 (per spec B1 §125)", () => {
    expect(BATCH_GET_MAX).toBe(1000);
  });
});

describe("compassService re-exports mintRid for callers' single import surface", () => {
  it("mintRid produces a parseable RID", () => {
    const rid = mintRid("compass", "project");
    expect(rid).toMatch(/^ri\.compass\.\.project\.[0-9a-f-]+$/);
  });
});
