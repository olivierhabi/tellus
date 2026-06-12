// ---------------------------------------------------------------------------
// Vega Chart Showcase Seed
//
// Rewrites the definition of an EXISTING workshop module so it renders TWO
// Vega Chart widgets side-by-side, exercising the documented Vega Chart
// configuration surface
// (https://www.palantir.com/docs/foundry/workshop/widgets-vega-chart):
//
//   • Left  (section-box)  — VEGA-LITE grammar, AGGREGATION data source
//     (group-by `status`, count), Blueprint theme applied, and an interactive
//     Vega-Lite SELECTION PARAMETER wired as "selection as filter" (click a bar
//     to filter). Showcases: vega-lite, aggregation/count, theme, interactivity.
//   • Right (section-page) — VEGA (low-level) grammar, AGGREGATION data source
//     (group-by `assignee`, SUM of `quantity`), theme DISABLED. A horizontal
//     bar authored in the raw Vega grammar with value labels. Showcases: the
//     Vega language, a metric aggregation (sum), theme-off.
//
// Both charts bind a doc-faithful objectSet variable (the same shape the editor
// authors), so the frontend registry hydrates them and the persisted
// `config.vegaChart` round-trips on reload — i.e. it "saves like Object Table".
//
// The aggregation data source always injects rows carrying the canonical
// `key` (group value) + `value` (aggregation result) fields, so both specs
// reference `key`/`value` directly. `OlivierOrder` is the only type carrying
// seeded instance data in this ontology, so both charts bind it (each with a
// distinct aggregation), exercising the "two widgets, one object set" pattern.
//
// Idempotent: re-running re-writes the same definition (the etag is re-read
// each run, so it never 412s). Goes through the real service layer
// (`updateModule`) so the B02 schema + semantic validation runs exactly as a
// normal autosave would (the validator now recognises `vegaChart:objectSet`).
//
// Usage: npm run seed:vega-chart
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
  "ri.workshop.main.module.8e998e39-dc48-43bb-a0e8-792c46f3beb1";

// Object types that actually carry seeded instance data in this ontology.
// `OlivierOrder` is the only type with instance rows (746) in this ontology —
// `OlivierOrder1` was removed, so both charts bind `OlivierOrder` and showcase
// the valid "two widgets on one object set" pattern (count-by-status vs
// sum(quantity)-by-assignee). Binding a non-existent type 404s the data fetch.
const LEFT_OBJECT_TYPE = "OlivierOrder";
const RIGHT_OBJECT_TYPE = "OlivierOrder";

const LEFT_VAR_ID = "v_osv_vegalite";
const RIGHT_VAR_ID = "v_osv_vega";
const LEFT_WIDGET_ID = "w_osv_vegalite";
const RIGHT_WIDGET_ID = "w_osv_vega";

/** Doc-faithful objectSet variable (matches `objectSetVariableToDocEntry`). */
function objectSetVariable(
  id: string,
  objectTypeApiName: string,
  displayName: string,
): Record<string, unknown> {
  return {
    id,
    type: "objectSet",
    definitionType: "objectSetDefinition",
    displayName,
    definition: {
      objectTypeApiName,
      startingObjectType: objectTypeApiName,
      displayName,
      filters: [],
      filterVariableIds: [],
      traversals: [],
      combinedSetIds: [],
    },
  };
}

// Vega-Lite spec (LEFT): a bar chart over the canonical aggregation `key`/`value`
// fields, with a point-selection parameter ("statusSelection") so clicking a bar
// emits the widget's selection output. Width/height/autosize are injected by the
// canvas for vega-lite, so they are intentionally omitted here.
const LEFT_SPEC = JSON.stringify(
  {
    mark: { type: "bar", cornerRadiusEnd: 2 },
    data: { name: "orders" },
    params: [
      {
        name: "statusSelection",
        select: { type: "point", fields: ["key"], on: "click", clear: "dblclick" },
      },
    ],
    encoding: {
      x: {
        field: "key",
        type: "nominal",
        sort: "-y",
        title: "Status",
        axis: { labelAngle: 0 },
      },
      y: { field: "value", type: "quantitative", title: "Orders" },
      color: { field: "key", type: "nominal", legend: null },
      opacity: {
        condition: { param: "statusSelection", value: 1 },
        value: 0.35,
      },
      tooltip: [
        { field: "key", type: "nominal", title: "Status" },
        { field: "value", type: "quantitative", title: "Orders" },
      ],
    },
  },
  null,
  2,
);

