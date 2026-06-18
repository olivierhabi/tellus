// =====================================================================
// AUTO-GENERATED OSDK — do not edit by hand.
// Ontology: Enterprise Ontology (00000000-0000-0000-0000-000000000001)
// Version: 2026-06-09 12:23:14.108031+00
// Generated at: 2026-06-10T21:15:30.222Z
// Regenerate: npx tsx scripts/osdk-regen.ts --ontology 00000000-0000-0000-0000-000000000001
// =====================================================================
//
// README
// ------
// Typed OSDK for the "Enterprise Ontology" ontology.
//   Ontology id: 00000000-0000-0000-0000-000000000001
//   Version:     2026-06-09 12:23:14.108031+00
//   Generated:   2026-06-10T21:15:30.222Z
//
// Usage:
//   import { OsdkClient } from "./index";
//   const client = new OsdkClient({ baseUrl: "http://localhost:4000/api" });
//   const page = await client.objects.<ObjectType>.fetchPage({ pageSize: 25 });
//   const one  = await client.objects.<ObjectType>.get(primaryKey);
//   await client.actions.<actionApiName>({ ...parameters });
//   const linked = await client.links.<linkApiName>(sourcePrimaryKey);

export * from "./types";
export * from "./client";
