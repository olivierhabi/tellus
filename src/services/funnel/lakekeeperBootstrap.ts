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
import { envWithDefault, requireSecret } from "../../utils/requireEnv";
import { funnelRuntimeConfig } from "../../config/funnelRuntime";
import {
  pipelineNamespace,
  slugForNamespace,
} from "../pipelines/icebergNamespace";

export interface LakekeeperBootstrapResult {
  reachable: boolean;
  warehouseId: string | null;
  namespacesCreated: number;
  objectTypesConsidered: number;
  /** PB-B4: _pipeline.<project_slug>.<pipeline_slug> namespaces. */
  pipelineNamespacesCreated: number;
  pipelinesConsidered: number;
  /** FNL-H6: _links.<ontology>.<link_type> namespaces. */
  linkNamespacesCreated: number;
  linkTypesConsidered: number;
  /** FNL-H6: namespace roots provisioned on fresh bootstrap. */
  rootNamespaces: string[];
  errors: Array<{ context: string; message: string }>;
}

export const LINK_NAMESPACE_ROOT = "_links";
export const PIPELINE_NAMESPACE_ROOT = "_pipeline";

export function linkNamespace(ontologyId: string, linkApiName: string): string {
  const ont = ontologyId.replace(/-/g, "_").slice(0, 32);
  const link = linkApiName.replace(/[^A-Za-z0-9_]/g, "_").toLowerCase();
  return `${LINK_NAMESPACE_ROOT}.ont_${ont}.${link}`;
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
      pipelineNamespacesCreated: 0,
      pipelinesConsidered: 0,
      linkNamespacesCreated: 0,
      linkTypesConsidered: 0,
      rootNamespaces: [],
      errors: [],
    };
  }

  const warehouseName = envWithDefault("LAKEKEEPER_WAREHOUSE", "tellus-funnel");
  let warehouseId: string | null = null;
  try {
    // F-P4-24: no minioadmin fallback.
    warehouseId = await client.ensureWarehouse({
      warehouseName,
      bucket: envWithDefault("ICEBERG_BUCKET", "iceberg-warehouse"),
      // Versioned container endpoint (per deployment profile). The
      // Lakekeeper container must use the docker-internal name
      // (http://minio:9000); a host loopback here fails warehouse
      // validation with a gzip-decompression error.
      endpoint: funnelRuntimeConfig().icebergContainerEndpoint,
      accessKeyId: requireSecret("S3_ACCESS_KEY_ID", "Lakekeeper bootstrap requires S3 access key."),
      secretAccessKey: requireSecret("S3_SECRET_ACCESS_KEY", "Lakekeeper bootstrap requires S3 secret key."),
      pathStyleAccess: true,
    });
  } catch (err) {
    errors.push({ context: "ensureWarehouse", message: (err as Error).message });
    return {
      reachable: true,
      warehouseId: null,
      namespacesCreated: 0,
      objectTypesConsidered: 0,
      pipelineNamespacesCreated: 0,
      pipelinesConsidered: 0,
      linkNamespacesCreated: 0,
      linkTypesConsidered: 0,
      rootNamespaces: [],
      errors,
    };
  }

  // FNL-H6 — ensure the top-level namespace roots exist so deploys that
  // only later register Object/Link Types still have `_funnel`, `_pipeline`,
  // `_links` available. ensureNamespace is hierarchical so this also
  // covers the per-OT/per-link child namespaces below.
  const rootNamespaces = ["_funnel", PIPELINE_NAMESPACE_ROOT, LINK_NAMESPACE_ROOT];
  for (const root of rootNamespaces) {
    try {
      await client.ensureNamespace(warehouseName, root);
    } catch (err) {
      errors.push({ context: `ensureNamespace(${root})`, message: (err as Error).message });
    }
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

  // PB-B4 (f) — _pipeline.<project_slug>.<pipeline_slug> namespaces.
  // Only pipelines that opted into output_format='iceberg' get a
  // namespace; leaving the rest alone keeps the catalog manifest
  // footprint small. We never fail the whole bootstrap on a single
  // pipeline error — Lakekeeper goes through many reconciliation loops
  // per day and a transient namespace failure is strictly cosmetic.
  const pipelines = await loadIcebergPipelines();
  let pipelineCreated = 0;
  for (const p of pipelines) {
    const ns = pipelineNamespace(p.projectSlug, p.pipelineSlug);
    try {
      await client.ensureNamespace(warehouseName, ns);
      pipelineCreated++;
    } catch (err) {
      errors.push({
        context: `ensureNamespace(${ns})`,
        message: (err as Error).message,
      });
    }
  }

  // FNL-H6 — per-link-type namespaces under `_links` for LT-B1's Iceberg
  // M2M tables. Only MANY_TO_MANY links with storage_backend='iceberg'
  // need a namespace; others stay on the CSV path.
  const linkRows = await loadIcebergLinkTypes();
  let linkCreated = 0;
  for (const lt of linkRows) {
    const ns = linkNamespace(lt.ontologyId, lt.apiName);
    try {
      await client.ensureNamespace(warehouseName, ns);
      linkCreated++;
    } catch (err) {
      errors.push({ context: `ensureNamespace(${ns})`, message: (err as Error).message });
    }
  }

  return {
    reachable: true,
    warehouseId,
    namespacesCreated: created,
    objectTypesConsidered: apiNames.length,
    pipelineNamespacesCreated: pipelineCreated,
    pipelinesConsidered: pipelines.length,
    linkNamespacesCreated: linkCreated,
    linkTypesConsidered: linkRows.length,
    rootNamespaces,
    errors,
  };
}

