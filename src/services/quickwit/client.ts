// ---------------------------------------------------------------------------
// Quickwit REST client — Task B6
//
// Thin HTTP wrapper over Quickwit's metastore + search APIs. Everything the
// Funnel needs (create index, configure Kafka source, search, ingest, split
// metadata, split cache prefetch) funnels through this one client so that
// tests can stub a single fetch implementation and retries/logging sit in
// one place.
//
// The Quickwit host is read from QUICKWIT_URL (default http://localhost:7280).
// If Quickwit isn't running (ECONNREFUSED) the client surfaces that as a
// `QuickwitUnavailableError`, which callers may choose to treat as
// non-fatal (e.g. the funnel pipeline logs and falls back to Elasticsearch
// during the dual-write period defined in tasks-02's framing notes).
// ---------------------------------------------------------------------------

import type { QuickwitIndexConfig } from "./docMapping";

export interface QuickwitClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface QuickwitSplit {
  split_id: string;
  index_id: string;
  num_docs: number;
  uncompressed_docs_size_bytes: number;
  time_range?: { start: number; end: number } | null;
  footer_offsets?: { start: number; end: number };
  split_state: "Staged" | "Published" | "MarkedForDeletion";
  publish_timestamp?: number | null;
  replaced_split_ids?: string[];
}

export interface QuickwitKafkaSource {
  source_id: string;
  source_type: "kafka";
  num_pipelines: number;
  params: {
    topic: string;
    client_params: Record<string, unknown>;
  };
}

export interface QuickwitSearchRequest {
  query?: string;
  start_offset?: number;
  max_hits?: number;
  sort_by?: string;
  search_fields?: string[];
  snippet_fields?: string[];
  aggs?: Record<string, unknown>;
}

export interface QuickwitSearchResponse {
  num_hits: number;
  hits: Array<Record<string, unknown>>;
  elapsed_time_micros: number;
  errors?: string[];
}

export class QuickwitUnavailableError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "QuickwitUnavailableError";
  }
}

