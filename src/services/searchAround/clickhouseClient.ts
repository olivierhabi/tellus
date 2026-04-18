// ---------------------------------------------------------------------------
// ClickHouse HTTP client — Task B10
//
// Minimal client for ClickHouse's HTTP interface. We use JSONEachRow both
// ways: it's the format Quickwit's search_stream produces (for ingest)
// and it's what we read back for traversal results.
//
// Why HTTP and not the native TCP client: keeps dependencies zero, keeps
// the fetch/retry pattern identical to QuickwitClient so one set of
// observability hooks covers both, and it's fast enough for our payloads
// (millions of PKs in a single hop are the ceiling).
// ---------------------------------------------------------------------------

export interface ClickHouseClientOptions {
  baseUrl?: string;
  username?: string;
  password?: string;
  database?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
}

export class ClickHouseUnavailableError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "ClickHouseUnavailableError";
  }
}

export class ClickHouseApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseBody: string
  ) {
    super(message);
    this.name = "ClickHouseApiError";
  }
}

export class ClickHouseClient {
  private readonly baseUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly database: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(options: ClickHouseClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.CLICKHOUSE_URL ?? "http://localhost:8123").replace(/\/+$/, "");
    this.username = options.username ?? process.env.CLICKHOUSE_USER ?? "default";
    this.password = options.password ?? process.env.CLICKHOUSE_PASSWORD ?? "";
    this.database = options.database ?? process.env.CLICKHOUSE_DATABASE ?? "default";
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 3;
  }

  // -----------------------------------------------------------------------
  // exec() — send a SQL statement that returns rows (SELECT-like). Accepts
  // optional parameters. Always returns JSONEachRow rows.
  // -----------------------------------------------------------------------

  async exec<T = Record<string, unknown>>(sql: string): Promise<T[]> {
    const wrapped = /\bFORMAT\s+\w+/i.test(sql) ? sql : `${sql}\nFORMAT JSONEachRow`;
    const text = await this.request(wrapped);
    if (!text.trim()) return [];
    const rows: T[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      rows.push(JSON.parse(trimmed) as T);
    }
    return rows;
  }

  // -----------------------------------------------------------------------
  // command() — send DDL or a mutation that returns no rows.
  // -----------------------------------------------------------------------

  async command(sql: string): Promise<void> {
    await this.request(sql);
  }

  // -----------------------------------------------------------------------
  // insertJsonEachRow() — append rows into a table via JSONEachRow.
  // -----------------------------------------------------------------------

  async insertJsonEachRow(
    table: string,
    rows: Array<Record<string, unknown>>
  ): Promise<void> {
    if (rows.length === 0) return;
    const body = rows.map((r) => JSON.stringify(r)).join("\n");
    await this.request(`INSERT INTO ${table} FORMAT JSONEachRow`, body);
  }

  async health(): Promise<{ reachable: boolean; error?: string }> {
    try {
      await this.request("SELECT 1");
      return { reachable: true };
    } catch (err) {
      return { reachable: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private async request(sql: string, body?: string): Promise<string> {
    const url = new URL(this.baseUrl);
    url.searchParams.set("database", this.database);
    url.searchParams.set("query", sql);
    const authHeader =
      this.username || this.password
        ? `Basic ${Buffer.from(`${this.username}:${this.password}`).toString("base64")}`
        : undefined;

    let lastErr: unknown;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const resp = await this.fetchImpl(url.toString(), {
          method: "POST",
          headers: {
            ...(authHeader ? { authorization: authHeader } : {}),
            "content-type": body ? "application/octet-stream" : "text/plain",
          },
          body: body ?? "",
          signal: controller.signal,
        });
        clearTimeout(timer);
        const text = await resp.text();
        if (resp.status >= 500 || resp.status === 429) {
          lastErr = new ClickHouseApiError(
            `ClickHouse returned ${resp.status}`,
            resp.status,
            text
          );
          await this.sleep(this.backoffMs(attempt));
          continue;
        }
        if (resp.status >= 400) {
          throw new ClickHouseApiError(
            `ClickHouse returned ${resp.status}: ${text}`,
            resp.status,
            text
          );
        }
        return text;
      } catch (err) {
        clearTimeout(timer);
        lastErr = err;
        if (this.isTransient(err) && attempt < this.maxRetries - 1) {
          await this.sleep(this.backoffMs(attempt));
          continue;
        }
        if (this.isConnectionError(err)) {
          throw new ClickHouseUnavailableError(
            `ClickHouse unreachable at ${this.baseUrl}: ${(err as Error).message}`,
            err
          );
        }
        throw err;
      }
    }
    if (lastErr instanceof Error) throw lastErr;
    throw new Error(`ClickHouse request failed after ${this.maxRetries} attempts`);
  }

  private backoffMs(attempt: number): number {
    return Math.min(30_000, 200 * Math.pow(2, attempt));
  }
  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
  private isTransient(err: unknown): boolean {
    if (err instanceof ClickHouseApiError) return err.statusCode >= 500 || err.statusCode === 429;
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

let singleton: ClickHouseClient | null = null;
export function getClickHouseClient(): ClickHouseClient {
  if (!singleton) singleton = new ClickHouseClient();
  return singleton;
}
export function resetClickHouseClientForTesting(): void {
  singleton = null;
}
