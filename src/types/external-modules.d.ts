// ---------------------------------------------------------------------------
// Ambient declarations for optional/peer modules referenced by the
// connectivity surface. These packages are intentionally NOT in dependencies
// — operators install them on the worker / build runner images where the
// underlying driver is actually required. Declaring them here keeps the
// `tsc --noEmit` of the API server clean.
//
// If/when these packages are added to package.json, their real .d.ts files
// take precedence and these shims become inert.
// ---------------------------------------------------------------------------

declare module "bullmq" {
  export interface JobsOptions {
    jobId?: string;
    priority?: number;
    attempts?: number;
    backoff?: unknown;
    delay?: number;
    removeOnComplete?: boolean | number | { age?: number; count?: number };
    removeOnFail?: boolean | number | { age?: number; count?: number };
  }
  export class Queue {
    constructor(name: string, opts?: Record<string, unknown>);
    add(name: string, data: unknown, opts?: JobsOptions): Promise<{ id: string }>;
    getJob(id: string): Promise<{ id: string; data: unknown; remove: () => Promise<void> } | null>;
    close(): Promise<void>;
  }
  export class QueueEvents {
    constructor(name: string, opts?: Record<string, unknown>);
    on(event: string, listener: (...args: unknown[]) => void): this;
    close(): Promise<void>;
  }
  export class Worker {
    constructor(
      name: string,
      processor: (job: { id: string; data: unknown }) => Promise<unknown>,
      opts?: Record<string, unknown>,
    );
    on(event: string, listener: (...args: unknown[]) => void): this;
    close(): Promise<void>;
  }
}

declare module "ioredis" {
  export class Redis {
    constructor(opts?: string | Record<string, unknown>);
    publish(channel: string, message: string): Promise<number>;
    subscribe(...channels: string[]): Promise<number>;
    on(event: string, listener: (...args: unknown[]) => void): this;
    quit(): Promise<"OK">;
    disconnect(): void;
    get(key: string): Promise<string | null>;
    set(key: string, value: string, ...args: unknown[]): Promise<string>;
    del(key: string): Promise<number>;
  }
  export default Redis;
}

declare module "@kubernetes/client-node" {
  export class KubeConfig {
    loadFromDefault(): void;
    loadFromCluster(): void;
    makeApiClient<T>(api: new (...args: unknown[]) => T): T;
  }
  export class BatchV1Api {
    createNamespacedJob(namespace: string, body: unknown): Promise<{ body: unknown }>;
    readNamespacedJobStatus(name: string, namespace: string): Promise<{ body: unknown }>;
    deleteNamespacedJob(name: string, namespace: string): Promise<unknown>;
  }
  export class CoreV1Api {
    listNamespacedPod(namespace: string, ...args: unknown[]): Promise<{ body: { items: unknown[] } }>;
    readNamespacedPodLog(name: string, namespace: string): Promise<{ body: string }>;
  }
  export class NetworkingV1Api {
    createNamespacedNetworkPolicy(namespace: string, body: unknown): Promise<{ body: unknown }>;
    deleteNamespacedNetworkPolicy(name: string, namespace: string): Promise<unknown>;
  }
  export const V1Job: unknown;
  export const V1JobSpec: unknown;
}

declare module "libpg-query" {
  export function parse(sql: string): { parse_tree: unknown[]; error?: unknown };
  export function parseSync(sql: string): { parse_tree: unknown[]; error?: unknown };
}

declare module "apache-arrow" {
  export class Table {
    constructor(...args: unknown[]);
    numRows: number;
    numCols: number;
    schema: unknown;
    toArray(): unknown[];
    serialize(): Uint8Array;
  }
  export class Schema {
    constructor(fields: unknown[]);
    fields: unknown[];
  }
  export class RecordBatchWriter {
    static writeAll(table: Table): Uint8Array;
  }
  export class RecordBatchReader {
    static from(input: Uint8Array | Buffer): { readAll(): Table[] };
  }
  export function tableFromIPC(buf: Uint8Array | Buffer): Table;
  export function tableToIPC(t: Table, format?: "file" | "stream"): Uint8Array;
}

declare module "parquetjs-lite" {
  export class ParquetSchema {
    constructor(schema: Record<string, unknown>);
  }
  export class ParquetWriter {
    static openFile(schema: ParquetSchema, path: string): Promise<ParquetWriter>;
    appendRow(row: Record<string, unknown>): Promise<void>;
    close(): Promise<void>;
  }
  export class ParquetReader {
    static openFile(path: string): Promise<ParquetReader>;
    getCursor(): { next(): Promise<Record<string, unknown> | null> };
    close(): Promise<void>;
  }
}

declare module "pg-cursor" {
  export default class Cursor {
    constructor(sql: string, params?: unknown[], opts?: { rowMode?: string });
    read(batchSize: number, cb: (err: Error | null, rows: unknown[]) => void): void;
    close(cb?: (err?: Error) => void): void;
  }
}

declare module "pg-logical-replication" {
  export class LogicalReplicationService {
    constructor(opts: Record<string, unknown>);
    on(event: string, listener: (...args: unknown[]) => void): this;
    subscribe(plugin: unknown, slotName: string, options?: Record<string, unknown>): Promise<void>;
    stop(): Promise<void>;
    acknowledge(lsn: string): Promise<void>;
  }
  export class PgoutputPlugin {
    constructor(opts: { protoVersion?: number; publicationNames: string[] });
  }
}

// ---------------------------------------------------------------------------
// @asteasolutions/zod-to-openapi shim. Real package is installed on the
// docs/CI image; this lets the API server compile without the heavy dep.
// ---------------------------------------------------------------------------
declare module "@asteasolutions/zod-to-openapi" {
  import type { ZodTypeAny } from "zod";
  export function extendZodWithOpenApi(z: unknown): void;
  export class OpenAPIRegistry {
    definitions: unknown;
    register(name: string, schema: ZodTypeAny): unknown;
    registerComponent(kind: string, name: string, def: unknown): unknown;
    registerPath(def: unknown): unknown;
  }
  export class OpenApiGeneratorV31 {
    constructor(defs: unknown);
    generateDocument(meta: unknown): Record<string, unknown>;
  }
}

