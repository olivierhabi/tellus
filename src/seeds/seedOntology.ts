// ---------------------------------------------------------------------------
// seedOntology.ts — single-ontology seed helper
// ---------------------------------------------------------------------------
// "One Enterprise, One Ontology": seeds no longer create their own ontology
// row (the DB singleton guard forbids a second one). Instead they populate THE
// canonical enterprise ontology. This helper ensures that ontology exists and
// resets its CONTENT (object types, links, instances, edits, funnel state) so a
// seed can repopulate idempotently — while preserving the ontology row and its
// `main` branch so the singleton + branch invariants hold.
// ---------------------------------------------------------------------------

import { query } from "../db";
import { ensureEnterpriseOntology } from "../services/ontology/canonicalOntology";

/**
 * Ensure the single enterprise ontology exists and clear its content, returning
 * the canonical ontology id. Each seed run is a full reset of the enterprise
 * ontology's contents (matching the previous per-seed "delete + recreate"
 * semantics), but now scoped to the one shared ontology.
 */
export async function resetEnterpriseOntologyForSeed(): Promise<string> {
  const ontologyId = await ensureEnterpriseOntology();

  // Data-key tables (no FK to ontology) — clear explicitly.
  await query("DELETE FROM object_instances WHERE ontology_id = $1", [ontologyId]);
  await query("DELETE FROM ontology_edit WHERE ontology_id = $1", [ontologyId]);
  await query("DELETE FROM link_edit WHERE ontology_id = $1", [ontologyId]);
  await query("DELETE FROM funnel_run WHERE ontology_id = $1", [ontologyId]);
  await query("DELETE FROM funnel_signal WHERE ontology_id = $1", [ontologyId]);
  await query("DELETE FROM funnel_changelog_watermark WHERE ontology_id = $1", [ontologyId]);

  // FK-bearing definition tables. Clear per-object-type dependents first (some
  // are not ON DELETE CASCADE), then the object types and links themselves.
  await query(
    `DELETE FROM backing_datasource
      WHERE object_type_id IN (SELECT object_type_id FROM object_type WHERE ontology_id = $1)`,
    [ontologyId]
  );
  await query(
    `DELETE FROM object_type_interface
      WHERE object_type_id IN (SELECT object_type_id FROM object_type WHERE ontology_id = $1)`,
    [ontologyId]
  );
  await query(
    `DELETE FROM property
      WHERE object_type_id IN (SELECT object_type_id FROM object_type WHERE ontology_id = $1)`,
    [ontologyId]
  );
  await query("DELETE FROM interface WHERE ontology_id = $1", [ontologyId]);
  await query("DELETE FROM link_type WHERE ontology_id = $1", [ontologyId]);
  await query("DELETE FROM object_type WHERE ontology_id = $1", [ontologyId]);

  return ontologyId;
}

export default resetEnterpriseOntologyForSeed;
