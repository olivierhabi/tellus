// ---------------------------------------------------------------------------
// STAGE 5 slice — objects.get production routing via serving mode.
// REAL PG + OpenSearch + the serving_flag machinery.
// ---------------------------------------------------------------------------

import "dotenv/config";
import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { query } from "../../src/db";
import { setServingMode, ensureOsv2IndexTemplate } from "./_harness";
import { client as osClient } from "../../src/services/opensearch/client";
import { getIndexName } from "../../src/services/opensearch/indexMappingGenerator";
import { objectServingStoreGet } from "../../src/services/serving/objectServingStore";
import { pgObjectAsDoc } from "../../src/services/serving/pgObjectAsDoc";
import { executeGetObject } from "../../src/services/queryExecutor";

const ONT = "00000000-0000-0000-0000-000000000001";
const OT = `s5_${randomUUID().slice(0, 6)}`;

async function seedStates() {
  await ensureOsv2IndexTemplate();
  await query(
    `INSERT INTO object_type (object_type_id, ontology_id, api_name, display_name, version) VALUES ($1, $2, $3, $3, 1)`,
    [randomUUID(), ONT, OT],
  );
  // PG perspective:
  await query(
    `INSERT INTO object_instances (ontology_id, object_type_api_name, primary_key, properties, markings, branch_id)
     VALUES ($1, $2, $3, $4::jsonb, ARRAY[$5], $6)`,
    [ONT, OT, "pk-1", JSON.stringify(({ name: "pg-name" })), "PUBLIC", "d66d9ae4-d1ce-582b-89dd-0399ea73da0c"],
  );
  // Indexed perspective (OpenSearch):
  const idx = getIndexName(OT);
  // The indexed path fetches by _id=primaryKey (executeGetObject).
  await osClient.index({ id: "pk-1", index: idx, body: { __pk: "pk-1", __objectType: OT, __ontology: ONT, __version: 1, _security: { markings: ["PUBLIC"] }, name: "pg-name" }, refresh: "wait_for" });
}

describe("STAGE 5 slice #1 — objects.get routed through the flags", () => {
  beforeEach(async () => {
    await seedStates();
  });

  it("legacy mode returns the PG-doc shape; indexed mode returns the index-side document", async () => {
    // Explicit mode per call:
    await setServingMode("capability", "objects.get", "legacy");

    const legacy = await objectServingStoreGet(
      { objectTypeApiName: OT, primaryKey: "pk-1", scope: { tenantId: "default", ontologyId: ONT, branchId: "" } },
      (ot, pk) => pgObjectAsDoc(ONT, ot, pk),
      (args) => executeGetObject(args.objectTypeApiName, args.primaryKey, undefined, null),
    );
    expect((legacy as { __pk?: string })?.__pk).toBe("pk-1");
    expect((legacy as { name?: string }).name).toBe("pg-name");

    await setServingMode("capability", "objects.get", "indexed");

    const indexed = await objectServingStoreGet(
      { objectTypeApiName: OT, primaryKey: "pk-1", scope: { tenantId: "default", ontologyId: ONT, branchId: "" } },
      (ot, pk) => pgObjectAsDoc(ONT, ot, pk),
      (args) => executeGetObject(args.objectTypeApiName, args.primaryKey, undefined, null),
    );
    expect((indexed as { __primaryKey?: string })?.__primaryKey).toBe("pk-1");
    expect(indexed?.__objectType).toBe(OT);
  });
});
