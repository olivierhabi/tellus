/**
 * B10 — Ontology bindings module bootstrap.
 */
import type { Knex } from "knex";
import { OntologyBindingsRepo } from "./repo";
import { buildOntologyBindingsRouter } from "./handlers";

export function buildOntologyBindingsModule(db: Knex) {
  const repo = new OntologyBindingsRepo(db);
  const router = buildOntologyBindingsRouter(repo);
  return { repo, router };
}
export { deriveLinkTypes } from "./fk-detector";
export type { LinkTypeSpec, OntologyBinding, PropertyMapping } from "./contracts";
export { setRegenQueue, regenInProc, triggerRegen } from "./osdk-regen";
