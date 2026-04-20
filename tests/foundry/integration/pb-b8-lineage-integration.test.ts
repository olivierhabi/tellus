// ---------------------------------------------------------------------------
// PB-B8 — dataset lineage + Funnel auto-fire (integration).
//
// Covers:
//   * insertEdge idempotency + cycle detection (LINEAGE_CYCLE_DETECTED).
//   * walk() returns bounded DAG.
//   * findObjectTypesFor returns the backing-datasource OT mapping.
//   * Depth-10 walk over 1000 synthetic datasets completes < 500 ms
//     (acceptance d).
//   * sendSignal fingerprint dedupes on (pipeline_id, ot) tuples —
//     acceptance (e).
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import foundryDb from "../../../src/config/foundryDb";
import {
  DatasetLineageService,
} from "../../../src/services/pipelines/datasetLineage";

const STAMP = Date.now();
let dbUp = false;
let userId = "";
let projectId = "";
let ds: Record<string, string> = {};
let svc: DatasetLineageService;
const createdDatasetIds: string[] = [];

async function makeDataset(name: string): Promise<string> {
  const [row] = await foundryDb("foundry_datasets")
    .insert({
      name,
      project_id: projectId,
      file_path: `fake/${randomUUID()}.parquet`,
      format: "parquet",
    })
    .returning("*");
  createdDatasetIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  try {
    await foundryDb.raw("SELECT 1");
    dbUp = true;
  } catch (err) {
    console.warn(`[pb-b8] Postgres unreachable: ${(err as Error).message}`);
    return;
  }
  const [user] = await foundryDb("users")
    .insert({
      email: `pb-b8-${STAMP}@tellus.local`,
      password_hash: "x",
      display_name: `PB-B8 ${STAMP}`,
    })
    .returning("*");
  userId = user.id;
  const [project] = await foundryDb("projects")
    .insert({ name: `pb-b8-${STAMP}`, owner_id: userId })
    .returning("*");
  projectId = project.id;
  svc = new DatasetLineageService(foundryDb);

  // Small fixture graph:  A → B → C
  ds.a = await makeDataset(`a-${STAMP}`);
  ds.b = await makeDataset(`b-${STAMP}`);
  ds.c = await makeDataset(`c-${STAMP}`);
});

afterAll(async () => {
  if (!dbUp) return;
  await foundryDb("dataset_lineage")
    .whereIn("downstream_dataset_id", createdDatasetIds)
    .orWhereIn("upstream_dataset_id", createdDatasetIds)
    .del();
  if (createdDatasetIds.length)
    await foundryDb("foundry_datasets").whereIn("id", createdDatasetIds).del();
  if (projectId) await foundryDb("projects").where({ id: projectId }).del();
  if (userId) await foundryDb("users").where({ id: userId }).del();
  await foundryDb.destroy();
});

