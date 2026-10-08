// ---------------------------------------------------------------------------
// STAGE 4 — indexed security lane. REAL PG + OpenSearch.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { query } from "../../src/db";
import { countLinks, joinTableBaseDir } from "../../src/services/linkResolverService";
import { buildSecurityFilter } from "../../src/middleware/securityContext";
import { client as osClient } from "../../src/services/opensearch/client";
import { getIndexName } from "../../src/services/opensearch/indexMappingGenerator";
import { ensureOsv2IndexTemplate } from "./_harness";

const ONT = "00000000-0000-0000-0000-000000000001";

function shim(markings: string[]) {
  return {
    userId: "osv2-di",
    markings: markings,
    organizations: [],
    cbac: [],
    markingMode: "disjunctive" as const,
    systemPrincipal: false,
    markingBypass: false,
  };
}

describe("STAGE 4 — indexed security lane", () => {
  it("M2M JOIN-table count no longer leaks: markings-restricted targets don't COUNT", async () => {
    await ensureOsv2IndexTemplate();
    const tagr = `s4_${randomUUID().slice(0, 6)}`;
    const srcOt = `${tagr}s`;
    const tgtOt = `${tagr}t`;
    const ltApi = `${tagr}l`;
    // Seed object types.
    await query(
      `INSERT INTO object_type (object_type_id, ontology_id, api_name, display_name, version) VALUES
        ($1, $2, $3, $3, 1), ($4, $2, $5, $5, 1)`,
      [randomUUID(), ONT, srcOt, randomUUID(), tgtOt],
    );
    // Target docs: only ONE (t-public) stamped "PUBLIC".
    const idx = getIndexName(tgtOt);
    await osClient.index({ index: idx, body: { __pk: "t-public", __objectType: tgtOt, _security: { markings: ["PUBLIC"] } }, refresh: "wait_for" });
    await osClient.index({ index: idx, body: { __pk: "t-secret", __objectType: tgtOt, _security: { markings: ["SECRET"] } }, refresh: "wait_for" });

    // CSV-join file with TWO edges: s1→t-public + s1→t-secret:
    // The join-table reader refuses paths outside joinTableBaseDir()
    // (path-traversal guard), so the fixture CSV must live under it.
    const joinDir = joinTableBaseDir();
    fs.mkdirSync(joinDir, { recursive: true });
    const tmp = path.join(joinDir, `${tagr.replace(/[^a-zA-Z0-9]/g, "_")}.csv`);
    fs.writeFileSync(tmp, "source,target\ns1,t-public\ns1,t-secret\n");
    // Register a link type with the join file.
    const lt = {
      link_type_id: randomUUID(),
      ontology_id: ONT,
      api_name: ltApi,
      display_name: ltApi,
      cardinality: "MANY_TO_MANY",
      source_object_type: (await query(`SELECT object_type_id FROM object_type WHERE api_name = $1`, [srcOt])).rows[0].object_type_id,
      target_object_type: (await query(`SELECT object_type_id FROM object_type WHERE api_name = $1`, [tgtOt])).rows[0].object_type_id,
      join_table_file_path: tmp,
      join_table_source_column: "source",
      join_table_target_column: "target",
    };
    await query(
      `INSERT INTO link_type (link_type_id, ontology_id, api_name, display_name, cardinality, source_object_type, target_object_type, join_table_file_path, join_table_source_column, join_table_target_column)
       VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9)`,
      [lt.link_type_id, lt.ontology_id, lt.api_name, lt.cardinality, lt.source_object_type, lt.target_object_type, lt.join_table_file_path, lt.join_table_source_column, lt.join_table_target_column],
    );

    // Simulate the route-shaped "PUBLIC" shim: NOT a bypass subject.
    const sec = buildSecurityFilter(shim(["PUBLIC"]) as never);
    const count = await countLinks(lt, "s1", "forward", sec, null);
    expect(count).toBe(1); // t-public alone — t-secret never counted
    // SUPER bypass: count = 2 (public+secret).
    const secBypass = buildSecurityFilter(shim(["PUBLIC", "SECRET"]) as never);
    const count2 = await countLinks(lt, "s1", "forward", secBypass, null);
    expect(count2).toBe(2);
    fs.unlinkSync(tmp);
  });
});
