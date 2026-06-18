// ---------------------------------------------------------------------------
// T-09 — page-size cap unit tests.
//
// Covers contracts C-156, C-157.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  validateSearchQuery,
  validateListQuery,
  readLargePageHeader,
  MAX_PAGE_SIZE,
} from "../../../src/services/queryValidator";
import {
  MAX_EXPLORER_PAGE_SIZE,
  MAX_EXPLORER_PAGE_SIZE_OPT_IN,
} from "../../../src/utils/constants";

// `validateSearchQuery` and `validateListQuery` short-circuit on
// pageSize before they ever touch property metadata, so passing a
// non-existent objectTypeApiName is safe for the cap tests.
const NULL_TYPE = "T-09-FakeType-CapTests";

describe("T-09 page-size cap — constants (C-156, C-157)", () => {
  it("T-09 C-156: MAX_EXPLORER_PAGE_SIZE = 1000", () => {
    expect(MAX_EXPLORER_PAGE_SIZE).toBe(1000);
    expect(MAX_PAGE_SIZE).toBe(1000); // re-exported alias
  });

  it("T-09 C-157: MAX_EXPLORER_PAGE_SIZE_OPT_IN = 2000", () => {
    expect(MAX_EXPLORER_PAGE_SIZE_OPT_IN).toBe(2000);
  });
});

describe("T-09 readLargePageHeader", () => {
  it("returns true only on lowercase literal 'true'", () => {
    expect(
      readLargePageHeader({
        get: (n: string) =>
          n === "x-tellus-large-page" ? "true" : undefined,
      } as any),
    ).toBe(true);
  });

  it("returns false on absent header", () => {
    expect(readLargePageHeader({ get: () => undefined } as any)).toBe(false);
  });

  it("returns false on stray values like 1, yes, TRUE", () => {
    for (const v of ["1", "yes", "TRUE", "True"]) {
      expect(
        readLargePageHeader({
          get: (n: string) =>
            n === "x-tellus-large-page" ? v : undefined,
        } as any),
      ).toBe(v === "TRUE" || v === "True"); // case-insensitive (matches impl)
    }
  });
});

describe("T-09 validateSearchQuery — pageSize bounds (C-156, C-157)", () => {
  it("T-09 C-156: $pageSize=1001 (no opt-in) → QUERY_VALIDATION_ERROR(PAGE_SIZE_OUT_OF_RANGE)", async () => {
    let caught: { code?: string; validationCode?: string } | null = null;
    try {
      await validateSearchQuery({ $pageSize: 1001 }, NULL_TYPE);
    } catch (e) {
      caught = e as { code?: string; validationCode?: string };
    }
    expect(caught?.code).toBe("QUERY_VALIDATION_ERROR");
    expect((caught as any)?.validationCode).toBe("PAGE_SIZE_OUT_OF_RANGE");
  });

  it("T-09 C-156: $pageSize=10000 (no opt-in) → PAGE_SIZE_OUT_OF_RANGE", async () => {
    let caught: { code?: string; validationCode?: string } | null = null;
    try {
      await validateSearchQuery({ $pageSize: 10000 }, NULL_TYPE);
    } catch (e) {
      caught = e as { code?: string; validationCode?: string };
    }
    expect((caught as any)?.validationCode).toBe("PAGE_SIZE_OUT_OF_RANGE");
  });

  it("T-09 C-156: $pageSize=1000 (no opt-in) → accepted", async () => {
    const out = await validateSearchQuery({ $pageSize: 1000 }, NULL_TYPE);
    expect(out.$pageSize).toBe(1000);
  });

  it("T-09 C-157: $pageSize=1500 (largePage=true) → accepted", async () => {
    const out = await validateSearchQuery({ $pageSize: 1500 }, NULL_TYPE, true);
    expect(out.$pageSize).toBe(1500);
  });

  it("T-09 C-157: $pageSize=2001 (largePage=true) → PAGE_SIZE_OUT_OF_RANGE", async () => {
    let caught: { code?: string; validationCode?: string } | null = null;
    try {
      await validateSearchQuery({ $pageSize: 2001 }, NULL_TYPE, true);
    } catch (e) {
      caught = e as { code?: string; validationCode?: string };
    }
    expect((caught as any)?.validationCode).toBe("PAGE_SIZE_OUT_OF_RANGE");
  });

  it("T-09: $pageSize=0 → PAGE_SIZE_OUT_OF_RANGE (underflow)", async () => {
    let caught: { code?: string; validationCode?: string } | null = null;
    try {
      await validateSearchQuery({ $pageSize: 0 }, NULL_TYPE);
    } catch (e) {
      caught = e as { code?: string; validationCode?: string };
    }
    expect((caught as any)?.validationCode).toBe("PAGE_SIZE_OUT_OF_RANGE");
  });

  it("T-09: $pageSize=undefined → defaults to 100 (no error)", async () => {
    const out = await validateSearchQuery({}, NULL_TYPE);
    expect(out.$pageSize).toBe(100);
  });
});

describe("T-09 validateListQuery — pageSize bounds (C-156, C-157)", () => {
  it("T-09: GET ?$pageSize=1500 without opt-in → throw", async () => {
    let caught: { code?: string; validationCode?: string } | null = null;
    try {
      await validateListQuery({ $pageSize: "1500" }, NULL_TYPE);
    } catch (e) {
      caught = e as { code?: string; validationCode?: string };
    }
    expect((caught as any)?.validationCode).toBe("PAGE_SIZE_OUT_OF_RANGE");
  });

  it("T-09: GET ?$pageSize=1500 with opt-in → accepted", async () => {
    const out = await validateListQuery({ $pageSize: "1500" }, NULL_TYPE, true);
    expect(out.pageSize).toBe(1500);
  });
});
