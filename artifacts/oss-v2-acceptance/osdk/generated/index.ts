// =====================================================================
// AUTO-GENERATED OSDK — do not edit by hand.
// Ontology: Enterprise Ontology (00000000-0000-0000-0000-000000000001)
// Version: 1785257479319
// Generated at: 2026-07-28T16:56:54.046Z
// Regenerate: npx tsx scripts/osdk-regen.ts --ontology 00000000-0000-0000-0000-000000000001
// =====================================================================
//
// README
// ------
// Typed OSDK for the "Enterprise Ontology" ontology.
//   Ontology id: 00000000-0000-0000-0000-000000000001
//   Version:     1785257479319
//   Generated:   2026-07-28T16:56:54.046Z
//
// Usage:
//   import { OsdkClient } from "./index";
//   const client = new OsdkClient({ baseUrl: "http://localhost:4000/api" });
//   const page = await client.objects.<ObjectType>.fetchPage({ pageSize: 25 });
//   const one  = await client.objects.<ObjectType>.get(primaryKey);
//   await client.actions.<actionApiName>({ ...parameters });
//   const linked = await client.links.<linkApiName>(sourcePrimaryKey);

export * from "./types.js";
export * from "./client.js";
export * from "./clientV2.js";
