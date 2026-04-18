// ---------------------------------------------------------------------------
// Lakekeeper bootstrap — Task B2
//
// Ensures the `tellus-funnel` warehouse exists in Lakekeeper and
// registers one namespace per Object Type. Called at server boot after
// the Postgres pool is up and the Ontology schema is in place.
// ---------------------------------------------------------------------------

import { query } from "../../db";
import { getLakekeeperClient } from "./lakekeeperClient";
import { funnelNamespace } from "./icebergCatalog";

export interface LakekeeperBootstrapResult {
  reachable: boolean;
  warehouseId: string | null;
  namespacesCreated: number;
  objectTypesConsidered: number;
  errors: Array<{ context: string; message: string }>;
}

export async function bootstrapLakekeeper(): Promise<LakekeeperBootstrapResult> {
  const client = getLakekeeperClient();
  const errors: LakekeeperBootstrapResult["errors"] = [];

  if (!(await client.isReachable())) {
    return {
      reachable: false,
      warehouseId: null,
      namespacesCreated: 0,
      objectTypesConsidered: 0,
      errors: [],
    };
  }

  const warehouseName = process.env.LAKEKEEPER_WAREHOUSE ?? "tellus-funnel";
  let warehouseId: string | null = null;
  try {
    warehouseId = await client.ensureWarehouse({
      warehouseName,
      bucket: process.env.ICEBERG_BUCKET ?? "iceberg-warehouse",
      endpoint: process.env.ICEBERG_S3_ENDPOINT ?? process.env.S3_ENDPOINT ?? "http://minio:9000",
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "minioadmin",
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "minioadmin",
      pathStyleAccess: true,
    });
  } catch (err) {
    errors.push({ context: "ensureWarehouse", message: (err as Error).message });
    return {
      reachable: true,
      warehouseId: null,
      namespacesCreated: 0,
      objectTypesConsidered: 0,
      errors,
    };
  }

  // For every registered Object Type, create the four Funnel-internal
  // namespaces. This lets downstream stages drop tables into Lakekeeper
  // without an extra create-namespace round-trip.
  const apiNames = await loadObjectTypeApiNames();
  let created = 0;
  for (const api of apiNames) {
    for (const kind of ["changelog", "merged", "index", "hydration"] as const) {
      const ns = funnelNamespace(api, kind);
      try {
        await client.ensureNamespace(warehouseName, ns);
        created++;
      } catch (err) {
        errors.push({ context: `ensureNamespace(${ns})`, message: (err as Error).message });
      }
    }
  }

  return {
    reachable: true,
    warehouseId,
    namespacesCreated: created,
    objectTypesConsidered: apiNames.length,
    errors,
  };
}

async function loadObjectTypeApiNames(): Promise<string[]> {
  try {
    const res = await query(`SELECT api_name FROM object_type`);
    return res.rows.map((r: { api_name: string }) => r.api_name);
  } catch {
    return [];
  }
}
