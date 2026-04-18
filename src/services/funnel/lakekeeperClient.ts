// ---------------------------------------------------------------------------
// Lakekeeper client — Task B2
//
// Thin wrapper over the Lakekeeper management + Iceberg REST APIs.
//
// Responsibilities:
//   • ensureWarehouse — create the `tellus-funnel` warehouse on first use
//     (S3 backed by MinIO). Idempotent.
//   • ensureNamespace — create `_funnel.<object_type>.*` namespaces.
//   • listTables      — introspection endpoint for admin panels.
//
// Production deployments move warehouse creation + OIDC credentials into
// the provisioning pipeline. The in-app `ensureWarehouse` below is safe
// for dev and single-tenant prod, but do NOT rely on it to rotate
// credentials — that's a platform job.
// ---------------------------------------------------------------------------

export interface LakekeeperOptions {
  baseUrl?: string;
  timeoutMs?: number;
}

export interface WarehouseConfig {
  warehouseName: string;
  bucket: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  pathStyleAccess?: boolean;
}

export class LakekeeperUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LakekeeperUnavailableError";
  }
}

export class LakekeeperApiError extends Error {
  constructor(message: string, public readonly statusCode: number, public readonly body: string) {
    super(message);
    this.name = "LakekeeperApiError";
  }
}

