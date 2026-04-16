// ---------------------------------------------------------------------------
// resolveOntologyAlias.ts — map `default` / `main` to a real ontology UUID
// ---------------------------------------------------------------------------
// The Ontology Platform spec cypress specs all hit `.../ontologies/default/…`
// rather than a UUID. Production Palantir does the same thing: a symbolic
// ontology name is resolved at the edge. This middleware intercepts the
// `ontologyId` path parameter and substitutes the real UUID if it matches
// a known alias. Cached for 60s so every request doesn't hit Postgres.
// ---------------------------------------------------------------------------

import { Request, Response, NextFunction } from "express";
import { query } from "../db";

const ALIASES = new Set(["default", "main", "primary"]);

let cachedId: { value: string; expires: number } | null = null;

async function resolveDefault(): Promise<string | null> {
  if (cachedId && cachedId.expires > Date.now()) {
    return cachedId.value;
  }
  try {
    const result = await query(
      "SELECT ontology_id FROM ontology ORDER BY created_at ASC LIMIT 1"
    );
    if (result.rowCount === 0) return null;
    const id = result.rows[0].ontology_id as string;
    cachedId = { value: id, expires: Date.now() + 60_000 };
    return id;
  } catch {
    return null;
  }
}

/**
 * Middleware factory. Given a route param name, check whether its value is
 * a known symbolic alias and swap it for the real UUID.
 */
export function resolveOntologyAlias(paramName: string = "ontologyId") {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const val = req.params[paramName];
    if (val && ALIASES.has(val)) {
      const real = await resolveDefault();
      if (real) {
        req.params[paramName] = real;
      }
    }
    next();
  };
}
