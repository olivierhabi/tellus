// ---------------------------------------------------------------------------
// cleanBf1ad333PhantomTables — one-shot cleanup of the phantom Object Table
// widgets that the (now-removed) orphan-self-heal fabricated + autosaved into
// module bf1ad333 over several editing sessions.
//
// The module's intended content is ONE Chart: XY widget. The other 9 saved
// widgets are all objectTable entries the frontend's registry FLUSH spawned
// for momentarily-unbound `v_osv_*` variables (the bug fixed in tellus-fe:
// hooks/useObjectSetRegistrySync.ts no longer calls
// withDefaultInstancesForOrphanVariables). This script removes those 9
// phantom tables + the 7 variables that become orphaned once they're gone,
// keeping only the chartXY widget + the 2 variables it actually references.
//
// Goes through the real service layer (getModule → getModuleEtag →
// updateModule) so the B02 schema + semantic validation runs exactly as a
// normal save would, and the etag is bumped correctly. If the cleaned
// definition is malformed, validateModule throws and the module is left
// UNCHANGED (the UPDATE is gated behind the validation + a FOR UPDATE lock).
//
// A full backup of the pre-cleanup definition was captured to
// /tmp/bf1ad333-cleanup/definition-before.json before running.
//
// Usage: npx tsx src/seeds/cleanBf1ad333PhantomTables.ts
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
  "ri.workshop.main.module.bf1ad333-2dcb-4cf3-b031-ba7d09d8a26c";

interface WidgetLike {
  id: string;
  type: string;
  inputs?: { objectSet?: string } | null;
  config?: {
    chartXY?: { layers?: Array<{ objectSetVariableId?: string | null }> } | null;
  } | null;
}
interface VariableLike {
  id: string;
  type?: string;
}
interface SectionLike {
  id: string;
  children?: Array<{ kind: string; ref: string }> | null;
}
interface DefinitionLike {
  schemaVersion?: number;
  displayName?: string;
  header?: unknown;
  layout?: unknown;
  variables?: VariableLike[];
  widgets?: WidgetLike[];
  sections?: SectionLike[];
}

async function main() {
  const current = await getModule(TARGET_RID);
  const def = current.definition as DefinitionLike;

  const beforeWidgets = def.widgets ?? [];
  const beforeVars = def.variables ?? [];
  const beforeSections = def.sections ?? [];

  // 1. Drop every objectTable widget — these are the fabricated phantoms.
  //    (The module's only intended widget is the chartXY; the user confirmed
  //    the module should have NO Object Table widgets.)
  const keptWidgets = beforeWidgets.filter((w) => w.type !== "objectTable");
  const droppedWidgetIds = new Set(
    beforeWidgets.filter((w) => w.type === "objectTable").map((w) => w.id),
  );
  const keptWidgetIds = new Set(keptWidgets.map((w) => w.id));

  // 2. Keep only variables referenced by a surviving widget (top-level
  //    inputs.objectSet OR a chartXY layer's objectSetVariableId). The rest
  //    are stale `v_osv_*` from experimentation that now have no binder.
  const referencedVars = new Set<string>();
  for (const w of keptWidgets) {
    if (w.inputs?.objectSet) referencedVars.add(w.inputs.objectSet);
    for (const l of w.config?.chartXY?.layers ?? []) {
      if (l.objectSetVariableId) referencedVars.add(l.objectSetVariableId);
    }
  }
  const keptVars = beforeVars.filter((v) => referencedVars.has(v.id));

  // 3. Strip section children refs to the dropped widgets (B02 C-06 forbids
  //    a section from referencing a widget that no longer exists).
  const keptSections = beforeSections.map((s) => ({
    ...s,
    children: (s.children ?? []).filter(
      (c) => c.kind !== "widget" || keptWidgetIds.has(c.ref),
    ),
  }));

  const cleaned: DefinitionLike = {
    ...def,
    widgets: keptWidgets,
    variables: keptVars,
    sections: keptSections,
  };

  // ---- Report (dry) --------------------------------------------------------
  console.log("Cleanup plan for", TARGET_RID);
  console.log(
    `  widgets:   ${beforeWidgets.length} → ${keptWidgets.length}` +
      ` (dropping ${droppedWidgetIds.size} objectTable phantoms)`,
  );
  console.log(
    `  variables: ${beforeVars.length} → ${keptVars.length}` +
      ` (keeping referenced: ${[...referencedVars].sort().join(", ")})`,
  );
  const keptKinds = keptWidgets
    .map((w) => `${w.id}(${w.type})`)
    .sort();
  console.log(`  keeping widgets: ${keptKinds.join(", ") || "(none)"}`);
  if (keptWidgets.length === 0) {
    console.error(
      "  ABORT: no widget would survive — refusing to empty the module.",
    );
    await pool.end();
    process.exit(1);
  }
  // Sanity: every surviving widget must still be referenced by some section
  // (else B02 C-06 would reject the save).
  const referencedWidgetIds = new Set<string>();
  for (const s of keptSections) {
    for (const c of s.children ?? []) {
      if (c.kind === "widget") referencedWidgetIds.add(c.ref);
    }
  }
  const unreferenced = [...keptWidgetIds].filter(
    (id) => !referencedWidgetIds.has(id),
  );
  if (unreferenced.length > 0) {
    console.error(
      "  ABORT: surviving widgets with no section ref:",
      unreferenced,
    );
    await pool.end();
    process.exit(1);
  }

  // ---- Persist via the service layer (B02 validation + etag) ---------------
  const { etag } = await getModuleEtag(TARGET_RID);
  const actor: Actor = { userId: "seed:cleanup-bf1ad333-phantoms" };
  const updated = await updateModule(
    TARGET_RID,
    etag,
    {
      displayName: current.displayName,
      definition: cleaned as unknown as UpdateModuleRequest["definition"],
    } as UpdateModuleRequest,
    actor,
  );

  console.log("✅ Cleaned bf1ad333 phantom Object Tables");
  console.log(`   module:  ${updated.module.rid}`);
  console.log(`   widgets: ${keptWidgets.length} (${keptKinds.join(", ")})`);
  console.log(
    `   vars:    ${keptVars.length} (${keptVars.map((v) => v.id).sort().join(", ")})`,
  );
  console.log(`   new etag: ${updated.etag}`);
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("❌ Cleanup failed (module left unchanged):", err);
    await pool.end();
    process.exit(1);
  });
