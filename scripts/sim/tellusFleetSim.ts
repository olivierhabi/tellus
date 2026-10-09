// ---------------------------------------------------------------------------
// Simulated Tellus fleet — replaces the retired shared `tellus_db` as the
// place where production-shaped funnel state is exercised.
// Decision record: docs/adr/2026-10-09-funnel-fleet-simulation.md.
//
// Seeds one object type per scenario into the CURRENT (lane / test) database
// + object store, drives the real changelog → merge activities where the
// scenario needs live data, and plants the legacy states the close-out fixes
// must now surface (ghost runs, dead leases, orphan staging, …). It returns
// the violations `checkFunnelInvariants` is EXPECTED to report, so a test (or
// the CLI) can assert the checker finds exactly the planted failures and no
// false positives on the healthy types.
//
// Destructive: callers must run assertDestructiveTestEnvironment first (the
// CLI and the integration test both do). Never point this at production.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import type { InvariantCode } from "../../src/services/funnel/funnelInvariants";

export const SCENARIOS = [
  "healthy",
  "wide_unicode",
  "ghost_legacy",
  "malformed_marker",
  "dangling_locator",
  "header_only",
  "stale_lease",
  "stalled",
  "orphan_staging",
  "null_provenance",
  "count_drift",
  "properties_differ",
  "properties_differ_replayed",
] as const;
export type Scenario = (typeof SCENARIOS)[number];

export interface SimOptions {
  /** api_name prefix; every seeded object type starts with it. */
  prefix: string;
  ontologyId: string;
  environmentId: string;
  /** Object-store key prefix (must contain '/'). */
  keyPrefix: string;
  healthyRows?: number;
  duplicateRatio?: number;
  seed?: number;
}

export interface ScenarioResult {
  apiName: string;
  objectTypeId: string;
  passes: Array<{ rowsEmitted: number; objectsIndexed: number; upserts: number }>;
  pipelineError: string | null;
  /** Self-checks done by the seeder against an independent JS model. */
  modelChecks: { expectedRows: number; liveRows: number; sampledMismatches: number } | null;
}

export interface SimFleet {
  scenarios: Record<Scenario, ScenarioResult>;
}

type Db = typeof import("../../src/db");
type Storage = typeof import("../../src/services/storageService");
type Acts = typeof import("../../src/services/funnel/temporal/activities");

/** Violations the checker must report for a seeded fleet. */
export function expectedViolations(
  fleet: SimFleet,
  sourceProbed: boolean,
): Array<{ code: InvariantCode; objectTypeApiName: string }> {
  const n = (s: Scenario) => fleet.scenarios[s].apiName;
  const out: Array<{ code: InvariantCode; objectTypeApiName: string }> = [
    { code: sourceProbed ? "GHOST_INDEXED_EMPTY" : "GHOST_SUSPECT", objectTypeApiName: n("ghost_legacy") },
    { code: "MALFORMED_LOCATOR", objectTypeApiName: n("malformed_marker") },
    { code: sourceProbed ? "DANGLING_LOCATOR" : "GHOST_SUSPECT", objectTypeApiName: n("dangling_locator") },
    { code: "STALE_LEASE", objectTypeApiName: n("stale_lease") },
    { code: "STALLED_PROGRESS", objectTypeApiName: n("stalled") },
    { code: "ORPHAN_STAGING", objectTypeApiName: n("orphan_staging") },
    { code: "NULL_PROVENANCE", objectTypeApiName: n("null_provenance") },
    { code: "COUNT_DRIFT", objectTypeApiName: n("count_drift") },
    { code: "REPLAY_REQUIRED", objectTypeApiName: n("properties_differ") },
  ];
  // A header-only source legitimately indexes nothing; only without the
  // storage probe can the checker not tell it apart from a ghost.
  if (!sourceProbed) out.push({ code: "GHOST_SUSPECT", objectTypeApiName: n("header_only") });
  return out.sort((a, b) => `${a.code}/${a.objectTypeApiName}`.localeCompare(`${b.code}/${b.objectTypeApiName}`));
}

