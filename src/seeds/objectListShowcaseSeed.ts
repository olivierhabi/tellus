// ---------------------------------------------------------------------------
// Object List Showcase Seed
//
// Rewrites the definition of an EXISTING workshop module so it renders TWO
// Object List widgets side-by-side, exercising every documented Object List
// configuration option (https://www.palantir.com/docs/foundry/workshop/widgets-object-list):
//
//   • Left  (section-box)  — GRID display, compact spacing, aligned property
//     style, icon-media, object count, security markings, multi-select,
//     user sorting.
//   • Right (section-page) — LIST display, comfortable spacing, inline property
//     style, hide-null-properties, custom empty state, reordering, user sorting.
//
// Both lists bind a doc-faithful objectSet variable (the same shape the editor
// authors), so the frontend registry hydrates them and the persisted
// `config.objectList` round-trips on reload.
//
// The module's ontology only seeds instance data for `OlivierOrder` /
// `OlivierOrder1` (no object type carries an image/media-reference property),
// so the media showcase uses `mediaDisplay: "icon"` (the documented "replace
// the Ontology icon" mode) rather than a real image URL.
//
// Idempotent: re-running simply re-writes the same definition (the etag is
// re-read each run, so it never 412s). Goes through the real service layer
// (`updateModule`) so the B02 schema + semantic validation runs exactly as a
// normal autosave would.
//
// Usage: npm run seed:object-list
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
  "ri.workshop.main.module.e50a7b99-dd5b-4cd8-a4cd-21300e660a04";

// Object types that actually carry seeded instance data in this ontology.
const LEFT_OBJECT_TYPE = "OlivierOrder1";
const RIGHT_OBJECT_TYPE = "OlivierOrder";

const LEFT_VAR_ID = "v_osv_listgrid";
const RIGHT_VAR_ID = "v_osv_listrows";
const LEFT_WIDGET_ID = "w_osv_listgrid";
const RIGHT_WIDGET_ID = "w_osv_listrows";

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

/**
 * Build the full module definition (schemaVersion 4). Every `objectList` flag
 * is exercised across the two widgets; together they cover both enum values of
 * display / spacing / propertyStyle / mediaDisplay and both states of every
 * boolean.
 */
function buildDefinition(): Record<string, unknown> {
  return {
    schemaVersion: 4,
    displayName: "Object List — Feature Showcase",
    header: { title: "Object List — Feature Showcase" },
    layout: {
      rootSection: "s_root",
      columnWidths: {
        "section-box": { mode: "flex", pxWidth: 300, flexValue: 1 },
        "section-page": { mode: "flex", pxWidth: 300, flexValue: 1 },
      },
    },
    variables: [
      objectSetVariable(LEFT_VAR_ID, LEFT_OBJECT_TYPE, "Orders (grid)"),
      objectSetVariable(RIGHT_VAR_ID, RIGHT_OBJECT_TYPE, "Orders (list)"),
    ],
    widgets: [
      {
        id: LEFT_WIDGET_ID,
        type: "objectList",
        config: {
          layoutColumn: "section-box",
          // Shared property-selection slot (same model as the Object Table).
          objectTable: {
            columns: {
              mode: "explicit",
              apiNames: ["status", "itemName", "quantity", "unitPrice", "assignee"],
            },
          },
          // Object List display / behaviour — GRID showcase.
          objectList: {
            title: "Orders — grid view",
            display: "grid",
            spacing: "compact",
            propertyStyle: "aligned",
            emptyState: "default",
            emptyStateMessage: "",
            showObjectCount: true,
            showSecurityMarkings: true,
            hideNullProperties: false,
            enableUserSorting: true,
            autoSelectFirst: true,
            enableMultiSelect: true,
            mediaEnabled: true,
            mediaProperty: null,
            mediaDisplay: "icon",
            mediaExpandedPreview: false,
            mediaHoverProperties: false,
            mediaPosition: "left",
            mediaResizing: "crop",
            reorderEnabled: false,
            reorderMode: "update-array",
          },
        },
        inputs: { objectSet: LEFT_VAR_ID },
      },
      {
        id: RIGHT_WIDGET_ID,
        type: "objectList",
        config: {
          layoutColumn: "section-page",
          objectTable: {
            columns: {
              mode: "explicit",
              apiNames: [
                "orderId",
                "customerId",
                "status",
                "orderDueDate",
                "daysUntilDue",
              ],
            },
          },
          // Object List display / behaviour — LIST showcase.
          objectList: {
            title: "Orders — list view",
            display: "list",
            spacing: "comfortable",
            propertyStyle: "inline",
            emptyState: "custom",
            emptyStateMessage: "No orders match the current filters.",
            showObjectCount: true,
            showSecurityMarkings: false,
            hideNullProperties: true,
            enableUserSorting: true,
            autoSelectFirst: true,
            enableMultiSelect: false,
            mediaEnabled: false,
            mediaProperty: null,
            mediaDisplay: "large",
            mediaExpandedPreview: false,
            mediaHoverProperties: false,
            mediaPosition: "left",
            mediaResizing: "crop",
            reorderEnabled: true,
            reorderMode: "update-array",
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
  const actor: Actor = { userId: "seed:object-list-showcase" };

  // Goes through full B02 validation (schema + semantic rules) — fails loudly
  // if the definition is malformed.
  const updated = await updateModule(
    TARGET_RID,
    etag,
    {
      displayName: "Object List — Feature Showcase",
      // Validated at runtime by `updateModule` (B02); the build helper returns a
      // freeform object, so assert it to the request's definition type here.
      definition: definition as UpdateModuleRequest["definition"],
    },
    actor,
  );

  console.log("✅ Object List showcase seeded");
  console.log(`   module:    ${updated.module.rid}`);
  console.log(`   ontology:  ${current.ontologyRid}`);
  console.log(`   widgets:   2 × objectList (grid + list)`);
  console.log(`   new etag:  ${updated.etag}`);
  console.log(
    `   open:      /workshop/${updated.module.rid}`,
  );
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("❌ Object List showcase seed failed:", err);
    await pool.end();
    process.exit(1);
  });