interface IcebergLinkRow {
  ontologyId: string;
  apiName: string;
}

async function loadIcebergLinkTypes(): Promise<IcebergLinkRow[]> {
  try {
    const res = await query(
      `SELECT ontology_id, api_name
         FROM link_type
        WHERE cardinality = 'MANY_TO_MANY'
          AND storage_backend = 'iceberg'`,
    );
    return (res.rows as Array<{ ontology_id: string; api_name: string }>).map((r) => ({
      ontologyId: r.ontology_id,
      apiName: r.api_name,
    }));
  } catch {
    return [];
  }
}

export async function listNamespaces(): Promise<{
  reachable: boolean;
  warehouseName: string;
  namespaces: string[];
}> {
  const client = getLakekeeperClient();
  const warehouseName = process.env.LAKEKEEPER_WAREHOUSE ?? "tellus-funnel";
  if (!(await client.isReachable())) {
    return { reachable: false, warehouseName, namespaces: [] };
  }
  const listed = await (client as unknown as { listNamespaces?: (w: string) => Promise<string[]> })
    .listNamespaces?.(warehouseName);
  return {
    reachable: true,
    warehouseName,
    namespaces: Array.isArray(listed) ? listed : [],
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

interface IcebergPipelineRow {
  projectSlug: string;
  pipelineSlug: string;
}

async function loadIcebergPipelines(): Promise<IcebergPipelineRow[]> {
  try {
    const res = await query(
      `SELECT p.id AS pipeline_id,
              p.name AS pipeline_name,
              pr.id AS project_id,
              pr.name AS project_name
         FROM pipelines p
         JOIN projects pr ON pr.id = p.project_id
        WHERE p.output_format = 'iceberg'`,
    );
    return res.rows.map(
      (r: {
        pipeline_id: string;
        pipeline_name: string;
        project_id: string;
        project_name: string;
      }) => ({
        projectSlug: slugForNamespace(`${r.project_name}_${r.project_id.slice(0, 8)}`),
        pipelineSlug: slugForNamespace(`${r.pipeline_name}_${r.pipeline_id.slice(0, 8)}`),
      }),
    );
  } catch {
    return [];
  }
}
