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
import {
  assertDestructiveTestEnvironment,
} from "../services/testing/destructiveTestGuard";

/**
 * Ensure the single enterprise ontology exists and clear its content, returning
 * the canonical ontology id. Each seed run is a full reset of the enterprise
 * ontology's contents (matching the previous per-seed "delete + recreate"
 * semantics), but now scoped to the one shared ontology.
 *
 * FUNN-ISO-1: the reset is DESTRUCTIVE and only legal against a dedicated
 * test/verify environment. The destructive-test guard enforces the full
 * environment proof (sealed DB, test-shaped ns/queue/realm/prefix/bucket,
 * dev/prod deny-lists). Reseeding the SHARED dev ontology through this path
 * is no longer possible — dev content is restored via the verify-stack cycle
 * or explicit, human-run SQL, never by an automated test runner.
 */
export async function resetEnterpriseOntologyForSeed(): Promise<string> {
  // skipApiProbe: every caller of this function is the pre-server phase
  // (browser of the seed scripts / vitest globalSetup before spawn). Port
  // ownership of the about-to-run lane API is guaranteed by globalSetup's
  // fail-closed claimTestApiPort, and the API-identity re-proof runs after
  // the server is healthy (vitest-globalSetup-post-spawn).
  await assertDestructiveTestEnvironment({
    operation: "resetEnterpriseOntologyForSeed",
    skipApiProbe: true,
  });
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

  // LOUD, actionable notice: this reset wiped Postgres `object_instances`
  // AND every `object_type` definition (incl. user-created ones not in the
  // seed). The seed only re-creates the seed object-TYPE definitions — it
  // does NOT re-materialize any `object_instances` rows and does NOT re-run
  // the funnel/materializer for CSV-backed types. Consequence for the
  // code-repository TS function runtime: a repo that imports an object type
  // which has zero rows now gets an empty Ontology snapshot for it. Fix B
  // (objectTypeDescriptors keyed off DECLARED imports) keeps the type
  // descriptor resolving (so `SomeType.apiName` no longer throws), but
  // `Objects.search(SomeType.apiName)` returns an empty ObjectSet until
  // `object_instances` is repopulated. Repopulate per type via the runtime
  // reindex/funnel entry point:
  //   POST /api/v1/ontology/:ontologyId/objectTypes/:apiName/reindex
  // (reindexObjectType — materializes the backing datasource into
  // `object_instances` + OpenSearch). Do NOT expect imported types to carry
  // data after a seed without this step.
  console.warn(
    `[seedOntology] resetEnterpriseOntologyForSeed cleared object_instances + ` +
      `object_type definitions for ontology ${ontologyId}. ` +
      `Code-repository function runtime: imported types resolve descriptors ` +
      `(no undefined.apiName crash) but Objects.search returns empty until ` +
      `object_instances is repopulated — re-run ` +
      `POST /api/v1/ontology/:ontologyId/objectTypes/:apiName/reindex per type.`
  );

  return ontologyId;
}

export default resetEnterpriseOntologyForSeed;
