// ---------------------------------------------------------------------------
// Metric Card Showcase Seed
//
// Rewrites the definition of an EXISTING workshop module so it renders ONE
// fully-configured Metric Card widget bound to the `OlivierOrder` object set,
// exercising the documented Metric Card configuration surface
// (https://www.palantir.com/docs/foundry/workshop/widgets-metric-card):
//
//   • A widget LABEL + Card layout (horizontal direction, regular metric size).
//   • Four METRICS over the 746 seeded orders, each a scalar aggregation:
//       1. Total Orders        — count                         → 746
//       2. Units Ordered       — sum(quantity)                 → 39,993
//       3. Avg Unit Price      — avg(unitPrice), "$"+2dp        → $65.63
//            · SECONDARY metric — max(unitPrice)                → $110.00
//            · CONDITIONAL color — ≥ 50 → green
//            · SPARKLINE trend  — avg price by itemName (10 pts)
//       4. Avg Days Until Due  — avg(daysUntilDue), 1dp + " d"
//            · CONDITIONAL color — < 20 → red (urgent)
//
// The aggregations were verified live against the `ontology-olivierorder`
// OpenSearch index (quantity/unitPrice/daysUntilDue are mapped `integer`), so
// every metric renders a real value.
//
// Binds a doc-faithful objectSet variable (the same shape the editor authors),
// so the frontend registry hydrates it and the persisted `config.metricCard`
// round-trips on reload.
//
// Idempotent: re-running re-reads the etag each run and re-writes the same
// definition (never 412s). Goes through the real service layer (`updateModule`)
// so the B02 schema + semantic validation runs exactly as a normal autosave
// would.
//
// Usage: npm run seed:metric-card
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

// The target module from the task. Must already exist (created via the editor).
const TARGET_RID =
  "ri.workshop.main.module.2149847b-192e-4719-be80-98285958ebe1";

// Object type that carries seeded instance data in this ontology (746 rows).
const OBJECT_TYPE = "OlivierOrder";
const VAR_ID = "v_osv_metric";
const WIDGET_ID = "w_osv_metric";
const ROOT_SECTION = "s_root";

/** Doc-faithful objectSet variable (matches `objectSetVariableToDocEntry`). */
function objectSetVariable(): Record<string, unknown> {
  const displayName = "[Olivier] Orders";
  return {
    id: VAR_ID,
    type: "objectSet",
    definitionType: "objectSetDefinition",
    displayName,
    definition: {
      objectTypeApiName: OBJECT_TYPE,
      startingObjectType: OBJECT_TYPE,
      displayName,
      filters: [],
      filterVariableIds: [],
      traversals: [],
      combinedSetIds: [],
    },
  };
}

/** A complete `MetricFormat` (every field present, as the editor writes it). */
function fmt(
  partial: Partial<{
    decimals: number;
    prefix: string;
    suffix: string;
    abbreviate: boolean;
    percent: boolean;
    grouping: boolean;
  }>,
): Record<string, unknown> {
  return {
    decimals: 0,
    prefix: "",
    suffix: "",
    abbreviate: false,
    percent: false,
    grouping: true,
    ...partial,
  };
}

/** The full `config.metricCard` blob (matches `MetricCardConfig`). */
function metricCardConfig(): Record<string, unknown> {
  return {
    widgetLabel: "[Olivier] Orders — Key Metrics",
    direction: "horizontal",
    size: "regular",
    metrics: [
      {
        id: "m_total_orders",
        label: "Total Orders",
        description: "All orders in the bound object set.",
        aggregation: "count",
        aggregationProperty: null,
        format: fmt({ grouping: true }),
        thresholds: [],
        showSecondary: false,
        secondaryAggregation: "count",
        secondaryProperty: null,
        trendProperty: null,
      },
      {
        id: "m_units_ordered",
        label: "Units Ordered",
        description: "Total quantity summed across every order.",
        aggregation: "sum",
        aggregationProperty: "quantity",
        format: fmt({ grouping: true }),
        thresholds: [],
        showSecondary: false,
        secondaryAggregation: "count",
        secondaryProperty: null,
        trendProperty: null,
      },
      {
        id: "m_avg_price",
        label: "Avg Unit Price",
        description: "Average unit price; the secondary value is the max, and the sparkline is the average price per item type.",
        aggregation: "avg",
        aggregationProperty: "unitPrice",
        format: fmt({ prefix: "$", decimals: 2 }),
        // Conditional formatting: a healthy average (≥ $50) renders green.
        thresholds: [{ op: "gte", value: 50, color: "#1F8C6D" }],
        showSecondary: true,
        secondaryAggregation: "max",
        secondaryProperty: "unitPrice",
        // Sparkline: avg(unitPrice) grouped by itemName → 10 points.
        trendProperty: "itemName",
      },
      {
        id: "m_avg_days_due",
        label: "Avg Days Until Due",
        description: "Average days remaining until an order is due — lower is more urgent.",
        aggregation: "avg",
        aggregationProperty: "daysUntilDue",
        format: fmt({ decimals: 1, suffix: " d" }),
        // Conditional formatting: an urgent average (< 20 days) renders red.
        thresholds: [{ op: "lt", value: 20, color: "#C23030" }],
        showSecondary: false,
        secondaryAggregation: "count",
        secondaryProperty: null,
        trendProperty: null,
      },
    ],
  };
}

/** Build the full module definition (schemaVersion 4): one Metric Card bound to
 *  the OlivierOrder object set, in the root section. */
function buildDefinition(): Record<string, unknown> {
  return {
    schemaVersion: 4,
    displayName: "Metric Card — [Olivier] Orders",
    header: { title: "Metric Card — [Olivier] Orders" },
    layout: { rootSection: ROOT_SECTION },
    variables: [objectSetVariable()],
    widgets: [
      {
        id: WIDGET_ID,
        type: "metricCard",
        config: {
          layoutColumn: ROOT_SECTION,
          metricCard: metricCardConfig(),
        },
        inputs: { objectSet: VAR_ID },
      },
    ],
    sections: [
      {
        id: ROOT_SECTION,
        layout: "rows",
        children: [{ kind: "widget", ref: WIDGET_ID }],
      },
    ],
  };
}

async function main() {
  const current = await getModule(TARGET_RID);
  const { etag } = await getModuleEtag(TARGET_RID);

  const definition = buildDefinition();
  const actor: Actor = { userId: "seed:metric-card-showcase" };

  // Goes through full B02 validation (schema + semantic rules) — fails loudly
  // if the definition is malformed.
  const updated = await updateModule(
    TARGET_RID,
    etag,
    {
      displayName: "Metric Card — [Olivier] Orders",
      definition: definition as UpdateModuleRequest["definition"],
    },
    actor,
  );

  console.log("✅ Metric Card showcase seeded");
  console.log(`   module:    ${updated.module.rid}`);
  console.log(`   ontology:  ${current.ontologyRid}`);
  console.log(`   object:    ${OBJECT_TYPE} (bound via ${VAR_ID})`);
  console.log(`   widget:    1 × metricCard, 4 metrics (count/sum/avg/avg)`);
  console.log(`   new etag:  ${updated.etag}`);
  console.log(`   open:      /workshop/${updated.module.rid}`);
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("❌ Metric Card showcase seed failed:", err);
    await pool.end();
    process.exit(1);
  });
