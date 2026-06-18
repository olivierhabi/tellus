// =============================================================================
// B05 — Object set load proxy unit tests
//
// Spec §B05 acceptance:
//   - forwards executionMode, snapshotConsistency, branch and JWT verbatim
//   - rejects pageSize <=0 and > MAX
//   - compiles filters into the predicate tree (B07)
//
// Contract IDs:
//   B05 C-01: forwards branch + JWT + executionMode + snapshotConsistency
//   B05 C-02: rejects pageSize <= 0 / NaN / > MAX_PAGE_SIZE
//   B05 C-03: compiles filter list using B07 (passes through to OSS)
//   B05 C-04: empty filter list → matchAll predicate
// =============================================================================

import { describe, expect, it, beforeEach } from "vitest";
import {
  loadObjectSet,
  MAX_PAGE_SIZE,
} from "../../../src/services/workshop/objectSetService.js";
import {
  RecordingOssAdapter,
  setOss,
  type OssRequestContext,
} from "../../../src/services/workshop/ossAdapter.js";
import type { PropertyType } from "../../../src/services/workshop/filterCompiler.js";
import { WorkshopError } from "../../../src/services/workshop/errors.js";

const SCHEMA: Record<string, PropertyType> = {
  itemName: "string",
  status: "string",
};
const CTX: OssRequestContext = {
  jwt: "jwt-test",
  branchRid: "ri.branch.b1",
  userRid: "u1",
};

let oss: RecordingOssAdapter;
beforeEach(() => {
  oss = new RecordingOssAdapter();
  setOss(oss);
});

describe("B05 C-01: forwards branch + JWT + executionMode + snapshotConsistency verbatim", () => {
  it("OSS adapter receives the same context object", async () => {
    await loadObjectSet(
      {
        ontologyRid: "o1",
        objectTypeApiName: "Order",
        schema: SCHEMA,
        filters: [],
        pageSize: 100,
        executionMode: "PREFER_SPEED",
        snapshotConsistency: "STRONG",
      },
      CTX,
    );
    expect(oss.calls).toHaveLength(1);
    const c = oss.calls[0]!;
    expect(c.kind).toBe("load");
    expect(c.context).toEqual(CTX);
    const r = c.request as { executionMode?: string; snapshotConsistency?: string };
    expect(r.executionMode).toBe("PREFER_SPEED");
    expect(r.snapshotConsistency).toBe("STRONG");
  });
});

describe("B05 C-02: pageSize bounds", () => {
  it.each([0, -1, NaN, Number.POSITIVE_INFINITY])(
    "rejects pageSize=%s with InvalidPageSize",
    async (bad) => {
      try {
        await loadObjectSet(
          {
            ontologyRid: "o1",
            objectTypeApiName: "Order",
            schema: SCHEMA,
            filters: [],
            pageSize: bad as number,
          },
          CTX,
        );
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(WorkshopError);
        expect((err as WorkshopError).errorName).toBe(
          "Tellus:Workshop:InvalidPageSize",
        );
      }
    },
  );
  it("rejects > MAX_PAGE_SIZE with PageSizeTooLarge", async () => {
    try {
      await loadObjectSet(
        {
          ontologyRid: "o1",
          objectTypeApiName: "Order",
          schema: SCHEMA,
          filters: [],
          pageSize: MAX_PAGE_SIZE + 1,
        },
        CTX,
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkshopError);
      expect((err as WorkshopError).errorName).toBe(
        "Tellus:Workshop:PageSizeTooLarge",
      );
    }
  });
});

describe("B05 C-03: filter compilation passthrough", () => {
  it("OSS sees compiled predicate, not raw filters", async () => {
    await loadObjectSet(
      {
        ontologyRid: "o1",
        objectTypeApiName: "Order",
        schema: SCHEMA,
        filters: [
          { uiKind: "string-eq", property: "itemName", value: ["x"] },
          { uiKind: "enum-multi", property: "status", value: ["new"] },
        ],
        pageSize: 100,
      },
      CTX,
    );
    const c = oss.calls[0]!;
    const r = c.request as { predicate?: { type: string; clauses?: unknown[] } };
    expect(r.predicate?.type).toBe("and");
    expect(r.predicate?.clauses).toHaveLength(2);
  });
});

describe("B05 C-04: empty filters → matchAll", () => {
  it("predicate is matchAll", async () => {
    await loadObjectSet(
      {
        ontologyRid: "o1",
        objectTypeApiName: "Order",
        schema: SCHEMA,
        filters: [],
        pageSize: 100,
      },
      CTX,
    );
    const c = oss.calls[0]!;
    const r = c.request as { predicate?: { type: string } };
    expect(r.predicate?.type).toBe("matchAll");
  });
});
