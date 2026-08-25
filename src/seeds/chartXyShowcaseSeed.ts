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
import { createReadContext } from "../services/oss/readContext";

// The target module from the task. Must already exist (created via the editor).
const TARGET_RID =
  "ri.workshop.main.module.000e4fb9-e12f-432a-a2a0-1e970f12b551";

// Object type that carries seeded instance data in this ontology (746 rows).
const OBJECT_TYPE = "OlivierOrder";
const VAR_ID = "v_osv_chart";
const SCALE_VAR_ID = "v_osv_chart_scale";
const UNION_MEMBER_VAR_ID = "v_osv_chart_union_member";
const UNION_VAR_ID = "v_osv_chart_union";
const DELETED_VAR_ID = "v_osv_chart_deleted_source";
const TIME_SERIES_VAR_ID = "v_ts_chart_parity";
const SCENARIO_VAR_ID = "v_scenarios_chart_parity";
const SELECTION_OUTPUT_VAR_ID = "v_chart_metrics_selection";
const DOWNSTREAM_VAR_ID = "v_osv_chart_downstream";
const FUNCTION_2D = "chartXyParityTwoDimensional";
const FUNCTION_3D = "chartXyParityThreeDimensional";
const FUNCTION_NON_POSITIVE = "chartXyParityNonPositive";
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

function downstreamSelectionVariable(): Record<string, unknown> {
  return {
    id: DOWNSTREAM_VAR_ID,
    type: "objectSet",
    definitionType: "objectSetDefinition",
    displayName: "Chart-selected orders",
    definition: {
      objectTypeApiName: OBJECT_TYPE,
      startingObjectType: OBJECT_TYPE,
      sourceVariableId: VAR_ID,
      displayName: "Chart-selected orders",
      filters: [],
      filterVariableIds: [SELECTION_OUTPUT_VAR_ID],
      traversals: [],
      combinedSetIds: [],
    },
  };
}

function scaleObjectSetVariable(): Record<string, unknown> {
  const displayName = "12k Orders";
  return {
    id: SCALE_VAR_ID,
    type: "objectSet",
    definitionType: "objectSetDefinition",
    displayName,
    definition: {
      objectTypeApiName: "OlivierOrderJune",
      startingObjectType: "OlivierOrderJune",
      displayName,
      filters: [],
      filterVariableIds: [],
      traversals: [],
      combinedSetIds: [],
    },
  };
}

function deletedSourceVariable(): Record<string, unknown> {
  return {
    id: DELETED_VAR_ID,
    type: "objectSet",
    definitionType: "objectSetDefinition",
    displayName: "Deleted source fixture",
    definition: {
      objectTypeApiName: "DeletedChartParityObjectType",
      startingObjectType: "DeletedChartParityObjectType",
      displayName: "Deleted source fixture",
      filters: [],
      filterVariableIds: [],
      traversals: [],
      combinedSetIds: [],
    },
  };
}

function unionObjectSetVariables(): Record<string, unknown>[] {
  const make = (id: string, objectType: string, combinedSetIds: string[] = []) => ({
    id,
    type: "objectSet",
    definitionType: "objectSetDefinition",
    displayName: id === UNION_VAR_ID ? "Union Orders" : "Union member Orders",
    definition: {
      objectTypeApiName: objectType,
      startingObjectType: objectType,
      displayName: id === UNION_VAR_ID ? "Union Orders" : "Union member Orders",
      filters: [],
      filterVariableIds: [],
      traversals: [],
      combinedSetIds,
    },
  });
  return [
    make(UNION_MEMBER_VAR_ID, "OlivierOrder1"),
    make(UNION_VAR_ID, "OlivierOrder", [UNION_MEMBER_VAR_ID]),
  ];
}

function timeSeriesVariable(): Record<string, unknown> {
  const start = Date.UTC(2026, 0, 1);
  return {
    id: TIME_SERIES_VAR_ID,
    type: "timeSeriesSet",
    definitionType: "static",
    displayName: "Order volume trend",
    definition: {
      staticValue: [{
        id: "orders",
        name: "Orders",
        points: Array.from({ length: 24 }, (_, index) => ({
          timestamp: new Date(start + index * 86_400_000).toISOString(),
          value: 40 + Math.round(Math.sin(index / 3) * 13) + index,
        })),
      }],
    },
  };
}

