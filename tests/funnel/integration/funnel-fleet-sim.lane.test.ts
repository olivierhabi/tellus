// ---------------------------------------------------------------------------
// Simulated fleet (scripts/sim/tellusFleetSim.ts) × invariant checker
// (src/services/funnel/funnelInvariants.ts).
//
// The shared tellus_db is gone (docs/adr/2026-10-09-funnel-fleet-simulation.md),
// so production-shaped state is seeded here: real changelog → merge passes
// for the healthy types, planted legacy states for each failure mode. The
// checker must report EXACTLY the planted violations — no misses, no false
// positives on healthy, replayed or legitimately empty types.
//
// Lane: vitest.funnel-oop.config.ts only (`.lane.test.ts` is deliberately not
// matched by the full integration lane). There the API server's dispatcher
// tick runs the indexing watchdogs, which would sweep the planted dead/stalled
// locks before the checker looks — the last test below drives those same
// sweepers explicitly and proves they clear what the checker flags.
// ---------------------------------------------------------------------------

import { LANE } from "../../laneEnv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupSimulatedFleet,
  expectedViolations,
  seedSimulatedFleet,
  type SimFleet,
} from "../../../scripts/sim/tellusFleetSim";

const STAMP = Date.now();
const PREFIX = `SimFleet${STAMP}`;
const KEY_PREFIX = `tests/sim-fleet/${STAMP}`;
const ONTOLOGY_ID = "00000000-0000-0000-0000-000000000001";

let fleet: SimFleet;
let db: typeof import("../../../src/db");
let inv: typeof import("../../../src/services/funnel/funnelInvariants");

beforeAll(async () => {
  await (
    await import("../../../src/services/testing/destructiveTestGuard")
  ).assertDestructiveTestEnvironment({ operation: "funnel-fleet-sim", skipApiProbe: true });
  process.env.TELLUS_ENVIRONMENT_ID = LANE.TELLUS_ENVIRONMENT_ID;
  db = await import("../../../src/db");
  inv = await import("../../../src/services/funnel/funnelInvariants");
  const guard = await import("../../../src/services/funnel/environmentGuard");
  await guard.sealDatabaseEnvironment({
    environmentId: LANE.TELLUS_ENVIRONMENT_ID,
    temporalNamespace: "t", temporalTaskQueue: "q", temporalAddress: "x",
    workerBuildId: "test", mode: "local", workerIdentity: "t",
  });
  fleet = await seedSimulatedFleet({
    prefix: PREFIX,
    ontologyId: ONTOLOGY_ID,
    environmentId: LANE.TELLUS_ENVIRONMENT_ID,
    keyPrefix: KEY_PREFIX,
    healthyRows: Number(process.env.TELLUS_SIM_HEALTHY_ROWS ?? 5_000),
  });
}, 600_000);

afterAll(async () => {
  if (db) await cleanupSimulatedFleet({ prefix: PREFIX, keyPrefix: KEY_PREFIX });
});

const shape = (r: { violations: Array<{ code: string; objectTypeApiName: string }> }) =>
  r.violations
    .map((v) => ({ code: v.code, objectTypeApiName: v.objectTypeApiName }))
    .sort((a, b) => `${a.code}/${a.objectTypeApiName}`.localeCompare(`${b.code}/${b.objectTypeApiName}`));

describe("simulated fleet: pipeline behaviour per scenario", () => {
  it("healthy dup-heavy, non-jsonb-key-order source matches the last-wins model on full and incremental passes", () => {
    const h = fleet.scenarios.healthy;
    expect(h.pipelineError).toBeNull();
    expect(h.passes).toHaveLength(2);
    expect(h.modelChecks).not.toBeNull();
    expect(h.modelChecks!.liveRows).toBe(h.modelChecks!.expectedRows);
    expect(h.modelChecks!.sampledMismatches).toBe(0);
    expect(h.passes[1].objectsIndexed).toBe(h.modelChecks!.expectedRows);
  });

  it("wide/unicode/quoted CSV round-trips", () => {
    const w = fleet.scenarios.wide_unicode;
    expect(w.pipelineError).toBeNull();
    expect(w.modelChecks).toEqual({ expectedRows: 200, liveRows: 200, sampledMismatches: 0 });
  });

  it("malformed marker, dangling locator and header-only sources fail loudly instead of indexing 0 rows", () => {
    expect(fleet.scenarios.malformed_marker.pipelineError).toMatch(/malformed marker/);
    expect(fleet.scenarios.dangling_locator.pipelineError).toMatch(/not reachable|NoSuchKey|not found|does not exist/i);
    expect(fleet.scenarios.header_only.pipelineError).toBeTruthy();
    for (const s of ["malformed_marker", "dangling_locator", "header_only"] as const) {
      expect(fleet.scenarios[s].passes).toHaveLength(0);
    }
  });

  it("a source that failed with the jsonb key-order 'properties differ' bug now merges on replay", () => {
    expect(fleet.scenarios.properties_differ.pipelineError).toBeNull();
    expect(fleet.scenarios.properties_differ_replayed.pipelineError).toBeNull();
  });
});

describe("simulated fleet: invariant checker finds exactly the planted violations", () => {
  it("with storage probing (production mode)", async () => {
    const report = await inv.checkFunnelInvariants(db, {
      objectTypeApiNamePrefix: PREFIX,
      sourceProbe: await inv.createStorageSourceProbe(),
    });
    expect(report.objectTypesChecked).toBe(Object.keys(fleet.scenarios).length);
    expect(shape(report)).toEqual(expectedViolations(fleet, true));
    expect(report.errors).toBeGreaterThan(0);
  });

  it("SQL-only (no storage) degrades ghosts to suspects without false negatives", async () => {
    const report = await inv.checkFunnelInvariants(db, { objectTypeApiNamePrefix: PREFIX });
    expect(shape(report)).toEqual(expectedViolations(fleet, false));
  });

  it("healthy, replayed and wide types are clean", async () => {
    const report = await inv.checkFunnelInvariants(db, {
      objectTypeApiNamePrefix: PREFIX,
      sourceProbe: await inv.createStorageSourceProbe(),
    });
    const flagged = new Set(report.violations.map((v) => v.objectTypeApiName));
    for (const s of ["healthy", "wide_unicode", "properties_differ_replayed", "header_only"] as const) {
      expect(flagged.has(fleet.scenarios[s].apiName), s).toBe(false);
    }
  });

  it("the dispatcher's indexing watchdogs clear exactly the lease/stall violations the checker flags", async () => {
    const lease = await import("../../../src/services/funnel/indexingLease");
    await lease.sweepStalledIndexing();
    await lease.sweepDeadIndexingLocks();
    const report = await inv.checkFunnelInvariants(db, {
      objectTypeApiNamePrefix: PREFIX,
      sourceProbe: await inv.createStorageSourceProbe(),
    });
    const remaining = expectedViolations(fleet, true).filter(
      (v) => v.code !== "STALE_LEASE" && v.code !== "STALLED_PROGRESS",
    );
    expect(shape(report)).toEqual(remaining);
    const st = await db.query(
      `SELECT ot.api_name, fs.status, fs.error_message FROM funnel_state fs
         JOIN object_type ot ON ot.object_type_id = fs.object_type_id
        WHERE ot.api_name = ANY($1::text[])`,
      [[fleet.scenarios.stale_lease.apiName, fleet.scenarios.stalled.apiName]],
    );
    expect(st.rows).toHaveLength(2);
    for (const r of st.rows) {
      expect(r.status).toBe("failed");
      expect(String(r.error_message)).toMatch(/^(STALLED|DEAD):/);
    }
  });
});

