// ---------------------------------------------------------------------------
// Central object-type OpenSearch index-name derivation — FUNN-ISO-1.
//
// Before this module every call site interpolated the literal prefix
// "ontology-" inline (~40 places), which made the search-index namespace
// NON-configurable: a verify/test stack pointed at the shared OpenSearch
// container would read/write the very same indices as the dev stack — the
// search half of the cross-environment split-brain fixed for Temporal in
// FUNN-ISO.
//
// `OS_INDEX_PREFIX` (default "ontology-") namespaces every object-type
// index per deployment, exactly like TEMPORAL_NAMESPACE does for Temporal.
// The destructive-test guard (src/services/testing/destructiveTestGuard.ts)
// DENY-lists the dev/production default ("ontology-") for test environments,
// so renaming accident → hard failure at seed time, never silent sharing.
//
// IMPORTANT (naming invariant): index CREATION already slugified via
// getIndexName() (`toLowerCase().replace(/[^a-z0-9-]/g, "-")`), while many
// readers used raw `toLowerCase()`. For valid API names both agree; the
// helper slugifies so ALL call sites converge on the created-name shape.
// ---------------------------------------------------------------------------

import { objectIndexPrefix } from "../../config/environmentIdentity";

/**
 * Lower-case slug matching the historical index-name rule.
 * Exported for the migration/verify scripts that need the same transform.
 */
export function objectTypeIndexSlug(apiName: string): string {
  return apiName.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

/**
 * Flat (legacy, single-tenant) index name for an object type, with the
 * deployment's index prefix applied: "<prefix><apiNameSlug>"
 * (default prefix "ontology-").
 */
export function objectTypeIndexName(objectTypeApiName: string): string {
  return `${objectIndexPrefix()}${objectTypeIndexSlug(objectTypeApiName)}`;
}

/**
 * Tenant-scoped index name ("<prefix><ontologySlug>-<typeSlug>") — the
 * shape produced by getIndexName(apiName, ontologyId) for the multi-tenant
 * paradigm.
 */
export function scopedObjectTypeIndexName(
  ontologyId: string,
  objectTypeApiName: string,
): string {
  return `${objectIndexPrefix()}${objectTypeIndexSlug(ontologyId)}-${objectTypeIndexSlug(objectTypeApiName)}`;
}
