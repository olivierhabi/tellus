// =====================================================================
// AUTO-GENERATED OSDK — do not edit by hand.
// Ontology: Enterprise Ontology (00000000-0000-0000-0000-000000000001)
// Version: 1785257479319
// Generated at: 2026-07-28T16:56:54.046Z
// Regenerate: npx tsx scripts/osdk-regen.ts --ontology 00000000-0000-0000-0000-000000000001
// =====================================================================
import WebSocket from "ws";

// v2 client — ObjectSet engine (OSS v2 / OSv2 parity).
// Endpoints: /v2/ontologies/{ontology}/objectSets/* and
// /v2/ontologies/{ontology}/actions/*.

export interface OsdkV2ClientOptions {
  /** API base URL, e.g. "http://localhost:3000/api". */
  baseUrl: string;
  /** Ontology identifier (defaults to the generation-time ontology). */
  ontologyId?: string;
  fetch?: typeof globalThis.fetch;
  headers?: Record<string, string>;
}

export type SearchJsonQueryV2 = Record<string, unknown>;

export type ObjectSetDefinition =
  | { type: "base"; objectType: string }
  | { type: "filter"; objectSet: ObjectSetDefinition; where: SearchJsonQueryV2 }
  | { type: "reference"; reference: string }
  | { type: "union"; objectSets: ObjectSetDefinition[] }
  | { type: "intersect"; objectSets: ObjectSetDefinition[] }
  | { type: "subtract"; objectSets: ObjectSetDefinition[] }
  | { type: "searchAround"; objectSet: ObjectSetDefinition; link: string }
  | { type: "interfaceBase"; interfaceType: string; includeAllBaseObjectProperties?: boolean }
  | { type: "asBaseObjectTypes"; objectSet: ObjectSetDefinition }
  | { type: "asType"; objectSet: ObjectSetDefinition; entityType: string }
  | {
      type: "nearestNeighbors";
      objectSet: ObjectSetDefinition;
      propertyIdentifier: { type: "property"; apiName: string };
      numNeighbors: number;
      similarityThreshold?: number;
      query: { type: "vector"; value: number[] } | { type: "text"; value: string };
    }
  | { type: "withProperties"; objectSet: ObjectSetDefinition; derivedProperties: Record<string, unknown> }
  | { type: "static"; objects: string[] }
  | { type: "methodInput" }
  | { type: "interfaceLinkSearchAround"; objectSet: ObjectSetDefinition; interfaceLink: string };

export interface OntologyObjectV2 {
  __primaryKey: string | number;
  __apiName: string;
  __rid?: string;
  [property: string]: unknown;
}

export interface SecuredPropertyValue<T = unknown> {
  value?: T;
  propertySecurityIndex?: number;
}

export interface PropertySecurities {
  disjunction: Array<{
    type: "propertyMarkingSummary";
    conjunctive?: string[];
  }>;
}

export type PropertyIdentifier =
  | { type: "property"; apiName: string }
  | { type: "structField"; propertyApiName: string; structFieldApiName: string }
  | { type: "propertyWithLoadLevel"; propertyIdentifier: PropertyIdentifier; loadLevel: PropertyLoadLevel }
  | { type: "titleProperty" }
  | { type: "primaryKeyProperty" };

export type PropertyLoadLevel =
  | { type: "applyReducersAndExtractMainValue" }
  | { type: "applyReducers" }
  | { type: "extractMainValue" }
  | { type: "noLoadLevel" };

export interface V2ReadContext {
  branch?: string;
  transactionId?: string;
  scenarioRid?: string;
  executeInMemoryOnly?: boolean;
}

export interface LoadObjectSetRequest {
  objectSet: ObjectSetDefinition;
  orderBy?: { orderType?: "fields" | "relevance"; fields: Array<{ field: string; direction?: "asc" | "desc" }> };
  select?: string[];
  selectV2?: PropertyIdentifier[];
  defaultLoadLevel?: PropertyLoadLevel;
  pageToken?: string;
  pageSize?: number;
  excludeRid?: boolean;
  snapshot?: boolean;
  loadPropertySecurities?: boolean;
  includeComputeUsage?: boolean;
  referenceSigningOptions?: { signMediaReferences?: boolean };
}

export interface LoadObjectSetResponse {
  data: OntologyObjectV2[];
  nextPageToken?: string | null;
  totalCount: string;
  propertySecurities: PropertySecurities[];
  computeUsage?: number;
}

export interface AggregateObjectSetRequest {
  objectSet: ObjectSetDefinition;
  aggregation: Array<Record<string, unknown>>;
  groupBy?: Array<Record<string, unknown>>;
  accuracy?: "REQUIRE_ACCURATE" | "ALLOW_APPROXIMATE";
}