// Vega (low-level) spec (RIGHT): a horizontal bar of sum(quantity) by assignee,
// authored in the raw Vega grammar. Width/height/autosize are intentionally
// OMITTED so the widget injects responsive container sizing (the chart fills
// its section); pin them here to render at a fixed size instead.
const RIGHT_SPEC = JSON.stringify(
  {
    $schema: "https://vega.github.io/schema/vega/v5.json",
    padding: 5,
    data: [{ name: "byAssignee" }],
    scales: [
      {
        name: "yscale",
        type: "band",
        domain: { data: "byAssignee", field: "key" },
        range: "height",
        padding: 0.2,
      },
      {
        name: "xscale",
        type: "linear",
        domain: { data: "byAssignee", field: "value" },
        range: "width",
        nice: true,
        zero: true,
      },
    ],
    axes: [
      { orient: "bottom", scale: "xscale", title: "Total quantity" },
      { orient: "left", scale: "yscale" },
    ],
    marks: [
      {
        type: "rect",
        from: { data: "byAssignee" },
        encode: {
          enter: {
            y: { scale: "yscale", field: "key" },
            height: { scale: "yscale", band: 1 },
            x: { scale: "xscale", value: 0 },
            x2: { scale: "xscale", field: "value" },
            fill: { value: "#3DA98F" },
            cornerRadiusEnd: { value: 2 },
          },
        },
      },
      {
        type: "text",
        from: { data: "byAssignee" },
        encode: {
          enter: {
            y: { scale: "yscale", field: "key", band: 0.5 },
            x: { scale: "xscale", field: "value", offset: 4 },
            baseline: { value: "middle" },
            text: { field: "value" },
            fill: { value: "#3A424D" },
            fontSize: { value: 10 },
          },
        },
      },
    ],
  },
  null,
  2,
);

/**
 * Build the full module definition (schemaVersion 4). The two widgets together
 * exercise both `specLanguage` values, both showcased aggregation methods
 * (count + sum), `applyTheme` true/false, and the selection-as-filter path.
 */
function buildDefinition(): Record<string, unknown> {
  return {
    schemaVersion: 4,
    displayName: "Vega Chart — Feature Showcase",
    header: { title: "Vega Chart — Feature Showcase" },
    layout: {
      rootSection: "s_root",
      columnWidths: {
        "section-box": { mode: "flex", pxWidth: 300, flexValue: 1 },
        "section-page": { mode: "flex", pxWidth: 300, flexValue: 1 },
      },
    },
    variables: [
      objectSetVariable(LEFT_VAR_ID, LEFT_OBJECT_TYPE, "Orders by status"),
      objectSetVariable(RIGHT_VAR_ID, RIGHT_OBJECT_TYPE, "Orders by assignee"),
    ],
    widgets: [
      {
        id: LEFT_WIDGET_ID,
        type: "vegaChart",
        config: {
          layoutColumn: "section-box",
          // Full VegaChartConfig — Vega-Lite aggregation bar with selection.
          vegaChart: {
            specLanguage: "vega-lite",
            spec: LEFT_SPEC,
            dataName: "orders",
            dataSource: "aggregation",
            rowLimit: 1000,
            groupByProperty: "status",
            aggregation: "count",
            aggregationProperty: null,
            aggregationName: "value",
            applyTheme: true,
            selectionParam: "statusSelection",
            enableSelectionFilter: true,
          },
        },
        inputs: { objectSet: LEFT_VAR_ID },
      },
      {
        id: RIGHT_WIDGET_ID,
        type: "vegaChart",
        config: {
          layoutColumn: "section-page",
          // Full VegaChartConfig — raw Vega grammar, sum metric, theme off.
          vegaChart: {
            specLanguage: "vega",
            spec: RIGHT_SPEC,
            dataName: "byAssignee",
            dataSource: "aggregation",
            rowLimit: 1000,
            groupByProperty: "assignee",
            aggregation: "sum",
            aggregationProperty: "quantity",
            aggregationName: "value",
            applyTheme: false,
            selectionParam: "",
            enableSelectionFilter: false,
          },
        },
        inputs: { objectSet: RIGHT_VAR_ID },
      },
    ],
    sections: [
      {
        id: "s_root",
        layout: "rows",
        children: [
          { kind: "widget", ref: LEFT_WIDGET_ID },
          { kind: "widget", ref: RIGHT_WIDGET_ID },
        ],
      },
    ],
  };
}

async function main(): Promise<void> {
  // Confirm the module exists (and surface its ontology for the log).
  const current = await getModule(TARGET_RID);
  const { etag } = await getModuleEtag(TARGET_RID);

  const definition = buildDefinition();
  const actor: Actor = { userId: "seed:vega-chart-showcase" };

  // Goes through full B02 validation (schema + semantic rules) — fails loudly
  // if the definition is malformed.
  const updated = await updateModule(
    TARGET_RID,
    etag,
    {
      displayName: "Vega Chart — Feature Showcase",
      // Validated at runtime by `updateModule` (B02); the build helper returns a
      // freeform object, so assert it to the request's definition type here.
      definition: definition as UpdateModuleRequest["definition"],
    },
    actor,
  );

  console.log("✅ Vega Chart showcase seeded");
  console.log(`   module:    ${updated.module.rid}`);
  console.log(`   ontology:  ${current.ontologyRid}`);
  console.log(`   widgets:   2 × vegaChart (vega-lite + vega)`);
  console.log(`   new etag:  ${updated.etag}`);
  console.log(`   open:      /workshop/${updated.module.rid}`);
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("❌ Vega Chart showcase seed failed:", err);
    await pool.end();
    process.exit(1);
  });