// ---- deterministic data -----------------------------------------------------

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function csvCell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function toCsv(header: string[], rows: string[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}

/** Columns deliberately NOT in jsonb key order (jsonb sorts by length, then
 *  bytes) — the shape that broke merge verification before canonicalJson. */
const HEALTHY_HEADER = ["zeta_status", "id", "alpha_amount", "mid", "b"];

export function generateHealthyRows(
  n: number,
  dupRatio: number,
  seed: number,
): { rows: string[][]; lastWins: Map<string, string[]> } {
  const rnd = prng(seed);
  const rows: string[][] = [];
  const lastWins = new Map<string, string[]>();
  let next = 1;
  for (let i = 0; i < n; i++) {
    const reuse = i > 0 && rnd() < dupRatio;
    const id = reuse ? String(1 + Math.floor(rnd() * (next - 1))) : String(next++);
    const row = [
      ["open", "closed", "pending"][Math.floor(rnd() * 3)],
      id,
      (rnd() * 10_000).toFixed(2),
      `m-${i}`,
      String(Math.floor(rnd() * 100)),
    ];
    rows.push(row);
    lastWins.set(id, row);
  }
  return { rows, lastWins };
}

function wideUnicodeCsv(): { csv: string; expect: Map<string, Record<string, string>> } {
  const header = ["id", ...Array.from({ length: 23 }, (_, i) => `c${String(i).padStart(2, "0")}`)];
  const samples = [
    "plain",
    "comma, inside",
    'quote "inside"',
    "multi\nline",
    "Kinyarwanda: Murakoze cyane",
    "日本語テキスト",
    "emoji 🚀✅",
    "  padded  ",
    "trailing\\backslash",
    "ümlaut-ß",
  ];
  const rows: string[][] = [];
  const expect = new Map<string, Record<string, string>>();
  for (let i = 1; i <= 200; i++) {
    const row = [String(i), ...header.slice(1).map((_, j) => `${samples[(i + j) % samples.length]}#${i}`)];
    rows.push(row);
    expect.set(String(i), Object.fromEntries(header.map((h, j) => [h, row[j]])));
  }
  return { csv: toCsv(header, rows), expect };
}

// ---- seeding ----------------------------------------------------------------

export async function seedSimulatedFleet(opts: SimOptions): Promise<SimFleet> {
  if (!opts.keyPrefix.includes("/")) throw new Error("keyPrefix must contain '/'");
  const db: Db = await import("../../src/db");
  const storage: Storage = await import("../../src/services/storageService");
  const acts: Acts = await import("../../src/services/funnel/temporal/activities");
  const { funnelRuntimeConfig } = await import("../../src/config/funnelRuntime");
  const cfg = funnelRuntimeConfig();
  const healthyRows = opts.healthyRows ?? 5_000;
  const dupRatio = opts.duplicateRatio ?? 0.1;
  const seed = opts.seed ?? 20261009;
  await storage.ensureBucket();

  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const scenarios = {} as Record<Scenario, ScenarioResult>;

  async function createType(s: Scenario): Promise<ScenarioResult> {
    const apiName = `${opts.prefix}_${s}`;
    const r = await db.query(
      `INSERT INTO object_type (ontology_id, api_name, display_name, status)
       VALUES ($1, $2, $3, 'experimental') RETURNING object_type_id::text`,
      [opts.ontologyId, apiName, `Sim ${s}`],
    );
    const res: ScenarioResult = {
      apiName,
      objectTypeId: String(r.rows[0].object_type_id),
      passes: [],
      pipelineError: null,
      modelChecks: null,
    };
    scenarios[s] = res;
    return res;
  }

  async function attachSource(
    t: ScenarioResult,
    body: string | null,
    locator?: (key: string) => string,
  ): Promise<string> {
    const key = `${opts.keyPrefix}/${t.apiName}.csv`;
    if (body !== null) await storage.uploadObject(key, Buffer.from(body, "utf8"), "text/csv");
    const filePath = locator
      ? locator(key)
      : `${key}#foundry-dataset:${randomUUID()}#object-type:${t.objectTypeId}`;
    await db.query(
      `INSERT INTO backing_datasource
         (object_type_id, dataset_name, file_path, file_format, column_mapping, primary_key_column)
       VALUES ($1, $2, $3, 'csv', '{}'::jsonb, 'id')`,
      [t.objectTypeId, `sim_${t.apiName}`.toLowerCase(), filePath],
    );
    return key;
  }

  async function pass(t: ScenarioResult): Promise<void> {
    const ctx = {
      ontologyId: opts.ontologyId,
      objectTypeApiName: t.apiName,
      objectTypeRid: t.objectTypeId,
      environmentId: opts.environmentId,
    };
    try {
      const cl = await acts.runChangelogActivity(ctx);
      const m = await acts.runMergeActivity({
        ...ctx,
        changelogSnapshotId: cl.snapshotId,
        changelogOwnedProperties: cl.ownedProperties,
      });
      t.passes.push({ rowsEmitted: cl.rowsEmitted, objectsIndexed: m.objectsIndexed, upserts: m.upserts });
      // What the workflow's indexing stage records on success.
      await setState(t, { status: "indexed", objectsIndexed: m.objectsIndexed });
    } catch (err) {
      t.pipelineError = err instanceof Error ? err.message : String(err);
    }
  }

  async function setState(
    t: ScenarioResult,
    s: { status: string; objectsIndexed: number; lease?: string | null; progress?: string | null },
  ): Promise<void> {
    await db.query(
      `INSERT INTO funnel_state (object_type_id, status, objects_indexed, environment_id,
                                 lease_heartbeat_at, last_progress_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (object_type_id) DO UPDATE
         SET status = EXCLUDED.status, objects_indexed = EXCLUDED.objects_indexed,
             environment_id = EXCLUDED.environment_id, lease_heartbeat_at = EXCLUDED.lease_heartbeat_at,
             last_progress_at = EXCLUDED.last_progress_at, updated_at = now()`,
      [t.objectTypeId, s.status, s.objectsIndexed, opts.environmentId, s.lease ?? null, s.progress ?? null],
    );
  }

  async function live(t: ScenarioResult): Promise<Map<string, Record<string, unknown>>> {
    const r = await db.query(
      `SELECT primary_key, properties FROM object_instances WHERE ontology_id = $1 AND object_type_api_name = $2`,
      [opts.ontologyId, t.apiName],
    );
    return new Map(r.rows.map((x) => [String(x.primary_key), x.properties as Record<string, unknown>]));
  }

  function compare(
    t: ScenarioResult,
    got: Map<string, Record<string, unknown>>,
    want: Map<string, Record<string, string>>,
  ): void {
    let mismatches = 0;
    const keys = [...want.keys()];
    const step = Math.max(1, Math.floor(keys.length / 50));
    for (let i = 0; i < keys.length; i += step) {
      const g = got.get(keys[i]);
      const w = want.get(keys[i])!;
      if (!g || Object.entries(w).some(([k, v]) => String(g[k]) !== v)) mismatches++;
    }
    t.modelChecks = { expectedRows: want.size, liveRows: got.size, sampledMismatches: mismatches };
  }

  const asRecord = (row: string[]) => Object.fromEntries(HEALTHY_HEADER.map((h, j) => [h, row[j]]));

  // healthy — dup-heavy, non-jsonb key order; full pass then incremental
  // pass (5 % of keys changed, 1 % new) as a fresh full snapshot.
  {
    const t = await createType("healthy");
    const { rows, lastWins } = generateHealthyRows(healthyRows, dupRatio, seed);
    const key = await attachSource(t, toCsv(HEALTHY_HEADER, rows));
    await pass(t);
    compare(t, await live(t), new Map([...lastWins].map(([k, v]) => [k, asRecord(v)])));
    if (!t.pipelineError) {
      const rnd = prng(seed + 1);
      const v2 = new Map(lastWins);
      const ids = [...v2.keys()];
      for (const id of ids) if (rnd() < 0.05) v2.set(id, [...v2.get(id)!.slice(0, 3), `m-upd-${id}`, "999"]);
      const extra = Math.max(1, Math.round(ids.length * 0.01));
      let max = Math.max(...ids.map(Number));
      for (let i = 0; i < extra; i++) {
        const id = String(++max);
        v2.set(id, ["open", id, "1.00", `m-new-${id}`, "0"]);
      }
      await storage.uploadObject(key, Buffer.from(toCsv(HEALTHY_HEADER, [...v2.values()]), "utf8"), "text/csv");
      await pass(t);
      compare(t, await live(t), new Map([...v2].map(([k, v]) => [k, asRecord(v)])));
    }
  }

  // wide_unicode — 24 columns, quotes/commas/newlines/CJK/emoji.
  {
    const t = await createType("wide_unicode");
    const { csv, expect } = wideUnicodeCsv();
    await attachSource(t, csv);
    await pass(t);
    compare(t, await live(t), expect);
  }

  // ghost_legacy — pre-fix silent zero-row run: source has data, state says
  // indexed with 0 objects, nothing live.
  {
    const t = await createType("ghost_legacy");
    await attachSource(t, toCsv(HEALTHY_HEADER, generateHealthyRows(50, 0, seed).rows));
    await setState(t, { status: "indexed", objectsIndexed: 0 });
  }

  // malformed_marker — the run must now FAIL loudly; legacy state planted.
  {
    const t = await createType("malformed_marker");
    await attachSource(t, toCsv(HEALTHY_HEADER, generateHealthyRows(20, 0, seed).rows), (k) =>
      `${k}#foundry-dataset:not-a-uuid#object-type:${t.objectTypeId}`,
    );
    await pass(t);
    await setState(t, { status: "indexed", objectsIndexed: 0 });
  }

  // dangling_locator — well-formed marker, object never uploaded.
  {
    const t = await createType("dangling_locator");
    await attachSource(t, null);
    await pass(t);
    await setState(t, { status: "indexed", objectsIndexed: 0 });
  }

  // header_only — legitimately empty source; must not be called a ghost
  // once storage is probed.
  {
    const t = await createType("header_only");
    await attachSource(t, `${HEALTHY_HEADER.join(",")}\n`);
    await pass(t);
    await setState(t, { status: "indexed", objectsIndexed: 0 });
  }

  // stale_lease — owner died mid-index.
  {
    const t = await createType("stale_lease");
    await setState(t, {
      status: "indexing",
      objectsIndexed: 0,
      lease: ago(cfg.indexingDeadAfterMs * 2),
      progress: ago(cfg.indexingDeadAfterMs * 2),
    });
  }

  // stalled — owner alive (fresh lease) but no forward progress.
  {
    const t = await createType("stalled");
    await setState(t, {
      status: "indexing",
      objectsIndexed: 0,
      lease: ago(1_000),
      progress: ago(cfg.indexingStallAfterMs * 2),
    });
  }

  // orphan_staging — a crashed promote left a staging run behind (plus a
  // fresh, in-flight run that must NOT be flagged).
  {
    const t = await createType("orphan_staging");
    const { deriveMainBranchId } = await import("../../src/services/branchContext");
    const branch = deriveMainBranchId(opts.ontologyId);
    for (const [run, at] of [
      [randomUUID(), ago(cfg.mergeCliTimeoutMs * 2)],
      [randomUUID(), ago(1_000)],
    ] as const) {
      for (let i = 1; i <= 3; i++) {
        await db.query(
          `INSERT INTO merge_staging_instances
             (staging_run_id, ontology_id, branch_id, object_type_api_name, primary_key,
              operation, properties, markings, staged_at)
           VALUES ($1, $2, $3, $4, $5, 'upsert', '{}'::jsonb, '{}', $6)`,
          [run, opts.ontologyId, branch, t.apiName, String(i), at],
        );
      }
    }
  }

  // null_provenance — rows whose source transaction was lost.
  {
    const t = await createType("null_provenance");
    await attachSource(t, toCsv(HEALTHY_HEADER, generateHealthyRows(30, 0, seed).rows));
    await pass(t);
    await db.query(
      `UPDATE object_instances SET source_transaction_id = NULL
        WHERE ontology_id = $1 AND object_type_api_name = $2 AND primary_key IN ('1', '2')`,
      [opts.ontologyId, t.apiName],
    );
  }

  // count_drift — state disagrees with the live table.
  {
    const t = await createType("count_drift");
    await attachSource(t, toCsv(HEALTHY_HEADER, generateHealthyRows(30, 0, seed).rows));
    await pass(t);
    const n = t.passes[t.passes.length - 1]?.objectsIndexed ?? 0;
    await setState(t, { status: "indexed", objectsIndexed: n + 7 });
  }

  // properties_differ(_replayed) — historical failure from the jsonb
  // key-order bug; replaying the same CSV now succeeds. Only the replayed
  // one has a later completed run on record.
  for (const s of ["properties_differ", "properties_differ_replayed"] as const) {
    const t = await createType(s);
    await attachSource(t, toCsv(HEALTHY_HEADER, generateHealthyRows(40, 0.2, seed).rows));
    await db.query(
      `INSERT INTO funnel_run (ontology_id, object_type_api_name, status, current_stage, error_message,
                               environment_id, started_at, completed_at)
       VALUES ($1, $2, 'failed', 'merge',
               'merge staging verification failed: properties differ for 40 sampled rows',
               $3, now() - interval '2 hours', now() - interval '2 hours')`,
      [opts.ontologyId, t.apiName, opts.environmentId],
    );
    await pass(t);
    if (s === "properties_differ_replayed" && !t.pipelineError) {
      await db.query(
        `INSERT INTO funnel_run (ontology_id, object_type_api_name, status, current_stage, objects_indexed,
                                 environment_id, started_at, completed_at)
         VALUES ($1, $2, 'completed', 'hydration', $3, $4, now() - interval '1 minute', now())`,
        [opts.ontologyId, t.apiName, t.passes[t.passes.length - 1]?.objectsIndexed ?? 0, opts.environmentId],
      );
    }
  }

  return { scenarios };
}

/** Remove every row/object the simulator created for `prefix`. */
export async function cleanupSimulatedFleet(opts: Pick<SimOptions, "prefix" | "keyPrefix">): Promise<void> {
  const db: Db = await import("../../src/db");
  const storage: Storage = await import("../../src/services/storageService");
  const like = `${opts.prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const q = (sql: string) => db.query(sql, [like]).catch(() => undefined);
  await q(`DELETE FROM object_instances WHERE object_type_api_name LIKE $1`);
  await q(`DELETE FROM merge_staging_instances WHERE object_type_api_name LIKE $1`);
  await q(
    `DELETE FROM funnel_stage_run WHERE run_id IN (SELECT run_id FROM funnel_run WHERE object_type_api_name LIKE $1)`,
  );
  await q(`DELETE FROM funnel_run WHERE object_type_api_name LIKE $1`);
  await q(`DELETE FROM funnel_signal WHERE object_type_api_name LIKE $1`);
  await q(
    `DELETE FROM funnel_state WHERE object_type_id IN (SELECT object_type_id FROM object_type WHERE api_name LIKE $1)`,
  );
  await q(
    `DELETE FROM backing_datasource WHERE object_type_id IN (SELECT object_type_id FROM object_type WHERE api_name LIKE $1)`,
  );
  await q(`DELETE FROM object_type WHERE api_name LIKE $1`);
  await storage.deletePrefix(`${opts.keyPrefix}/`).catch(() => undefined);
}