export class QuickwitApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseBody: string
  ) {
    super(message);
    this.name = "QuickwitApiError";
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class QuickwitClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(options: QuickwitClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.QUICKWIT_URL ?? "http://localhost:7280").replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 3;
  }

  // -----------------------------------------------------------------------
  // Index management
  // -----------------------------------------------------------------------

  async createIndex(config: QuickwitIndexConfig): Promise<QuickwitIndexConfig> {
    return this.request<QuickwitIndexConfig>("POST", "/api/v1/indexes", {
      body: config,
      headers: { "content-type": "application/json" },
    });
  }

  async updateIndex(config: QuickwitIndexConfig): Promise<QuickwitIndexConfig> {
    return this.request<QuickwitIndexConfig>(
      "PUT",
      `/api/v1/indexes/${encodeURIComponent(config.index_id)}`,
      { body: config, headers: { "content-type": "application/json" } }
    );
  }

  async deleteIndex(indexId: string): Promise<void> {
    await this.request<unknown>("DELETE", `/api/v1/indexes/${encodeURIComponent(indexId)}`);
  }

  async describeIndex(indexId: string): Promise<QuickwitIndexConfig | null> {
    try {
      return await this.request<QuickwitIndexConfig>(
        "GET",
        `/api/v1/indexes/${encodeURIComponent(indexId)}`
      );
    } catch (err) {
      if (err instanceof QuickwitApiError && err.statusCode === 404) return null;
      throw err;
    }
  }

  async indexExists(indexId: string): Promise<boolean> {
    return (await this.describeIndex(indexId)) !== null;
  }

  // -----------------------------------------------------------------------
  // Sources — Kafka source is how B6 streams merged rows into Quickwit
  // -----------------------------------------------------------------------

  async createKafkaSource(
    indexId: string,
    sourceId: string,
    topic: string,
    kafkaBrokers: string[]
  ): Promise<QuickwitKafkaSource> {
    const source: QuickwitKafkaSource = {
      source_id: sourceId,
      source_type: "kafka",
      num_pipelines: 1,
      params: {
        topic,
        client_params: {
          "bootstrap.servers": kafkaBrokers.join(","),
          "group.id": `quickwit-${indexId}`,
          "enable.auto.commit": false,
        },
      },
    };
    return this.request<QuickwitKafkaSource>(
      "POST",
      `/api/v1/indexes/${encodeURIComponent(indexId)}/sources`,
      { body: source, headers: { "content-type": "application/json" } }
    );
  }

  // -----------------------------------------------------------------------
  // Ingest — one-shot JSON upload (used as a fallback + test hook)
  // -----------------------------------------------------------------------

  async ingestDocuments(
    indexId: string,
    docs: Array<Record<string, unknown>>,
    commit: "force" | "wait_for" | "auto" = "auto"
  ): Promise<{ num_docs_for_processing: number }> {
    const body = docs.map((d) => JSON.stringify(d)).join("\n");
    const qs = commit === "auto" ? "" : `?commit=${commit}`;
    return this.request<{ num_docs_for_processing: number }>(
      "POST",
      `/api/v1/${encodeURIComponent(indexId)}/ingest${qs}`,
      { body, headers: { "content-type": "application/x-ndjson" } }
    );
  }

  // -----------------------------------------------------------------------
  // Search
  // -----------------------------------------------------------------------

  async search(indexId: string, req: QuickwitSearchRequest): Promise<QuickwitSearchResponse> {
    return this.request<QuickwitSearchResponse>(
      "POST",
      `/api/v1/${encodeURIComponent(indexId)}/search`,
      { body: req, headers: { "content-type": "application/json" } }
    );
  }

  // -----------------------------------------------------------------------
  // Search-stream — Task B10 fast-path (hops ≤ 100k).
  // Quickwit streams a single fast-field column as `csv` or
  // `clickHouseRowBinary`. We default to CSV (one value per line) and
  // parse client-side; callers that need 3M+ rows/sec use ClickHouse
  // row-binary — kept as an opt-in flag.
  // -----------------------------------------------------------------------

  async searchStream(
    indexId: string,
    req: {
      query: string;
      fastField: string;
      outputFormat?: "csv" | "click_house_row_binary";
      searchFields?: string[];
      startTimestamp?: number;
      endTimestamp?: number;
    }
  ): Promise<string[]> {
    const format = req.outputFormat ?? "csv";
    const qs = new URLSearchParams({
      query: req.query,
      fast_field: req.fastField,
      output_format: format,
    });
    if (req.searchFields && req.searchFields.length > 0) {
      qs.set("search_field", req.searchFields.join(","));
    }
    if (req.startTimestamp != null) {
      qs.set("start_timestamp", String(req.startTimestamp));
    }
    if (req.endTimestamp != null) {
      qs.set("end_timestamp", String(req.endTimestamp));
    }
    const path = `/api/v1/${encodeURIComponent(indexId)}/search/stream?${qs.toString()}`;
    // The stream endpoint returns raw CSV (one value per line, no
    // header) — route through a raw-text request so we don't try to
    // parse it as JSON.
    const text = await this.requestRaw("GET", path);
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  private async requestRaw(method: string, path: string): Promise<string> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const resp = await this.fetchImpl(url, {
        method,
        signal: controller.signal,
        headers: { accept: "text/csv" },
      });
      clearTimeout(timer);
      const text = await resp.text();
      if (resp.status >= 400) {
        throw new QuickwitApiError(
          `Quickwit ${method} ${path} returned ${resp.status}: ${text}`,
          resp.status,
          text
        );
      }
      return text;
    } catch (err) {
      clearTimeout(timer);
      if (this.isConnectionError(err)) {
        throw new QuickwitUnavailableError(
          `Quickwit is unreachable at ${this.baseUrl}: ${(err as Error).message}`,
          err
        );
      }
      throw err;
    }
  }

  // -----------------------------------------------------------------------
  // Split metadata — used by the Indexing activity to detect publish
  // -----------------------------------------------------------------------

  async listSplits(
    indexId: string,
    splitStates: Array<"Staged" | "Published" | "MarkedForDeletion"> = ["Published"]
  ): Promise<QuickwitSplit[]> {
    const qs = splitStates.map((s) => `split_states=${s}`).join("&");
    const result = await this.request<{ splits: QuickwitSplit[] }>(
      "GET",
      `/api/v1/indexes/${encodeURIComponent(indexId)}/splits?${qs}`
    );
    return result.splits;
  }

  // -----------------------------------------------------------------------
  // Split cache prefetch — forces searcher to warm cache before query hits
  // Used by the Hydration activity (B8).
  // -----------------------------------------------------------------------

  async prefetchSplits(indexId: string, splitIds: string[]): Promise<void> {
    if (splitIds.length === 0) return;
    await this.request<unknown>(
      "POST",
      `/api/v1/searcher/split-cache/prefetch`,
      {
        body: { index_id: indexId, split_ids: splitIds },
        headers: { "content-type": "application/json" },
      }
    );
  }

  // -----------------------------------------------------------------------
  // Health
  // -----------------------------------------------------------------------

  async health(): Promise<{ reachable: boolean; cluster?: string; error?: string }> {
    try {
      const info = await this.request<{ cluster_id?: string }>("GET", "/api/v1/cluster");
      return { reachable: true, cluster: info.cluster_id };
    } catch (err) {
      return {
        reachable: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // -----------------------------------------------------------------------
  // Internal request plumbing — retries on transient network errors
  // -----------------------------------------------------------------------

  private async request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; headers?: Record<string, string> } = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { accept: "application/json", ...(opts.headers ?? {}) };
    const bodyStr = this.encodeBody(opts.body);

    let lastErr: unknown;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const resp = await this.fetchImpl(url, {
          method,
          headers,
          body: bodyStr,
          signal: controller.signal,
        });
        clearTimeout(timer);
        const text = await resp.text();
        if (resp.status >= 500 || resp.status === 429) {
          lastErr = new QuickwitApiError(
            `Quickwit ${method} ${path} returned ${resp.status}`,
            resp.status,
            text
          );
          await this.sleep(this.backoffMs(attempt));
          continue;
        }
        if (resp.status >= 400) {
          throw new QuickwitApiError(
            `Quickwit ${method} ${path} returned ${resp.status}: ${text}`,
            resp.status,
            text
          );
        }
        if (!text) return undefined as unknown as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          return text as unknown as T;
        }
      } catch (err) {
        clearTimeout(timer);
        lastErr = err;
        if (this.isTransient(err) && attempt < this.maxRetries - 1) {
          await this.sleep(this.backoffMs(attempt));
          continue;
        }
        if (this.isConnectionError(err)) {
          throw new QuickwitUnavailableError(
            `Quickwit is unreachable at ${this.baseUrl}: ${(err as Error).message}`,
            err
          );
        }
        throw err;
      }
    }
    if (lastErr instanceof Error) throw lastErr;
    throw new Error(`Quickwit ${method} ${path} failed after ${this.maxRetries} attempts`);
  }

  private encodeBody(body: unknown): string | undefined {
    if (body === undefined || body === null) return undefined;
    if (typeof body === "string") return body;
    return JSON.stringify(body);
  }

  private backoffMs(attempt: number): number {
    return Math.min(30_000, 200 * Math.pow(2, attempt));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private isTransient(err: unknown): boolean {
    if (err instanceof QuickwitApiError) return err.statusCode >= 500 || err.statusCode === 429;
    return this.isConnectionError(err);
  }

  private isConnectionError(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const e = err as { name?: string; code?: string; message?: string };
    if (e.name === "AbortError") return true;
    const code = e.code ?? "";
    const msg = e.message ?? "";
    return (
      code === "ECONNREFUSED" ||
      code === "ECONNRESET" ||
      code === "ETIMEDOUT" ||
      code === "EAI_AGAIN" ||
      /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT/i.test(msg)
    );
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let singleton: QuickwitClient | null = null;

export function getQuickwitClient(): QuickwitClient {
  if (!singleton) singleton = new QuickwitClient();
  return singleton;
}

export function resetQuickwitClientForTesting(): void {
  singleton = null;
}
