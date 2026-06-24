// ---------------------------------------------------------------------------
// Vega Chart Gallery Showcase Seed
//
// Builds (or refreshes) a single Workshop module that renders ALL 32 charts
// from the Vega examples gallery (https://vega.github.io/vega/examples/) as live
// Vega Chart widgets, laid out in a titled grid grouped by category:
//
//   • Bar Charts         — Bar, Stacked Bar, Grouped Bar, Nested Bar,
//                          Population Pyramid
//   • Line & Area Charts — Line, Area, Stacked Area, Horizon Graph, Job Voyager
//   • Circular Charts    — Pie, Donut, Donut Labelled, Radial Plot
//   • Distributions      — Top K, Top K w/ Others, Histogram, Histogram Null,
//                          Dot, Probability Density, Box, Violin, Binned Scatter,
//                          Contour, Wheat, Quantile-Quantile, Quantile Dot,
//                          Hypothetical Outcome Plots
//   • Time & Interactive — Time Units, Crossfilter Flights, Overview + Detail,
//                          Bar/Line Toggle
//
// Each widget persists the canonical Vega (low-level grammar) spec verbatim in
// `config.vegaChart.spec` (see `vegaGallerySpecs.ts`, auto-generated from the
// upstream repo with data URLs absolutized to the CORS-enabled CDN and every
// spec validated to compile with `vega.parse`). The charts carry their OWN data
// (inline or via CDN url), so they render independently of ontology data — but
// the Vega Chart widget only mounts once an object set is bound (the canvas
// shows an empty placeholder otherwise), so every widget binds one shared,
// doc-faithful `objectSet` variable (its rows are injected under an unreferenced
// dataset name and ignored by the specs).
//
// Layout: a `rows` root → one titled `rows` group section per category → `columns`
// rows of two `rows` cell sections (each titled with the chart name) → the chart
// widget. Per-cell `flex: 1` column widths split each row evenly.
//
// Idempotent: re-running finds the module by (folder, name) and re-writes its
// definition via `updateModule`; the first run creates it via `createModule`.
// Both go through full B02 validation (JSON schema + the nine semantic rules),
// so a malformed definition fails loudly rather than persisting.
//
// Usage: npx tsx src/seeds/vegaGalleryShowcaseSeed.ts
// ---------------------------------------------------------------------------

import "dotenv/config";
import { randomUUID } from "crypto";

import { pool } from "../db";
import {
  createModule,
  getModuleEtag,
  updateModule,
  type Actor,
} from "../services/workshop/moduleService";
import type {
  CreateModuleRequest,
  UpdateModuleRequest,
} from "../services/workshop/types";
import { VEGA_GALLERY_SPECS } from "./vegaGallerySpecs";

// Reuse the demo ontology + folder that the other workshop seeds target, so the
// gallery lands beside them (OlivierOrder is the only object type carrying
// seeded instance rows — it backs the shared object-set binding).
const PARENT_FOLDER_RID =
  "ri.compass.main.folder.04687888-b63d-4cae-b1a4-8dc52068d43f";
const ONTOLOGY_RID =
  "ri.ontology.main.ontology.00000000-0000-0000-0000-000000000001";
const OBJECT_TYPE = "OlivierOrder";
const DISPLAY_NAME = "Vega Chart — Gallery (32 charts)";

const GALLERY_VAR = "v_osv_gallery";
const ROOT_SECTION = "s_gallery_root";
const COLS_PER_ROW = 2;
// The injected object-set rows land under this dataset name; no gallery spec
// references it, so the bound data is inert (the spec's own data drives it).
const INERT_DATASET = "__tellus_objectset__";

/** kebab slug → underscore id fragment (matches ^[a-zA-Z0-9_]+$ id patterns). */
const idFrag = (slug: string): string => slug.replace(/-/g, "_");

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

/** One Vega Chart widget bound to the shared object set, carrying a gallery spec. */
function vegaWidget(
  slug: string,
  spec: string,
  cellId: string,
): Record<string, unknown> {
  return {
    id: `w_${idFrag(slug)}`,
    type: "vegaChart",
    config: {
      layoutColumn: cellId,
      vegaChart: {
        specLanguage: "vega",
        spec,
        dataName: INERT_DATASET,
        dataSource: "object-set",
        rowLimit: 50,
        groupByProperty: null,
        aggregation: "count",
        aggregationProperty: null,
        aggregationName: "value",
        // Keep the upstream example's own styling — don't overlay the Blueprint
        // theme so each chart looks exactly like the gallery reference.
        applyTheme: false,
        selectionParam: "",
        enableSelectionFilter: false,
      },
    },
    inputs: { objectSet: GALLERY_VAR },
  };
}

type Child = { kind: "section" | "widget"; ref: string };

