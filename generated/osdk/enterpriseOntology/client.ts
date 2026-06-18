// =====================================================================
// AUTO-GENERATED OSDK — do not edit by hand.
// Ontology: Enterprise Ontology (00000000-0000-0000-0000-000000000001)
// Version: 2026-06-09 12:23:14.108031+00
// Generated at: 2026-06-10T21:15:30.222Z
// Regenerate: npx tsx scripts/osdk-regen.ts --ontology 00000000-0000-0000-0000-000000000001
// =====================================================================

import type * as T from "./types";

export interface OsdkClientOptions {
  /** API base URL, e.g. "http://localhost:4000/api" — generated paths are "/v1/...". */
  baseUrl: string;
  /** Override the ontology id baked in at generation time (used by action apply). */
  ontologyId?: string;
  /** Custom fetch implementation (defaults to globalThis.fetch). */
  fetch?: typeof globalThis.fetch;
  /** Extra headers (e.g. Authorization) sent with every request. */
  headers?: Record<string, string>;
}

export interface PageResult<T> {
  data: T[];
  nextPageToken?: string | null;
  totalCount?: number;
}

export interface FetchPageOptions {
  pageSize?: number;
  pageToken?: string;
  /** Filter tree (same shape as POST /v1/objects/:apiName/search "where"). When set, the search endpoint is used. */
  where?: Record<string, unknown>;
  orderBy?: Array<{ field: string; direction: "asc" | "desc" }>;
  select?: string[];
}

export interface SearchBody {
  where?: Record<string, unknown>;
  filter?: Array<{ property: string; operator: string; value?: unknown; values?: unknown[] }>;
  pageSize?: number;
  pageToken?: string;
  orderBy?: Array<{ field: string; direction: "asc" | "desc" }>;
  select?: string[];
}

export interface AggregateBody {
  aggregations: Array<Record<string, unknown>>;
  where?: Record<string, unknown>;
  groupBy?: Array<Record<string, unknown>>;
}

export class OsdkError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "OsdkError";
  }
}

class HttpCore {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly headers: Record<string, string>;

  constructor(opts: OsdkClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.headers = opts.headers ?? {};
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(this.baseUrl + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...this.headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    if (!res.ok) {
      throw new OsdkError(`${method} ${path} → ${res.status}`, res.status, parsed);
    }
    return parsed as T;
  }
}

function asPage<T>(raw: unknown): PageResult<T> {
  if (Array.isArray(raw)) return { data: raw as T[] };
  return raw as PageResult<T>;
}

/** Typed accessor over the /v1/objects/:apiName data plane. */
export class ObjectSet<O, PK extends string | number> {
  constructor(
    private readonly core: HttpCore,
    /** Raw ontology apiName used in URLs (NOT the sanitized TS identifier). */
    public readonly apiName: string,
  ) {}

  /** GET /v1/objects/:apiName (or POST /search when `where` is provided). */
  async fetchPage(opts: FetchPageOptions = {}): Promise<PageResult<O>> {
    if (opts.where || opts.orderBy || opts.select) {
      const body: Record<string, unknown> = {};
      if (opts.where) body.where = opts.where;
      if (opts.orderBy) body.$orderBy = opts.orderBy;
      if (opts.pageSize != null) body.$pageSize = opts.pageSize;
      if (opts.pageToken) body.$pageToken = opts.pageToken;
      if (opts.select) body.$select = opts.select;
      const raw = await this.core.request<unknown>(
        "POST",
        `/v1/objects/${encodeURIComponent(this.apiName)}/search`,
        body,
      );
      return asPage<O>(raw);
    }
    const qs = new URLSearchParams();
    if (opts.pageSize != null) qs.set("pageSize", String(opts.pageSize));
    if (opts.pageToken) qs.set("pageToken", opts.pageToken);
    const q = qs.toString();
    const raw = await this.core.request<unknown>(
      "GET",
      `/v1/objects/${encodeURIComponent(this.apiName)}${q ? `?${q}` : ""}`,
    );
    return asPage<O>(raw);
  }

  /** GET /v1/objects/:apiName/:primaryKey */
  async get(primaryKey: PK): Promise<O> {
    const raw = await this.core.request<unknown>(
      "GET",
      `/v1/objects/${encodeURIComponent(this.apiName)}/${encodeURIComponent(String(primaryKey))}`,
    );
    const envelope = raw as { data?: O };
    return (envelope && typeof envelope === "object" && "data" in envelope
      ? (envelope.data as O)
      : (raw as O));
  }

  /** POST /v1/objects/:apiName/search */
  async search(query: SearchBody = {}): Promise<PageResult<O>> {
    const body: Record<string, unknown> = {};
    if (query.where) body.where = query.where;
    if (query.filter) body.filter = query.filter;
    if (query.orderBy) body.$orderBy = query.orderBy;
    if (query.pageSize != null) body.$pageSize = query.pageSize;
    if (query.pageToken) body.$pageToken = query.pageToken;
    if (query.select) body.$select = query.select;
    const raw = await this.core.request<unknown>(
      "POST",
      `/v1/objects/${encodeURIComponent(this.apiName)}/search`,
      body,
    );
    return asPage<O>(raw);
  }

