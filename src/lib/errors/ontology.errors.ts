// ---------------------------------------------------------------------------
// B10 — Ontology service error catalog.
// Centralizes the codes raised by ontology-bindings/handlers.ts and
// ontology/bindings/handlers.ts so they're registry-guarded.
// ---------------------------------------------------------------------------

import { def, register } from "./registry";

export const OntologyUnauthorized = register(
  def(
    "Tellus:Ontology:Unauthorized",
    "UNAUTHENTICATED",
    "Caller has no valid user context for Ontology surface.",
  ),
);

export const OntologyInvalidBinding = register(
  def(
    "Tellus:Ontology:InvalidBinding",
    "INVALID_ARGUMENT",
    "Object-type binding payload failed validation.",
  ),
);

export const OntologyInvalidBindingRequest = register(
  def(
    "Tellus:Ontology:InvalidBindingRequest",
    "INVALID_ARGUMENT",
    "Ontology binding request body failed validation.",
  ),
);

export const OntologyBindingNotFound = register(
  def(
    "Tellus:Ontology:BindingNotFound",
    "NOT_FOUND",
    "No active ontology binding with the given RID.",
  ),
);

export const OntologyResourceVersionMismatch = register(
  def(
    "Tellus:Ontology:ResourceVersionMismatch",
    "CONFLICT",
    "If-Match version does not match the current ontology resource version.",
  ),
);

export const OntologyIfMatchRequired = register(
  def(
    "Tellus:Ontology:IfMatchRequired",
    "FAILED_PRECONDITION",
    "If-Match header is required for this mutation.",
    428,
  ),
);

export const OntologyInternal = register(
  def(
    "Tellus:Ontology:InternalError",
    "INTERNAL",
    "Unexpected internal failure in the Ontology surface.",
  ),
);
