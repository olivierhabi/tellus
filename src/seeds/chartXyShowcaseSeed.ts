// ---------------------------------------------------------------------------
// Chart XY Showcase Seed
//
// Rewrites the definition of an EXISTING workshop module so it renders the
// `/test53` analysis-widget demo — three stacked Chart XY panels — bound to the
// `OlivierOrder` object set (746 seeded rows), exercising the documented
// Chart XY configuration surface
// (https://www.palantir.com/docs/foundry/workshop/widgets-chart):
//
//   1. HORIZONTAL STACKED BAR — "# of Orders by Assignee"
//        X = assignee, segment by = status, count; bars stacked, sorted by
//        value (busiest assignee first), value labels on, selection-as-filter.
//        (Mirrors test53 chart 1: "# of Alerts by Type".)
//   2. STACKED AREA — "# of Orders by Due Date"
//        X = orderDueDate, segment by = status, count; areas stacked, legend
//        on the right.  (Mirrors test53 chart 2: "# of Alerts by Year".)
//   3. SCATTER — "# of Orders over Time"
//        X = orderDueDate, segment by = status, count; ontology colors.
//        (Mirrors test53 chart 3: "# of Alerts by Time of Delay".)
//
// test53 is flight-alert themed (alert type × aircraft, by year, time-of-delay),
// but OlivierOrder is an orders type — so the THREE chart TYPES are reproduced
// over OlivierOrder's REAL categorical fields (no schema/data changes). The BE
// `terms` aggregation is keyword-only, so the axes are the categorical
// properties `assignee` / `status` / `orderDueDate` (numeric fields like
// quantity / daysUntilDue return no buckets). Verified live against the
// `ontology-olivierorder` OpenSearch index: terms(assignee)×status and
// terms(orderDueDate)×status both return real buckets.
//
// Binds ONE doc-faithful objectSet variable (the same shape the editor authors)
// shared by all three widgets — each carries its own persisted `config.chartXY`
// (round-trips on reload via the frontend registry now that `chartXY` is a
// first-class PersistedWidgetType).
//
// Idempotent: re-running re-reads the etag each run and re-writes the same
// definition (never 412s). Goes through the real service layer (`updateModule`)
// so the B02 schema + semantic validation runs exactly as a normal autosave
// would (the validator already recognises `chartXY:objectSet`).
//
// Usage: npm run seed:chart-xy
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
  "ri.workshop.main.module.000e4fb9-e12f-432a-a2a0-1e970f12b551";

// Object type that carries seeded instance data in this ontology (746 rows).
const OBJECT_TYPE = "OlivierOrder";
const VAR_ID = "v_osv_chart";
const ROOT_SECTION = "s_root";

const DISPLAY_NAME = "Chart XY — [Olivier] Orders (test53 demo)";

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

/** Complete `ChartXYConfig` (every field present, as the editor writes it). */
function chartConfig(
  partial: Record<string, unknown>,
): Record<string, unknown> {
  return {
    chartType: "bar",
    orientation: "horizontal",
    barMode: "grouped",
    xProperty: null,
    xAxisTitle: "",
    aggregation: "count",
    aggregationProperty: null,
    yAxisTitle: "",
    segmentByProperty: null,
    seriesName: "",
    seriesOverrides: {},
    areaStacked: false,
    categorySort: "label-asc",
    valueScale: "linear",
    valueMin: null,
    valueMax: null,
    valueFormat: {
      enabled: false,
      decimals: null,
      grouping: true,
      notation: "standard",
    },
    nullHandling: "zeroes",
    showValueLabels: false,
    showLegend: true,
    legendPosition: "top",
    enableOntologyColors: false,
    enableSelectionFilter: false,
    ...partial,
  };
}

/** The three panels — one chartXY widget per child section so each hydrates
 *  into its own slot (`config.layoutColumn` = the section id). */
const PANELS: Array<{
  section: string;
  widget: string;
  config: Record<string, unknown>;
}> = [
  {
    section: "s_chart_bar",
    widget: "w_chart_bar",
    // test53 chart 1 — horizontal stacked bar, count by assignee × status.
    config: chartConfig({
      chartType: "bar",
      orientation: "horizontal",
      barMode: "stacked",
      xProperty: "assignee",
      xAxisTitle: "Assignee",
      segmentByProperty: "status",
      yAxisTitle: "# of Orders",
      categorySort: "value-desc",
      showValueLabels: true,
      legendPosition: "top",
      enableSelectionFilter: true,
    }),
  },
  {
    section: "s_chart_area",
    widget: "w_chart_area",
    // test53 chart 2 — stacked area, count by orderDueDate × status.
    config: chartConfig({
      chartType: "area",
      areaStacked: true,
      xProperty: "orderDueDate",
      xAxisTitle: "Due Date",
      segmentByProperty: "status",
      yAxisTitle: "# of Orders",
      categorySort: "label-asc",
      legendPosition: "right",
    }),
  },
  {
    section: "s_chart_scatter",
    widget: "w_chart_scatter",
    // test53 chart 3 — scatter, count by orderDueDate × status (ontology colors).
    config: chartConfig({
      chartType: "scatter",
      xProperty: "orderDueDate",
      xAxisTitle: "Due Date",
      segmentByProperty: "status",
      yAxisTitle: "# of Orders",
      categorySort: "label-asc",
      legendPosition: "top",
      enableOntologyColors: true,
    }),
  },
];

/** Build the full module definition (schemaVersion 4): three Chart XY widgets,
 *  one per child section, all bound to the shared OlivierOrder object set. */
function buildDefinition(): Record<string, unknown> {
  return {
    schemaVersion: 4,
    displayName: DISPLAY_NAME,
    header: { title: DISPLAY_NAME },
    layout: { rootSection: ROOT_SECTION },
    variables: [objectSetVariable()],
    widgets: PANELS.map((p) => ({
      id: p.widget,
      type: "chartXY",
      config: { layoutColumn: p.section, chartXY: p.config },
      inputs: { objectSet: VAR_ID },
    })),
    sections: [
      {
        id: ROOT_SECTION,
        layout: "rows",
        children: PANELS.map((p) => ({ kind: "section", ref: p.section })),
      },
      ...PANELS.map((p) => ({
        id: p.section,
        layout: "rows",
        children: [{ kind: "widget", ref: p.widget }],
      })),
    ],
  };
}

async function main() {
  const current = await getModule(TARGET_RID);
  const { etag } = await getModuleEtag(TARGET_RID);

  const definition = buildDefinition();
  const actor: Actor = { userId: "seed:chart-xy-showcase" };

  // Goes through full B02 validation (schema + semantic rules) — fails loudly
  // if the definition is malformed.
  const updated = await updateModule(
    TARGET_RID,
    etag,
    {
      displayName: DISPLAY_NAME,
      definition: definition as UpdateModuleRequest["definition"],
    },
    actor,
  );

  console.log("✅ Chart XY showcase seeded");
  console.log(`   module:    ${updated.module.rid}`);
  console.log(`   ontology:  ${current.ontologyRid}`);
  console.log(`   object:    ${OBJECT_TYPE} (bound via ${VAR_ID})`);
  console.log(`   widgets:   3 × chartXY (stacked bar / stacked area / scatter)`);
  console.log(`   new etag:  ${updated.etag}`);
  console.log(`   open:      /workshop/${updated.module.rid}`);
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("❌ Chart XY showcase seed failed:", err);
    await pool.end();
    process.exit(1);
  });
