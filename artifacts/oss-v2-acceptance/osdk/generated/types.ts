// =====================================================================
// AUTO-GENERATED OSDK — do not edit by hand.
// Ontology: Enterprise Ontology (00000000-0000-0000-0000-000000000001)
// Version: 1785257479319
// Generated at: 2026-07-28T16:56:54.046Z
// Regenerate: npx tsx scripts/osdk-regen.ts --ontology 00000000-0000-0000-0000-000000000001
// =====================================================================

// ----- Object types -------------------------------------------------

/** RC Object (apiName: "RcObject", primaryKey: "id") */
export interface RcObject {
  readonly __rid?: string;
  readonly __primaryKey: string | number;
  readonly __apiName: "RcObject";
  id: string;
  name?: string | null;
}

/** Primary-key type of RcObject (property "id"). */
export type RcObjectPrimaryKey = string;

// ----- Link types ---------------------------------------------------

export interface LinkTypeDescriptor {
  apiName: string;
  displayName: string;
  cardinality: "ONE_TO_ONE" | "ONE_TO_MANY" | "MANY_TO_ONE" | "MANY_TO_MANY";
  sourceObjectType: string;
  targetObjectType: string;
}

export const LINK_TYPES = {
} as const;

// ----- Action parameter types ---------------------------------------
