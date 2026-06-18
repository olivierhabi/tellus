// ---------------------------------------------------------------------------
// One-off fix: "Vega Chart 1" in module 263e4c2f was saved in AGGREGATION mode
// with `groupByProperty: null`, so the canvas correctly shows
// "Pick a group-by property for the aggregation." and renders no chart.
//
// This sets a sensible group-by (`status`) on every aggregation-mode Vega Chart
// in the module that has none, so the chart renders immediately against the
// seeded `OlivierOrder` data (status distribution: assigned/closed/open). Goes
// through the real `updateModule` service so the canonical-JSON ETag recomputes
// and B02 schema + semantic validation runs exactly like a normal autosave —
// never a raw SQL write that would desync the stored etag from the definition.
//
// Idempotent: re-running is a no-op once every aggregation chart has a group-by.
//
// Usage: npx tsx src/seeds/fixVegaChartGroupBy.ts
// ---------------------------------------------------------------------------

import "dotenv/config";

import { pool } from "../db";
import {
  getModule,
  getModuleEtag,
  updateModule,
  type Actor,
} from "../services/workshop/moduleService";
import type { UpdateModuleRequest } from "../services/workshop/types";

const TARGET_RID =
  "ri.workshop.main.module.263e4c2f-3ce2-463a-b520-81655942801d";

// A categorical property on `OlivierOrder` with a small, chart-friendly
// cardinality (assigned / closed / open) — an ideal default group-by.
const DEFAULT_GROUP_BY = "status";

type Widget = {
  type?: string;
  config?: { vegaChart?: { dataSource?: string; groupByProperty?: string | null } };
};

async function main(): Promise<void> {
  const current = await getModule(TARGET_RID);
  const { etag } = await getModuleEtag(TARGET_RID);

  // `definition` is the persisted module body (schemaVersion 4).
  const definition = JSON.parse(
    JSON.stringify(current.definition),
  ) as Record<string, unknown> & { widgets?: Widget[] };

  let patched = 0;
  for (const w of definition.widgets ?? []) {
    const vc = w?.config?.vegaChart;
    if (
      w?.type === "vegaChart" &&
      vc &&
      vc.dataSource === "aggregation" &&
      !vc.groupByProperty
    ) {
      vc.groupByProperty = DEFAULT_GROUP_BY;
      patched += 1;
    }
  }

  if (patched === 0) {
    console.log("✅ Nothing to fix — every aggregation Vega Chart already has a group-by.");
    return;
  }

  const actor: Actor = { userId: "seed:fix-vega-groupby" };
  const updated = await updateModule(
    TARGET_RID,
    etag,
    {
      definition: definition as UpdateModuleRequest["definition"],
    },
    actor,
  );

  console.log(`✅ Set group-by "${DEFAULT_GROUP_BY}" on ${patched} Vega Chart widget(s)`);
  console.log(`   module:   ${updated.module.rid}`);
  console.log(`   new etag: ${updated.etag}`);
  console.log(`   open:     /workshop/${updated.module.rid}`);
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("❌ fix failed:", err);
    await pool.end();
    process.exit(1);
  });