export interface AggregateObjectSetResponse {
  excludedItems?: number;
  accuracy: "ACCURATE" | "APPROXIMATE";
  data: Array<{ group: Record<string, unknown>; metrics: Array<{ name: string; value: unknown }> }>;
}

export class OsdkV2Error extends Error {
  readonly errorCode?: string;
  readonly errorName?: string;
  readonly parameters?: Record<string, unknown>;
  readonly errorInstanceId?: string;
  readonly requestId?: string;
  readonly retryable: boolean;
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "OsdkV2Error";
    const envelope = body as {
      errorCode?: string;
      errorName?: string;
      parameters?: Record<string, unknown>;
      errorInstanceId?: string;
      requestId?: string;
      retryable?: boolean;
    } | undefined;
    this.errorCode = envelope?.errorCode;
    this.errorName = envelope?.errorName;
    this.parameters = envelope?.parameters;
    this.errorInstanceId = envelope?.errorInstanceId;
    this.requestId = envelope?.requestId;
    this.retryable =
      envelope?.retryable === true || status === 429 || status >= 500;
  }
}

export class OsdkV2Client {
  private readonly baseUrl: string;
  private readonly ontologyId: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly headers: Record<string, string>;

  constructor(opts: OsdkV2ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.ontologyId = opts.ontologyId ?? "00000000-0000-0000-0000-000000000001";
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.headers = opts.headers ?? {};
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: V2ReadContext,
  ): Promise<T> {
    const params = new URLSearchParams();
    if (query?.branch) params.set("branch", query.branch);
    if (query?.transactionId) params.set("transactionId", query.transactionId);
    if (query?.scenarioRid) params.set("scenarioRid", query.scenarioRid);
    if (query?.executeInMemoryOnly !== undefined) {
      params.set("executeInMemoryOnly", String(query.executeInMemoryOnly));
    }
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    const res = await this.fetchImpl(this.baseUrl + path + suffix, {
      method,
      headers: { "content-type": "application/json", ...this.headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
    if (!res.ok) {
      throw new OsdkV2Error(`${method} ${path} → ${res.status}`, res.status, parsed);
    }
    return parsed as T;
  }

  private normalizeObject(object: Record<string, unknown>): OntologyObjectV2 {
    return {
      ...object,
      __primaryKey:
        (object.__primaryKey ?? object.$primaryKey) as string | number,
      __apiName: String(object.__apiName ?? object.$apiName),
      ...((object.__rid ?? object.$rid) == null
        ? {}
        : { __rid: String(object.__rid ?? object.$rid) }),
    };
  }

  private normalizeLoadResponse<T extends LoadObjectSetResponse>(
    response: T,
  ): T {
    return {
      ...response,
      data: response.data.map((object) =>
        this.normalizeObject(object as Record<string, unknown>),
      ),
    };
  }

  /** POST /v2/ontologies/{ontology}/objectSets/loadObjects */
  loadObjects(req: LoadObjectSetRequest, context?: V2ReadContext): Promise<LoadObjectSetResponse> {
    return this.request(
      "POST",
      `/v2/ontologies/${encodeURIComponent(this.ontologyId)}/objectSets/loadObjects`,
      { select: [], ...req },
      context,
    );
  }

  async loadObjectsMultipleObjectTypes(
    req: LoadObjectSetRequest,
    context?: V2ReadContext,
  ): Promise<LoadObjectSetResponse & {
    interfaceToObjectTypeMappings?: Record<string, unknown>;
    interfaceToObjectTypeMappingsV2?: Record<string, unknown>;
  }> {
    const response = await this.request<LoadObjectSetResponse & {
      interfaceToObjectTypeMappings?: Record<string, unknown>;
      interfaceToObjectTypeMappingsV2?: Record<string, unknown>;
    }>(
      "POST",
      `/v2/ontologies/${encodeURIComponent(this.ontologyId)}/objectSets/loadObjectsMultipleObjectTypes`,
      { select: [], selectV2: [], ...req },
      context,
    );
    return this.normalizeLoadResponse(response);
  }

  async loadObjectsOrInterfaces(
    req: LoadObjectSetRequest,
    context?: V2ReadContext,
  ): Promise<LoadObjectSetResponse> {
    const response = await this.request<LoadObjectSetResponse>(
      "POST",
      `/v2/ontologies/${encodeURIComponent(this.ontologyId)}/objectSets/loadObjectsOrInterfaces`,
      { select: [], selectV2: [], ...req },
      context,
    );
    return this.normalizeLoadResponse(response);
  }

  loadLinks(
    objectSet: ObjectSetDefinition,
    links: string[],
    options: { pageToken?: string; includeComputeUsage?: boolean } = {},
    context?: V2ReadContext,
  ): Promise<{
    data: Array<{
      sourceObject: OntologyObjectV2;
      linkedObjects: Array<{
        targetObject: OntologyObjectV2;
        linkType: string;
      }>;
    }>;
    nextPageToken?: string;
    computeUsage?: number;
  }> {
    return this.request(
      "POST",
      `/v2/ontologies/${encodeURIComponent(this.ontologyId)}/objectSets/loadLinks`,
      { objectSet, links, ...options },
      context,
    );
  }

  /** POST /v2/ontologies/{ontology}/objectSets/aggregate */
  aggregate(req: AggregateObjectSetRequest, context?: V2ReadContext): Promise<AggregateObjectSetResponse> {
    return this.request(
      "POST",
      `/v2/ontologies/${encodeURIComponent(this.ontologyId)}/objectSets/aggregate`,
      { groupBy: [], ...req },
      context,
    );
  }

  /** POST /v2/ontologies/{ontology}/objectSets/createTemporary */
  createTemporaryObjectSet(objectSet: ObjectSetDefinition): Promise<{ objectSetRid: string }> {
    return this.request(
      "POST",
      `/v2/ontologies/${encodeURIComponent(this.ontologyId)}/objectSets/createTemporary?preview=true`,
      { objectSet },
    );
  }

  getObjectSet(objectSetRid: string): Promise<ObjectSetDefinition> {
    return this.request(
      "GET",
      `/v2/ontologies/${encodeURIComponent(this.ontologyId)}/objectSets/${encodeURIComponent(objectSetRid)}`,
    );
  }

  /** POST /v2/ontologies/{ontology}/actions/{actionType}/apply */
  applyAction(
    actionType: string,
    parameters: Record<string, unknown>,
    options?: { mode?: "VALIDATE_ONLY" | "VALIDATE_AND_EXECUTE"; returnEdits?: "ALL" | "NONE" },
  ): Promise<unknown> {
    return this.request(
      "POST",
      `/v2/ontologies/${encodeURIComponent(this.ontologyId)}/actions/${encodeURIComponent(actionType)}/apply`,
      { parameters, options },
    );
  }

  applyActionBatch(
    actionType: string,
    requests: Array<{ parameters: Record<string, unknown> }>,
    options?: { returnEdits?: "ALL" | "NONE" },
  ): Promise<unknown> {
    return this.request(
      "POST",
      `/v2/ontologies/${encodeURIComponent(this.ontologyId)}/actions/${encodeURIComponent(actionType)}/applyBatch`,
      { requests, options },
    );
  }

  subscribeObjectSets(
    request: {
      id: string;
      requests: Array<{
        objectSet: ObjectSetDefinition;
        propertySet: string[];
        referenceSet: string[];
        objectLoadingResponseOptions?: { shouldLoadObjectRids?: boolean };
      }>;
    },
    handlers: {
      onMessage: (message: Record<string, unknown>) => void;
      onError?: (error: Error) => void;
      resume?: { subscriptionId: string; cursor: string };
    },
    context?: V2ReadContext,
  ): { close: () => void; acknowledge: (subscriptionId: string, cursor: string) => void } {
    const url = new URL(
      this.baseUrl +
        `/v2/ontologies/${encodeURIComponent(this.ontologyId)}/objectSets/stream`,
    );
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    if (context?.branch) url.searchParams.set("branch", context.branch);
    if (context?.transactionId) url.searchParams.set("transactionId", context.transactionId);
    if (context?.scenarioRid) url.searchParams.set("scenarioRid", context.scenarioRid);
    const ws = new WebSocket(url, { headers: this.headers });
    ws.on("open", () => {
      if (handlers.resume) {
        ws.send(JSON.stringify({
          type: "resume",
          id: request.id,
          ...handlers.resume,
        }));
      } else {
        ws.send(JSON.stringify({ type: "subscribeRequests", ...request }));
      }
    });
    ws.on("message", (data) => {
      try {
        handlers.onMessage(JSON.parse(data.toString()) as Record<string, unknown>);
      } catch (error) {
        handlers.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    });
    ws.on("error", (error) => handlers.onError?.(error));
    return {
      close: () => ws.close(1000, "USER_CLOSED"),
      acknowledge: (subscriptionId, cursor) => {
        ws.send(JSON.stringify({ type: "ackCursor", subscriptionId, cursor }));
      },
    };
  }

  /** Helper: base set for an object type. */
  static base(objectType: string): ObjectSetDefinition {
    return { type: "base", objectType };
  }
}