/** Build the full module definition (schemaVersion 4) for all 32 charts. */
function buildDefinition(): Record<string, unknown> {
  const widgets: Array<Record<string, unknown>> = [];
  const sections: Array<Record<string, unknown>> = [];
  const columnWidths: Record<string, unknown> = {};

  // Preserve registry order; bucket by group on first appearance.
  const order: string[] = [];
  const byGroup = new Map<string, typeof VEGA_GALLERY_SPECS[number][]>();
  for (const s of VEGA_GALLERY_SPECS) {
    if (!byGroup.has(s.group)) {
      byGroup.set(s.group, []);
      order.push(s.group);
    }
    byGroup.get(s.group)!.push(s);
  }

  const groupChildren: Child[] = [];
  order.forEach((group, gi) => {
    const specs = byGroup.get(group)!;
    const rowChildren: Child[] = [];

    for (let i = 0; i < specs.length; i += COLS_PER_ROW) {
      const cellChildren: Child[] = [];
      for (const s of specs.slice(i, i + COLS_PER_ROW)) {
        const cellId = `s_cell_${idFrag(s.slug)}`;
        const widgetId = `w_${idFrag(s.slug)}`;
        widgets.push(vegaWidget(s.slug, s.spec, cellId));
        sections.push({
          id: cellId,
          layout: "rows",
          header: { visible: true, title: s.title, format: "block" },
          children: [{ kind: "widget", ref: widgetId }],
        });
        columnWidths[cellId] = {
          mode: "flex",
          pxWidth: 480,
          flexValue: 1,
          resizable: true,
        };
        cellChildren.push({ kind: "section", ref: cellId });
      }
      const rowId = `s_row_${gi}_${Math.floor(i / COLS_PER_ROW)}`;
      sections.push({ id: rowId, layout: "columns", children: cellChildren });
      rowChildren.push({ kind: "section", ref: rowId });
    }

    const groupId = `s_grp_${gi}`;
    sections.push({
      id: groupId,
      layout: "rows",
      header: { visible: true, title: group, format: "block" },
      children: rowChildren,
    });
    groupChildren.push({ kind: "section", ref: groupId });
  });

  sections.push({
    id: ROOT_SECTION,
    layout: "rows",
    children: groupChildren,
  });

  return {
    schemaVersion: 4,
    displayName: DISPLAY_NAME,
    header: { title: DISPLAY_NAME },
    layout: { rootSection: ROOT_SECTION, columnWidths },
    variables: [
      objectSetVariable(GALLERY_VAR, OBJECT_TYPE, "Gallery object set"),
    ],
    widgets,
    sections,
  };
}

/** Existing gallery module in this folder (idempotent re-run), or null. */
async function findExistingRid(): Promise<string | null> {
  const r = await pool.query<{ rid: string }>(
    `SELECT rid FROM workshop_module
      WHERE parent_folder_rid = $1
        AND lower(display_name) = lower($2)
        AND deleted_at IS NULL
      LIMIT 1`,
    [PARENT_FOLDER_RID, DISPLAY_NAME],
  );
  return r.rows[0]?.rid ?? null;
}

async function main(): Promise<void> {
  const definition = buildDefinition();
  const actor: Actor = { userId: "seed:vega-gallery" };
  const widgetCount = (definition.widgets as unknown[]).length;
  const sectionCount = (definition.sections as unknown[]).length;

  const existing = await findExistingRid();
  let rid: string;
  let etag: string;

  if (existing) {
    const cur = await getModuleEtag(existing);
    const updated = await updateModule(
      existing,
      cur.etag,
      {
        displayName: DISPLAY_NAME,
        definition: definition as UpdateModuleRequest["definition"],
      },
      actor,
    );
    rid = updated.module.rid;
    etag = updated.etag;
    console.log("✅ Vega Chart gallery refreshed (updateModule)");
  } else {
    const created = await createModule(
      {
        displayName: DISPLAY_NAME,
        parentFolderRid: PARENT_FOLDER_RID,
        ontologyRid: ONTOLOGY_RID,
        definition: definition as CreateModuleRequest["definition"],
      },
      actor,
      {
        key: randomUUID(),
        route: "POST /workshop/modules",
        body: { seed: "vega-gallery" },
      },
    );
    rid = created.module.rid;
    etag = created.etag;
    console.log("✅ Vega Chart gallery created (createModule)");
  }

  console.log(`   module:   ${rid}`);
  console.log(`   charts:   ${widgetCount} vegaChart widgets`);
  console.log(`   sections: ${sectionCount}`);
  console.log(`   new etag: ${etag}`);
  console.log(`   open:     /workshop/${rid}`);
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("❌ Vega Chart gallery seed failed:", err);
    await pool.end();
    process.exit(1);
  });