export class LakekeeperClient {
  readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: LakekeeperOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.LAKEKEEPER_URL ?? "http://localhost:8181").replace(
      /\/+$/,
      ""
    );
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async isReachable(): Promise<boolean> {
    try {
      const res = await this.request("/management/v1/info", { method: "GET" });
      return res.ok;
    } catch {
      return false;
    }
  }

  async getInfo(): Promise<Record<string, unknown>> {
    const res = await this.request("/management/v1/info", { method: "GET" });
    return (await res.json()) as Record<string, unknown>;
  }

  async listWarehouses(): Promise<Array<{ id?: string; name: string }>> {
    const res = await this.request("/management/v1/warehouse", { method: "GET" });
    const body = (await res.json()) as { warehouses?: Array<{ id?: string; name: string }> };
    return body.warehouses ?? [];
  }

  /**
   * Create the warehouse if it does not exist. Returns the warehouse id.
   * Idempotent — if a warehouse with this name already exists we return
   * its id without touching the storage profile.
   */
  async ensureWarehouse(cfg: WarehouseConfig): Promise<string> {
    const existing = await this.listWarehouses();
    const hit = existing.find((w) => w.name === cfg.warehouseName);
    if (hit?.id) return hit.id;

    const res = await this.request("/management/v1/warehouse", {
      method: "POST",
      body: JSON.stringify({
        "warehouse-name": cfg.warehouseName,
        "project-id": "00000000-0000-0000-0000-000000000000",
        "storage-profile": {
          type: "s3",
          bucket: cfg.bucket,
          endpoint: cfg.endpoint,
          region: cfg.region ?? "us-east-1",
          "path-style-access": cfg.pathStyleAccess ?? true,
          "sts-enabled": false,
          "key-prefix": "_funnel",
          flavor: "minio",
        },
        "storage-credential": {
          type: "s3",
          "credential-type": "access-key",
          "aws-access-key-id": cfg.accessKeyId,
          "aws-secret-access-key": cfg.secretAccessKey,
        },
      }),
    });
    const body = (await res.json()) as { "warehouse-id"?: string };
    if (!body["warehouse-id"]) {
      throw new LakekeeperApiError("unexpected response", res.status, JSON.stringify(body));
    }
    return body["warehouse-id"];
  }

  /**
   * Iceberg REST — create a namespace. The Iceberg REST `prefix` is the
   * warehouse UUID (not the warehouse name — a common footgun). We
   * resolve the name to an id via listWarehouses() on first call and
   * cache it for the lifetime of this client.
   *
   * Nested namespaces ("_funnel.orders.changelog") are created lazily
   * from shortest to deepest; existing levels short-circuit.
   */
  async ensureNamespace(warehouseName: string, namespace: string): Promise<void> {
    const prefix = await this.resolveWarehouseId(warehouseName);
    const parts = namespace.split(".").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) {
      const slice = parts.slice(0, i);
      const path = `/catalog/v1/${prefix}/namespaces`;
      try {
        const res = await this.request(path, {
          method: "POST",
          body: JSON.stringify({ namespace: slice }),
        });
        if (!res.ok && res.status !== 409) {
          const text = await res.text();
          // 409 is "already exists" — also surfaces as specific error body
          // in some Lakekeeper versions. Treat as idempotent if matched.
          if (/already exists/i.test(text)) continue;
          throw new LakekeeperApiError(
            `ensureNamespace ${slice.join(".")}: ${res.status}`,
            res.status,
            text
          );
        }
      } catch (err) {
        if (err instanceof LakekeeperApiError) throw err;
        throw new LakekeeperUnavailableError((err as Error).message);
      }
    }
  }

  /**
   * Iceberg REST — register (create) a table under a namespace. Idempotent
   * on the (namespace, tableName) pair: a 409 / "AlreadyExists" is
   * treated as success so callers can invoke this from `commitSnapshot`
   * without tracking whether they've registered a given table before.
   *
   * `schemaFields` is the Iceberg schema: each field must carry an
   * integer `id`, a `name`, a `type`, and `required`.
   */
  async createTable(input: {
    warehouseName: string;
    namespace: string;
    tableName: string;
    /** Ignored on Lakekeeper v0.12+: the catalog picks the storage
     *  location from the warehouse's storage-profile. Passing it
     *  causes v0.12 to reject the request. We keep the parameter in
     *  the interface so callers' existing call sites don't break. */
    location?: string;
    schemaFields: Array<{
      id: number;
      name: string;
      type: string;
      required?: boolean;
    }>;
    properties?: Record<string, string>;
  }): Promise<{ created: boolean; metadataLocation?: string | null }> {
    const prefix = await this.resolveWarehouseId(input.warehouseName);
    const nsEncoded = encodeURIComponent(input.namespace.split(".").join("\u001f"));
    const path = `/catalog/v1/${prefix}/namespaces/${nsEncoded}/tables`;
    // Lakekeeper v0.12 accepts the Iceberg REST `CreateTableRequest`
    // shape with `stage-create: false` — that COMMITS an empty initial
    // metadata.json in the warehouse storage-profile's S3 root and
    // makes the table immediately discoverable via `GET /tables`.
    // Using `stage-create: true` creates staged metadata that does NOT
    // show up in table listings (Iceberg REST spec behaviour).
    const body = {
      name: input.tableName,
      schema: {
        type: "struct",
        "schema-id": 0,
        fields: input.schemaFields.map((f) => ({
          id: f.id,
          name: f.name,
          required: f.required ?? false,
          type: f.type,
        })),
      },
      "partition-spec": { "spec-id": 0, fields: [] },
      "write-order": { "order-id": 0, fields: [] },
      "stage-create": false,
      properties: {
        "format-version": "2",
        "write.delete.mode": "copy-on-write",
        "history.expire.min-snapshots-to-keep": "100",
        ...(input.properties ?? {}),
      },
    };
    try {
      const res = await this.request(path, {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (res.status === 200 || res.status === 201) {
        const resp = (await res.json()) as { "metadata-location"?: string | null };
        return { created: true, metadataLocation: resp["metadata-location"] ?? null };
      }
      if (res.status === 409) return { created: false };
      const text = await res.text();
      if (/already exists/i.test(text)) return { created: false };
      throw new LakekeeperApiError(`createTable ${input.tableName}: ${res.status}`, res.status, text);
    } catch (err) {
      if (err instanceof LakekeeperApiError) throw err;
      throw new LakekeeperUnavailableError((err as Error).message);
    }
  }

  async listTables(warehouseName: string, namespace: string): Promise<string[]> {
    const prefix = await this.resolveWarehouseId(warehouseName);
    // Iceberg REST uses URL-safe unit-separator (U+001F) to delimit
    // multi-level namespaces in the path segment.
    const nsEncoded = encodeURIComponent(namespace.split(".").join("\u001f"));
    const path = `/catalog/v1/${prefix}/namespaces/${nsEncoded}/tables`;
    try {
      const res = await this.request(path, { method: "GET" });
      if (!res.ok) return [];
      const body = (await res.json()) as {
        identifiers?: Array<{ name: string; namespace: string[] }>;
      };
      return (body.identifiers ?? []).map((t) => `${t.namespace.join(".")}.${t.name}`);
    } catch {
      return [];
    }
  }

  // -----------------------------------------------------------------------
  // Name → id resolution cache.
  // -----------------------------------------------------------------------
  private readonly idByName = new Map<string, string>();

  private async resolveWarehouseId(warehouseName: string): Promise<string> {
    const hit = this.idByName.get(warehouseName);
    if (hit) return hit;
    const warehouses = await this.listWarehouses();
    const match = warehouses.find((w) => w.name === warehouseName);
    const id = match?.id;
    if (!id) {
      throw new LakekeeperApiError(
        `warehouse '${warehouseName}' not found`,
        404,
        JSON.stringify(warehouses)
      );
    }
    this.idByName.set(warehouseName, id);
    return id;
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      return await fetch(this.baseUrl + path, {
        ...init,
        signal: ctrl.signal,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...(init.headers ?? {}),
        },
      });
    } finally {
      clearTimeout(tid);
    }
  }
}

let singleton: LakekeeperClient | null = null;
export function getLakekeeperClient(): LakekeeperClient {
  if (singleton) return singleton;
  singleton = new LakekeeperClient();
  return singleton;
}
