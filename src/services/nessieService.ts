/**
 * Thin Nessie client.
 *
 * Wraps just enough of the Nessie v2 REST API for the backend to:
 *
 *   • discover branches  (GET /api/v2/trees)
 *   • list namespaces    (GET /api/v2/trees/tree/main/contents/{namespace})
 *   • create namespaces  (POST /api/v2/trees/tree/main/contents)
 *   • create Iceberg tables as content entries
 *
 * Used by `routes/iceberg.ts` to expose a backend-facing API for the
 * Cypress + bash integration tests, and to demonstrate the
 * "Iceberg as the strategic table format" piece of the spec.
 */

const NESSIE_URL =
  process.env.NESSIE_URL || "http://localhost:19120/api/v2";

export interface NessieRef {
  type: string;
  name: string;
  hash: string;
}

export async function listBranches(): Promise<NessieRef[]> {
  const res = await fetch(`${NESSIE_URL}/trees`);
  if (!res.ok) throw new Error(`nessie list trees ${res.status}`);
  const body = (await res.json()) as { references: NessieRef[] };
  return body.references ?? [];
}

export async function getConfig(): Promise<Record<string, unknown>> {
  const res = await fetch(`${NESSIE_URL}/config`);
  if (!res.ok) throw new Error(`nessie config ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

interface NessieEntry {
  type: string;
  name: { elements: string[] };
  contentId?: string;
}

/** Walk the entries on a branch — returns elements like ["ontology", "object_type"]. */
export async function listEntries(branch = "main"): Promise<NessieEntry[]> {
  // v2 entries endpoint lives under /trees/{ref}/entries, where ref can
  // be the branch name on its own.
  const res = await fetch(`${NESSIE_URL}/trees/${branch}/entries`);
  if (!res.ok) throw new Error(`nessie list entries ${res.status}`);
  const body = (await res.json()) as { entries?: NessieEntry[] };
  return body.entries ?? [];
}

/** Get the current head hash for a branch — needed for commits. */
async function branchHead(branch = "main"): Promise<string> {
  const refs = await listBranches();
  const ref = refs.find((r) => r.name === branch);
  if (!ref) throw new Error(`nessie branch '${branch}' not found`);
  return ref.hash;
}

/**
 * Create (or update) a NAMESPACE entry on a branch. Idempotent: returns
 * the namespace's content id whether it was newly created or already
 * existed.
 */
export async function createNamespace(
  namespace: string[],
  branch = "main",
): Promise<{ name: string[]; contentId: string }> {
  const existing = await listEntries(branch);
  const found = existing.find(
    (e) => e.type === "NAMESPACE" && JSON.stringify(e.name.elements) === JSON.stringify(namespace),
  );
  if (found) {
    return { name: namespace, contentId: found.contentId ?? "existing" };
  }

  const head = await branchHead(branch);
  // Nessie v2 expects the expected hash on the branch reference encoded
  // in the URL path as `branch@hash`. The body carries only `commitMeta`
  // and `operations`.
  const body = {
    commitMeta: {
      message: `create namespace ${namespace.join(".")}`,
      author: "tellus-backend",
    },
    operations: [
      {
        type: "PUT",
        key: { elements: namespace },
        content: {
          type: "NAMESPACE",
          elements: namespace,
        },
      },
    ],
  };
  const res = await fetch(
    `${NESSIE_URL}/trees/${encodeURIComponent(`${branch}@${head}`)}/history/commit`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`nessie create namespace ${res.status}: ${text}`);
  }
  return { name: namespace, contentId: "created" };
}

/**
 * Create an ICEBERG_TABLE content entry. The metadata location points at
 * MinIO (`s3://iceberg-warehouse/...`); we don't write the metadata file
 * itself in this dev integration — we only register the table reference
 * so the catalog has something to list. A real production write would
 * use the Iceberg Java/Python writers + MinIO bucket.
 */
export async function createIcebergTableRef(
  namespace: string[],
  tableName: string,
  metadataLocation: string,
  branch = "main",
): Promise<{ key: string[] }> {
  const head = await branchHead(branch);
  const key = [...namespace, tableName];
  const body = {
    commitMeta: {
      message: `register iceberg table ${key.join(".")}`,
      author: "tellus-backend",
    },
    operations: [
      {
        type: "PUT",
        key: { elements: key },
        content: {
          type: "ICEBERG_TABLE",
          metadataLocation,
          snapshotId: 1,
          schemaId: 1,
          specId: 1,
          sortOrderId: 1,
        },
      },
    ],
  };
  const res = await fetch(
    `${NESSIE_URL}/trees/${encodeURIComponent(`${branch}@${head}`)}/history/commit`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`nessie create table ${res.status}: ${text}`);
  }
  return { key };
}
