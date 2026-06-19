// ---------------------------------------------------------------------------
// B9 — Funnel service error catalog.
// All names follow Tellus:Service:PascalCase and are guarded by the registry.
// ---------------------------------------------------------------------------

import { def, register } from "./registry";

export const FunnelUnauthorized = register(
  def(
    "Tellus:Funnel:Unauthorized",
    "UNAUTHENTICATED",
    "Caller has no valid user context for Funnel surface.",
  ),
);

export const FunnelInvalidBinding = register(
  def(
    "Tellus:Funnel:InvalidBinding",
    "INVALID_ARGUMENT",
    "Object-type binding payload failed validation.",
  ),
);

export const FunnelBindingNotFound = register(
  def(
    "Tellus:Funnel:BindingNotFound",
    "NOT_FOUND",
    "No active object-type binding with the given RID.",
  ),
);

export const FunnelInternal = register(
  def(
    "Tellus:Funnel:Internal",
    "INTERNAL",
    "Unexpected internal failure in the Funnel surface.",
  ),
);

export const FunnelCheckpointConflict = register(
  def(
    "Tellus:Funnel:CheckpointConflict",
    "CONFLICT",
    "Concurrent checkpoint write detected for binding.",
  ),
);