describe("PB-B8 lineage service", () => {
  it("insertEdge is idempotent on (downstream, upstream, edge_type)", async () => {
    if (!dbUp) return;
    const first = await svc.insertEdge({
      downstreamDatasetId: ds.b,
      upstreamDatasetId: ds.a,
      edgeType: "pipeline_output",
    });
    const second = await svc.insertEdge({
      downstreamDatasetId: ds.b,
      upstreamDatasetId: ds.a,
      edgeType: "pipeline_output",
    });
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
  });

  it("walk(downstream, depth=5) returns the two-hop DAG", async () => {
    if (!dbUp) return;
    await svc.insertEdge({
      downstreamDatasetId: ds.c,
      upstreamDatasetId: ds.b,
      edgeType: "pipeline_output",
    });
    const graph = await svc.walk(ds.a, "downstream", 5);
    const ids = new Set(graph.nodes.map((n) => n.id));
    expect(ids.has(ds.a)).toBe(true);
    expect(ids.has(ds.b)).toBe(true);
    expect(ids.has(ds.c)).toBe(true);
    // Edges are (from=upstream, to=downstream) per the API.
    const edgePairs = graph.edges.map((e) => `${e.from}->${e.to}`);
    expect(edgePairs).toContain(`${ds.a}->${ds.b}`);
    expect(edgePairs).toContain(`${ds.b}->${ds.c}`);
  });

  it("(c) inserting an edge that closes a cycle throws LINEAGE_CYCLE_DETECTED", async () => {
    if (!dbUp) return;
    try {
      await svc.insertEdge({
        // Existing: A → B → C. Inserting C → A would close a cycle.
        downstreamDatasetId: ds.a,
        upstreamDatasetId: ds.c,
        edgeType: "pipeline_output",
      });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("LINEAGE_CYCLE_DETECTED");
    }
  });

  it("(d) depth-10 walk on 1000-dataset DAG is bounded under 500 ms (PB-B8.follow-scale)", async () => {
    if (!dbUp) return;
    // Build a 1000-node linear chain d0 → d1 → … → d999 via a single
    // bulk insert. Individual inserts go through insertEdge's cycle
    // check which is O(depth) per call — too slow for 1000 nodes.
    // We bypass for the fixture because the chain is provably acyclic
    // by construction; runtime writes still go through insertEdge.
    const N = 1000;
    const batchIds: string[] = [];
    const rows: Array<{ id: string; name: string; project_id: string; file_path: string }> = [];
    for (let i = 0; i < N; i++) {
      const id = randomUUID();
      batchIds.push(id);
      rows.push({
        id,
        name: `scale-${STAMP}-${i}`,
        project_id: projectId,
        file_path: `fake/scale-${i}.parquet`,
      });
    }
    // Chunk the dataset insert to keep parameter count reasonable.
    for (let off = 0; off < rows.length; off += 200) {
      await foundryDb("foundry_datasets").insert(rows.slice(off, off + 200));
    }
    createdDatasetIds.push(...batchIds);
    const edgeRows = [];
    for (let i = 1; i < batchIds.length; i++) {
      edgeRows.push({
        downstream_dataset_id: batchIds[i],
        upstream_dataset_id: batchIds[i - 1],
        edge_type: "pipeline_output",
        edge_metadata: JSON.stringify({}),
      });
    }
    for (let off = 0; off < edgeRows.length; off += 500) {
      await foundryDb("dataset_lineage").insert(edgeRows.slice(off, off + 500));
    }

    // Warm the planner cache with one throwaway walk so the timing
    // measurement sees steady-state I/O.
    await svc.walk(batchIds[0], "downstream", 2);

    const t0 = Date.now();
    const g = await svc.walk(batchIds[0], "downstream", 10);
    const elapsed = Date.now() - t0;
    // depth=10 → exactly 11 nodes reachable from d0 in a straight chain.
    expect(g.nodes.length).toBe(11);
    // Covering-index target: < 500 ms on a 1000-node graph. If this
    // regresses in CI, check dataset_lineage.idx_dataset_lineage_upstream
    // is still present and VACUUM ANALYZE has run.
    expect(elapsed).toBeLessThan(500);
    // eslint-disable-next-line no-console
    console.log(`[pb-b8 scale] depth-10 walk over ${N}-node DAG: ${elapsed}ms`);
  }, 60_000);

  it("findObjectTypesFor returns OT mappings via backing_datasource.dataset_id", async () => {
    if (!dbUp) return;
    // Minimal OT + backing_datasource fixture.
    const ontologyId = `88888888-8888-8888-8888-${STAMP.toString(16).padStart(12, "0").slice(-12)}`;
    await foundryDb.raw(
      `INSERT INTO ontology (ontology_id, display_name, description, created_by)
         VALUES (?, ?, 'pb-b8 lineage fixture', 'vitest')
         ON CONFLICT DO NOTHING`,
      [ontologyId, `pb-b8-${STAMP}`],
    );
    const [ot] = await foundryDb("object_type")
      .insert({
        ontology_id: ontologyId,
        api_name: `LineageOt${STAMP}`,
        display_name: `lineage ot ${STAMP}`,
        status: "experimental",
      })
      .returning("*");
    // backing_datasource.dataset_id FKs to the legacy `dataset` table
    // (not `foundry_datasets`), so we match via file_path — that's
    // why findObjectTypesFor does a dual-match in PB-B8.
    const fdRow = await foundryDb("foundry_datasets")
      .where({ id: ds.c })
      .first("file_path");
    const [bd] = await foundryDb("backing_datasource")
      .insert({
        object_type_id: ot.object_type_id,
        dataset_name: `lineage-${STAMP}`,
        file_path: fdRow.file_path,
        file_format: "parquet",
        column_mapping: JSON.stringify({}),
        primary_key_column: "pk",
      })
      .returning("*");
    try {
      const hits = await svc.findObjectTypesFor(ds.c);
      expect(hits).toEqual([
        {
          ontologyId,
          objectTypeApiName: `LineageOt${STAMP}`,
          datasourceId: bd.mapping_id,
        },
      ]);
    } finally {
      await foundryDb("backing_datasource").where({ mapping_id: bd.mapping_id }).del();
      await foundryDb("object_type").where({ object_type_id: ot.object_type_id }).del();
      await foundryDb("ontology").where({ ontology_id: ontologyId }).del();
    }
  });

  it("(e) Funnel signal fingerprint dedupes two deploys in quick succession", async () => {
    if (!dbUp) return;
    const ontologyId = `77777777-7777-7777-7777-${STAMP.toString(16).padStart(12, "0").slice(-12)}`;
    await foundryDb.raw(
      `INSERT INTO ontology (ontology_id, display_name, description, created_by)
         VALUES (?, ?, 'pb-b8 signal-dedup fixture', 'vitest')
         ON CONFLICT DO NOTHING`,
      [ontologyId, `pb-b8-dedup-${STAMP}`],
    );
    const apiName = `DedupOt${STAMP}`;
    const [ot] = await foundryDb("object_type")
      .insert({
        ontology_id: ontologyId,
        api_name: apiName,
        display_name: `dedup ${STAMP}`,
        status: "experimental",
      })
      .returning("*");
    const { sendSignal } = await import("../../../src/services/funnel/durableWorkflow");
    const deploymentId = randomUUID();
    const fingerprint = `${deploymentId}-${ontologyId}-${apiName}`;
    const sid1 = await sendSignal({
      ontologyId,
      objectTypeApiName: apiName,
      signalType: "sourceTransactionCommitted",
      payload: { from: "pb-b8-test-1" },
      fingerprint,
    });
    const sid2 = await sendSignal({
      ontologyId,
      objectTypeApiName: apiName,
      signalType: "sourceTransactionCommitted",
      payload: { from: "pb-b8-test-2" },
      fingerprint,
    });
    expect(sid2).toBe(sid1); // same signal id → dedup via fingerprint
    await foundryDb("funnel_signal").where({ signal_id: sid1 }).del();
    await foundryDb("object_type").where({ object_type_id: ot.object_type_id }).del();
    await foundryDb("ontology").where({ ontology_id: ontologyId }).del();
  });
});