function scenarioVariable(scenarioRid: string): Record<string, unknown> {
  return {
    id: SCENARIO_VAR_ID,
    type: "array",
    definitionType: "static",
    displayName: "Chart comparison scenarios",
    definition: {
      staticValue: [{ rid: scenarioRid, displayName: "Capacity plan" }],
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
  {
    section: "s_chart_overlay",
    widget: "w_chart_overlay",
    config: chartConfig({
      orientation: "vertical",
      xProperty: "assignee",
      xAxisTitle: "Assignee",
      yAxisTitle: "Orders / average quantity",
      useMultipleValueAxes: true,
      layers: [
        {
          id: "layer_metrics",
          title: "Order metrics",
          chartType: "bar",
          xProperty: "assignee",
          aggregation: "count",
          aggregationProperty: null,
          series: [
            { id: "orders", aggregation: "count", aggregationProperty: null, title: "Orders", color: "#2D72D2", visible: true, valueAxisId: "left" },
            { id: "avg_quantity", aggregation: "avg", aggregationProperty: "quantity", title: "Average quantity", color: "#D9822B", visible: true, valueAxisId: "right" },
          ],
          segmentByProperty: null,
          seriesOverrides: {},
          showValueLabels: true,
          dataInputMode: "object-set",
          objectSetVariableId: VAR_ID,
          enableSelectionFilter: true,
          selectionOutputVariableId: SELECTION_OUTPUT_VAR_ID,
        },
        {
          id: "layer_status",
          title: "Status trend",
          chartType: "line",
          xProperty: "assignee",
          aggregation: "count",
          aggregationProperty: null,
          series: [{ id: "count", aggregation: "count", aggregationProperty: null, title: "Orders by status", visible: true, valueAxisId: "left" }],
          segmentByProperty: "status",
          seriesOverrides: {},
          showValueLabels: true,
          dataInputMode: "object-set",
          objectSetVariableId: VAR_ID,
          enableSelectionFilter: false,
        },
      ],
      perSeriesAxisConfigs: {
        "layer_metrics/orders": { seriesId: "layer_metrics/orders", axisId: "left", position: "left", valueScale: "linear" },
        "layer_metrics/avg_quantity": { seriesId: "layer_metrics/avg_quantity", axisId: "right", position: "right", valueScale: "linear" },
      },
    }),
  },
  {
    section: "s_chart_time_series",
    widget: "w_chart_time_series",
    config: chartConfig({
      chartType: "line",
      orientation: "vertical",
      dataInputMode: "time-series-set",
      layers: [{
        id: "layer_time_series",
        title: "Order volume trend",
        chartType: "line",
        xProperty: null,
        aggregation: "count",
        aggregationProperty: null,
        series: [],
        segmentByProperty: null,
        seriesOverrides: {},
        showValueLabels: false,
        dataInputMode: "time-series-set",
        timeSeriesVariableId: TIME_SERIES_VAR_ID,
        enableSelectionFilter: false,
      }],
    }),
  },
  {
    section: "s_chart_scenarios",
    widget: "w_chart_scenarios",
    config: chartConfig({
      orientation: "vertical",
      xProperty: "assignee",
      xAxisTitle: "Assignee",
      yAxisTitle: "Scenario comparison",
      layers: [{
        id: "layer_scenarios",
        title: "Orders by scenario",
        chartType: "bar",
        xProperty: "assignee",
        aggregation: "count",
        aggregationProperty: null,
        series: [{ id: "count", aggregation: "count", aggregationProperty: null, title: "Orders", visible: true, valueAxisId: "left" }],
        segmentByProperty: null,
        seriesOverrides: {},
        showValueLabels: false,
        dataInputMode: "object-set",
        objectSetVariableId: VAR_ID,
        scenarioVariableId: SCENARIO_VAR_ID,
        enableSelectionFilter: false,
      }],
    }),
  },
  {
    section: "s_chart_scale",
    widget: "w_chart_scale",
    config: chartConfig({
      orientation: "vertical",
      xProperty: "orderId",
      xAxisTitle: "Order primary key",
      yAxisTitle: "Count",
      layers: [{
        id: "layer_scale",
        title: "High-cardinality orders",
        chartType: "bar",
        xProperty: "orderId",
        aggregation: "count",
        aggregationProperty: null,
        series: [{ id: "count", aggregation: "count", aggregationProperty: null, title: "Orders", visible: true, valueAxisId: "left" }],
        segmentByProperty: null,
        seriesOverrides: {},
        showValueLabels: false,
        dataInputMode: "object-set",
        objectSetVariableId: SCALE_VAR_ID,
        enableSelectionFilter: false,
      }],
    }),
  },
  {
    section: "s_chart_function_2d",
    widget: "w_chart_function_2d",
    config: chartConfig({
      orientation: "vertical",
      xAxisTitle: "Function category",
      yAxisTitle: "Function value",
      layers: [{
        id: "layer_function_2d",
        title: "2D function aggregation",
        chartType: "bar",
        xProperty: null,
        aggregation: "count",
        aggregationProperty: null,
        series: [],
        segmentByProperty: null,
        seriesOverrides: {},
        showValueLabels: true,
        dataInputMode: "function-aggregation",
        functionApiName: FUNCTION_2D,
        functionObjectSetVariableId: VAR_ID,
        enableSelectionFilter: false,
      }],
    }),
  },
  {
    section: "s_chart_function_3d",
    widget: "w_chart_function_3d",
    config: chartConfig({
      orientation: "vertical",
      xAxisTitle: "Function region",
      yAxisTitle: "Segment value",
      layers: [{
        id: "layer_function_3d",
        title: "3D function aggregation",
        chartType: "bar",
        xProperty: null,
        aggregation: "count",
        aggregationProperty: null,
        series: [],
        segmentByProperty: null,
        seriesOverrides: {},
        showValueLabels: true,
        dataInputMode: "function-aggregation",
        functionApiName: FUNCTION_3D,
        functionObjectSetVariableId: VAR_ID,
        enableSelectionFilter: false,
      }],
    }),
  },
  {
    section: "s_chart_log_fallback",
    widget: "w_chart_log_fallback",
    config: chartConfig({
      orientation: "vertical",
      valueScale: "log",
      xAxisTitle: "Non-positive category",
      yAxisTitle: "Requested log value",
      layers: [{
        id: "layer_log_fallback",
        title: "Non-positive log fallback",
        chartType: "bar",
        xProperty: null,
        aggregation: "count",
        aggregationProperty: null,
        series: [],
        segmentByProperty: null,
        seriesOverrides: {},
        showValueLabels: true,
        dataInputMode: "function-aggregation",
        functionApiName: FUNCTION_NON_POSITIVE,
        functionObjectSetVariableId: VAR_ID,
        enableSelectionFilter: false,
      }],
    }),
  },
  {
    section: "s_chart_error_isolation",
    widget: "w_chart_error_isolation",
    config: chartConfig({
      orientation: "vertical",
      xProperty: "status",
      xAxisTitle: "Healthy categories",
      yAxisTitle: "Count",
      layers: [
        {
          id: "layer_error_healthy",
          title: "Healthy layer",
          chartType: "bar",
          xProperty: "status",
          aggregation: "count",
          aggregationProperty: null,
          series: [{ id: "count", aggregation: "count", aggregationProperty: null, title: "Healthy", visible: true, valueAxisId: "left" }],
          segmentByProperty: null,
          seriesOverrides: {},
          showValueLabels: true,
          dataInputMode: "object-set",
          objectSetVariableId: VAR_ID,
          enableSelectionFilter: false,
        },
        {
          id: "layer_error_deleted",
          title: "Deleted source layer",
          chartType: "line",
          xProperty: "status",
          aggregation: "count",
          aggregationProperty: null,
          series: [{ id: "count", aggregation: "count", aggregationProperty: null, title: "Unavailable", visible: true, valueAxisId: "left" }],
          segmentByProperty: null,
          seriesOverrides: {},
          showValueLabels: false,
          dataInputMode: "object-set",
          objectSetVariableId: DELETED_VAR_ID,
          enableSelectionFilter: false,
        },
      ],
    }),
  },
  {
    section: "s_chart_union",
    widget: "w_chart_union",
    config: chartConfig({
      orientation: "vertical",
      xProperty: "status",
      xAxisTitle: "Status across object types",
      yAxisTitle: "Union count",
      layers: [{
        id: "layer_union",
        title: "Union order statuses",
        chartType: "bar",
        xProperty: "status",
        aggregation: "count",
        aggregationProperty: null,
        series: [{ id: "count", aggregation: "count", aggregationProperty: null, title: "Orders", visible: true, valueAxisId: "left" }],
        segmentByProperty: null,
        seriesOverrides: {},
        showValueLabels: true,
        dataInputMode: "object-set",
        objectSetVariableId: UNION_VAR_ID,
        enableSelectionFilter: false,
      }],
    }),
  },
];

const PARITY_FUNCTIONS = [
  {
    apiName: FUNCTION_2D,
    displayName: "Chart XY parity — 2D aggregation",
    source: `module.exports = function () {
      return { buckets: [
        { key: "East", value: 18 },
        { key: "North", value: 11 },
        { key: "West", value: 24 }
      ] };
    };`,
  },
  {
    apiName: FUNCTION_3D,
    displayName: "Chart XY parity — 3D aggregation",
    source: `module.exports = function () {
      return { buckets: [
        { key: "East", value: [{ key: "Base", value: 12 }, { key: "Plan", value: 7 }] },
        { key: "West", value: [{ key: "Base", value: 9 }, { key: "Plan", value: 15 }] }
      ] };
    };`,
  },
  {
    apiName: FUNCTION_NON_POSITIVE,
    displayName: "Chart XY parity — non-positive log fallback",
    source: `module.exports = function () {
      return { buckets: [{ key: "Negative", value: -5 }, { key: "Zero", value: 0 }] };
    };`,
  },
] as const;

async function ensureParityFunctions(ontologyId: string): Promise<void> {
  for (const definition of PARITY_FUNCTIONS) {
    const fn = await pool.query(
      `INSERT INTO ontology_function
         (ontology_id, api_name, display_name, description, runtime)
       VALUES ($1, $2, $3, $4, 'typescript')
       ON CONFLICT (ontology_id, api_name) DO UPDATE
         SET display_name = EXCLUDED.display_name,
             description = EXCLUDED.description,
             updated_at = now()
       RETURNING function_id`,
      [ontologyId, definition.apiName, definition.displayName, "Stable Chart XY Playwright fixture"],
    );
    const functionId = fn.rows[0].function_id as string;
    const latest = await pool.query(
      `SELECT version_id, source_code
         FROM ontology_function_version
        WHERE function_id = $1 AND is_latest = true
        ORDER BY version_number DESC
        LIMIT 1`,
      [functionId],
    );
    if (latest.rows[0]?.source_code === definition.source) continue;
    await pool.query("UPDATE ontology_function_version SET is_latest = false WHERE function_id = $1", [functionId]);
    await pool.query(
      `INSERT INTO ontology_function_version
         (function_id, version_number, source_code, input_schema, output_schema, is_latest, published_by)
       SELECT $1, COALESCE(MAX(version_number), 0) + 1, $2, '{}'::jsonb, $3::jsonb, true, 'seed:chart-xy-showcase'
         FROM ontology_function_version
        WHERE function_id = $1`,
      [functionId, definition.source, JSON.stringify({ type: "object", required: ["buckets"] })],
    );
  }
}

/** Build the full module definition (schemaVersion 4): three Chart XY widgets,
 *  one per child section, all bound to the shared OlivierOrder object set. */
function buildDefinition(scenarioRid: string): Record<string, unknown> {
  const downstreamSection = "s_chart_downstream_table";
  const downstreamWidget = "w_chart_downstream_table";
  return {
    schemaVersion: 4,
    displayName: DISPLAY_NAME,
    header: { title: DISPLAY_NAME },
    layout: { rootSection: ROOT_SECTION },
    variables: [objectSetVariable(), downstreamSelectionVariable(), scaleObjectSetVariable(), deletedSourceVariable(), ...unionObjectSetVariables(), timeSeriesVariable(), scenarioVariable(scenarioRid)],
    widgets: [
      ...PANELS.map((p) => ({
        id: p.widget,
        type: "chartXY",
        config: { layoutColumn: p.section, chartXY: p.config },
        inputs: { objectSet: VAR_ID },
      })),
      {
        id: downstreamWidget,
        type: "objectTable",
        config: {
          objectTable: { columns: { mode: "explicit", apiNames: ["assignee", "status", "quantity"] } },
          layoutColumn: downstreamSection,
          instanceNumber: 1,
        },
        inputs: { objectSet: DOWNSTREAM_VAR_ID },
      },
    ],
    sections: [
      {
        id: ROOT_SECTION,
        layout: "rows",
        children: [...PANELS.map((p) => ({ kind: "section", ref: p.section })), { kind: "section", ref: downstreamSection }],
      },
      ...PANELS.map((p) => ({
        id: p.section,
        layout: "rows",
        children: [{ kind: "widget", ref: p.widget }],
      })),
      {
        id: downstreamSection,
        layout: "rows",
        children: [{ kind: "widget", ref: downstreamWidget }],
      },
    ],
  };
}

async function main() {
  const current = await getModule(TARGET_RID);
  const { etag } = await getModuleEtag(TARGET_RID);
  const ontologyRidParts = current.ontologyRid.split(".");
  const ontologyId = ontologyRidParts[ontologyRidParts.length - 1] ?? current.ontologyRid;
  await ensureParityFunctions(ontologyId);

  const scenario = await createReadContext({
    kind: "scenario",
    tenantId: "default",
    ontologyId,
    ownerUserId: "633a9660-e374-41c6-87e0-d213cf50623d",
    expiresAt: new Date(Date.now() + 7 * 86_400_000),
  });
  const definition = buildDefinition(scenario.rid);
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
  console.log(`   widgets:   ${PANELS.length} × chartXY (bar / area / scatter / overlay / time series / scenarios / functions / scale / union)`);
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
