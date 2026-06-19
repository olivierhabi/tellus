// ---------------------------------------------------------------------------
// B3 — Schema discovery HTTP handlers (spec §B3 line 142).
//
// Routes (mounted by createConnectivityRouter):
//   GET /connections/:rid/discovery/catalog
//   GET /connections/:rid/discovery/schemas
//   GET /connections/:rid/discovery/tables?schema=&cursor=&limit=
//   GET /connections/:rid/discovery/columns?schema=&table=
//   GET /connections/:rid/discovery/primary-keys?schema=&table=
//   GET /connections/:rid/discovery/imported-keys?schema=&table=
//
// Auth: scope `connectivity:read`. Errors normalized to TellusError envelope.
// ---------------------------------------------------------------------------

import type { Request, Response, NextFunction } from "express";
import * as discovery from "../connectors/postgresql/discovery";
import { TellusError } from "../../../lib/errors/envelope";
import {
  DiscoveryArgumentMissing,
  DiscoveryCursorInvalid,
} from "../../../lib/errors/connectivity.errors";

export async function getCatalog(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const out = await discovery.discoverCatalog(req.params.rid);
    res.json(out);
  } catch (err) {
    if (err instanceof TellusError) {
      err.send(res);
      return;
    }
    next(err);
  }
}

export async function getSchemas(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const out = await discovery.discoverSchemas(req.params.rid);
    res.json({ schemas: out });
  } catch (err) {
    if (err instanceof TellusError) {
      err.send(res);
      return;
    }
    next(err);
  }
}

export async function getTables(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const cursor = parseCursor(req.query.cursor);
    const limit = req.query.limit
      ? Math.max(1, Math.min(1000, Number(req.query.limit)))
      : undefined;
    const out = await discovery.discoverTables(req.params.rid, {
      schemaName:
        typeof req.query.schema === "string" ? req.query.schema : undefined,
      cursor,
      pageSize: limit,
    });
    res.json({
      tables: out.rows,
      nextCursor: out.nextCursor
        ? encodeCursor(out.nextCursor.schema, out.nextCursor.table)
        : null,
    });
  } catch (err) {
    if (err instanceof TellusError) {
      err.send(res);
      return;
    }
    next(err);
  }
}

export async function getColumns(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { schema, table } = requireSchemaTable(req);
    const out = await discovery.discoverColumns(req.params.rid, schema, table);
    res.json({ columns: out });
  } catch (err) {
    if (err instanceof TellusError) {
      err.send(res);
      return;
    }
    next(err);
  }
}

export async function getPrimaryKeys(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { schema, table } = requireSchemaTable(req);
    const out = await discovery.discoverPrimaryKeys(
      req.params.rid,
      schema,
      table,
    );
    res.json({ primaryKey: out });
  } catch (err) {
    if (err instanceof TellusError) {
      err.send(res);
      return;
    }
    next(err);
  }
}

export async function getImportedKeys(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { schema, table } = requireSchemaTable(req);
    const out = await discovery.discoverImportedKeys(
      req.params.rid,
      schema,
      table,
    );
    res.json({ importedKeys: out });
  } catch (err) {
    if (err instanceof TellusError) {
      err.send(res);
      return;
    }
    next(err);
  }
}

export async function getPreview(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { schema, table } = requireSchemaTable(req);
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const out = await discovery.discoverPreviewRows(
      req.params.rid,
      schema,
      table,
      limit,
    );
    res.json(out);
  } catch (err) {
    if (err instanceof TellusError) {
      err.send(res);
      return;
    }
    next(err);
  }
}

function requireSchemaTable(req: Request): { schema: string; table: string } {
  const schema =
    typeof req.query.schema === "string" ? req.query.schema : undefined;
  const table =
    typeof req.query.table === "string" ? req.query.table : undefined;
  if (!schema || !table) {
    throw new TellusError(DiscoveryArgumentMissing, {
      missing: [schema ? null : "schema", table ? null : "table"].filter(
        Boolean,
      ),
    });
  }
  return { schema, table };
}

function parseCursor(
  raw: unknown,
): { schema: string; table: string } | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const obj = JSON.parse(decoded);
    if (typeof obj.schema === "string" && typeof obj.table === "string") {
      return { schema: obj.schema, table: obj.table };
    }
  } catch {
    /* fallthrough */
  }
  throw new TellusError(DiscoveryCursorInvalid, {});
}

function encodeCursor(schema: string, table: string): string {
  return Buffer.from(JSON.stringify({ schema, table }), "utf8").toString(
    "base64url",
  );
}
