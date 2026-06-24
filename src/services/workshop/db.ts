// Workshop DB indirection.
//
// All Workshop service code goes through `getWorkshopDb()` instead of
// importing `query` / `withTransaction` directly from `../../db`. The
// default binding is the production pool; integration tests rebind the
// shim to a per-schema test pool via `setWorkshopDb()` and restore it via
// `resetWorkshopDb()` in `afterAll`. This keeps the production surface
// unchanged while making services testable without HTTP fixtures.

import type { PoolClient, QueryResult } from "pg";
import {
  query as defaultQuery,
  withTransaction as defaultWithTransaction,
} from "../../db";

export interface WorkshopDb {
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
  withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
}

let current: WorkshopDb = {
  query: defaultQuery,
  withTransaction: defaultWithTransaction,
};

export function getWorkshopDb(): WorkshopDb {
  return current;
}

export function setWorkshopDb(db: WorkshopDb): void {
  current = db;
}

export function resetWorkshopDb(): void {
  current = {
    query: defaultQuery,
    withTransaction: defaultWithTransaction,
  };
}
