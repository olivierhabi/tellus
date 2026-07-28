// Shared :ontology path-segment resolution for the v2 surface.
import { query } from "../../db";

export async function requireOntology(ontology: string): Promise<string> {
  const r = await query(
    `SELECT ontology_id FROM ontology
      WHERE ontology_id::text = $1 OR display_name = $1
      LIMIT 1`,
    [ontology],
  );
  if (r.rows.length === 0) {
    throw Object.assign(new Error(`Ontology not found: ${ontology}`), {
      errorName: "OntologyNotFound",
      parameters: { ontology },
    });
  }
  return String(r.rows[0].ontology_id);
}
