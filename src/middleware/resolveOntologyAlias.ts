// ---------------------------------------------------------------------------
// resolveOntologyAlias.ts — map `default` / `main` to a real ontology UUID
// ---------------------------------------------------------------------------
// The Ontology Platform spec cypress specs all hit `.../ontology/default/…`
// rather than a UUID. Production Palantir does the same thing: a symbolic
// ontology name is resolved at the edge. This middleware intercepts the
// `ontologyId` path parameter and substitutes the real UUID if it matches
// a known alias. Cached for 60s so every request doesn't hit Postgres.
// ---------------------------------------------------------------------------

import { Request, Response, NextFunction } from "express";
import { getOntologyId } from "../services/ontology/canonicalOntology";

const ALIASES = new Set(["default", "main", "primary"]);

// "One Enterprise, One Ontology": every alias resolves through the single
// canonical resolver. This used to run its own `ORDER BY created_at ASC` query,
// which disagreed with the other two "default ontology" code paths — now there
// is exactly one answer.
async function resolveDefault(): Promise<string | null> {
  return getOntologyId();
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