  /** POST /v1/objects/:apiName/aggregate */
  async aggregate(body: AggregateBody): Promise<unknown> {
    return this.core.request<unknown>(
      "POST",
      `/v1/objects/${encodeURIComponent(this.apiName)}/aggregate`,
      body,
    );
  }
}

export interface LinkTraversalOptions {
  pageSize?: number;
  pageToken?: string;
}

function traverseLink<T>(
  core: HttpCore,
  sourceApiName: string,
  linkApiName: string,
  sourcePrimaryKey: string | number,
  opts: LinkTraversalOptions = {},
): Promise<PageResult<T>> {
  const qs = new URLSearchParams();
  if (opts.pageSize != null) qs.set("pageSize", String(opts.pageSize));
  if (opts.pageToken) qs.set("pageToken", opts.pageToken);
  const q = qs.toString();
  return core
    .request<unknown>(
      "GET",
      `/v1/objects/${encodeURIComponent(sourceApiName)}/${encodeURIComponent(String(sourcePrimaryKey))}/links/${encodeURIComponent(linkApiName)}${q ? `?${q}` : ""}`,
    )
    .then((raw) => asPage<T>(raw));
}

/** Ontology id baked in at generation time (override via OsdkClientOptions.ontologyId). */
export const DEFAULT_ONTOLOGY_ID = "00000000-0000-0000-0000-000000000001";

export class OsdkClient {
  private readonly core: HttpCore;
  private readonly ontologyId: string;

  /** Typed per-object-type accessors over /v1/objects/:apiName. */
  readonly objects: {
    Business: ObjectSet<T.Business, T.BusinessPrimaryKey>;
    CustomsDeclaration: ObjectSet<T.CustomsDeclaration, T.CustomsDeclarationPrimaryKey>;
    RealEstateProperty: ObjectSet<T.RealEstateProperty, T.RealEstatePropertyPrimaryKey>;
    Taxpayer: ObjectSet<T.Taxpayer, T.TaxpayerPrimaryKey>;
    TaxReturn: ObjectSet<T.TaxReturn, T.TaxReturnPrimaryKey>;
  };

  /** Typed action invokers — POST /v1/ontology/:ontologyId/actions/:apiName/apply. */
  readonly actions: {
    closeTaxReturn(params: T.CloseTaxReturnParameters): Promise<unknown>;
    fileTaxReturn(params: T.FileTaxReturnParameters): Promise<unknown>;
    flagForAudit(params: T.FlagForAuditParameters): Promise<unknown>;
    registerBusiness(params: T.RegisterBusinessParameters): Promise<unknown>;
    registerTaxpayer(params: T.RegisterTaxpayerParameters): Promise<unknown>;
    updateTaxpayerRiskScore(params: T.UpdateTaxpayerRiskScoreParameters): Promise<unknown>;
  };

  /** Link traversal helpers — GET /v1/objects/:src/:pk/links/:linkApiName. */
  readonly links: {
  };

  constructor(options: OsdkClientOptions) {
    this.core = new HttpCore(options);
    this.ontologyId = options.ontologyId ?? DEFAULT_ONTOLOGY_ID;
    this.objects = {
      Business: new ObjectSet<T.Business, T.BusinessPrimaryKey>(this.core, "Business"),
      CustomsDeclaration: new ObjectSet<T.CustomsDeclaration, T.CustomsDeclarationPrimaryKey>(this.core, "CustomsDeclaration"),
      RealEstateProperty: new ObjectSet<T.RealEstateProperty, T.RealEstatePropertyPrimaryKey>(this.core, "RealEstateProperty"),
      Taxpayer: new ObjectSet<T.Taxpayer, T.TaxpayerPrimaryKey>(this.core, "Taxpayer"),
      TaxReturn: new ObjectSet<T.TaxReturn, T.TaxReturnPrimaryKey>(this.core, "TaxReturn"),
    };
    this.actions = {
      closeTaxReturn: (params: T.CloseTaxReturnParameters) =>
        this.applyAction("closeTaxReturn", params as unknown as Record<string, unknown>),
      fileTaxReturn: (params: T.FileTaxReturnParameters) =>
        this.applyAction("fileTaxReturn", params as unknown as Record<string, unknown>),
      flagForAudit: (params: T.FlagForAuditParameters) =>
        this.applyAction("flagForAudit", params as unknown as Record<string, unknown>),
      registerBusiness: (params: T.RegisterBusinessParameters) =>
        this.applyAction("registerBusiness", params as unknown as Record<string, unknown>),
      registerTaxpayer: (params: T.RegisterTaxpayerParameters) =>
        this.applyAction("registerTaxpayer", params as unknown as Record<string, unknown>),
      updateTaxpayerRiskScore: (params: T.UpdateTaxpayerRiskScoreParameters) =>
        this.applyAction("updateTaxpayerRiskScore", params as unknown as Record<string, unknown>),
    };
    this.links = {
    };
  }

  /** POST /v1/ontology/:ontologyId/actions/:actionApiName/apply */
  private applyAction(actionApiName: string, parameters: Record<string, unknown>): Promise<unknown> {
    return this.core.request<unknown>(
      "POST",
      `/v1/ontology/${encodeURIComponent(this.ontologyId)}/actions/${encodeURIComponent(actionApiName)}/apply`,
      { parameters },
    );
  }
}
