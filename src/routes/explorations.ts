// ---------------------------------------------------------------------------
// Saved Explorations — Ontology Platform spec Task 27
// ---------------------------------------------------------------------------
// CRUD endpoints for saved explorations:
//   POST   /        — create
//   GET    /        — list (scoped by owner + visibility + markings)
//   GET    /:id     — get one (visibility + markings + 404 IDOR-shape)
//   PUT    /:id     — update (re-resolves required_markings on config change)
//   DELETE /:id     — delete
//
// T-06 closed the `|| "system"` auth fallback (currentUser → UNAUTHORIZED).
// T-08 closes H-11: the saved `config:jsonb` may reference SECRET-marked
// properties; the read paths now filter on `required_markings <@ user_markings`
// and the single-GET returns 404 (with parameters.kind = "saved_exploration")
// rather than disclosing the existence of an out-of-marking exploration.
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import { query } from "../db";
import {
  sendSuccess,
  sendCreated,
  sendError,
  sendNoContent,
} from "../utils/responseFormatter";
import { currentUser } from "../middleware/currentUser";
import { resolveRequiredMarkings } from "../services/explorations/configMarkingResolver";
import { incCounter } from "../services/funnel/metrics";
import { routeMetric } from "../utils/routeInstrumentation";

const router = Router({ mergeParams: true });

/**
 * Return the markings the caller holds. Empty array for unauthenticated
 * principals (currentUser already throws UNAUTHORIZED upstream of this),
 * empty array for users with no markings (the "dave" archetype) — both
 * paths fail-closed against any exploration whose `required_markings`
 * is non-empty.
 */
function callerMarkings(req: Request): string[] {
  return req.security?.markings ?? [];
}

router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    routeMetric(req, "explorations.create", null);
    const { ontologyId } = req.params;
    const { title, description, config, visibility } = req.body || {};
    if (!title) {
      return sendError(res, "VALIDATION_ERROR", "title is required.");
    }
    // Resolve marking requirement at write time so the read path is a
    // single-row marking-set lookup (no JSON walking on the hot path).
    const requiredMarkings = await resolveRequiredMarkings(config || {});
    // The author MUST themselves hold every marking the config requires —
    // otherwise the exploration would be invisible to its own creator,
    // which is both confusing and a sign of an intentional or accidental
    // privilege escalation attempt.
    const userMarks = new Set(callerMarkings(req));
    const missing = requiredMarkings.filter((m) => !userMarks.has(m));
    if (missing.length > 0 && !req.security?.systemPrincipal) {
      return sendError(
        res,
        "FORBIDDEN",
        "Cannot save an exploration referencing markings the caller does not hold.",
        { missingMarkings: missing },
      );
    }
    const result = await query(
      `INSERT INTO saved_exploration
         (ontology_id, owner_id, title, description, config, visibility, required_markings)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::text[])
       RETURNING *`,
      [
        ontologyId,
        currentUser(req),
        title,
        description || null,
        JSON.stringify(config || {}),
        visibility || "private",
        requiredMarkings,
      ]
    );
    sendCreated(res, result.rows[0]);
  } catch (err) {
    next(err);
  }
});

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    routeMetric(req, "explorations.list", null);
    const { ontologyId } = req.params;
    const userMarks = callerMarkings(req);
    // T-08 — extend the visibility filter with `required_markings <@ user_markings`.
    // Containment semantics: the exploration is visible only when EVERY
    // required marking is in the user's set. The DEFAULT '{}' from
    // migration 045 means "no markings required" — visible to all.
    // Pre-marking rows backfill to '{}' as a worst-case visibility match
    // until the one-time backfill recomputes accurate values.
    //
    // Pagination: we fetch LIMIT+1 to detect if more results exist; the
    // extra row (if present) is discarded from the response but signals
    // hasMore=true. This avoids an expensive COUNT(*) while still giving
    // callers truncation visibility.
    const limit = 100;
    const result = await query(
      `SELECT * FROM saved_exploration
        WHERE ontology_id = $1
          AND (visibility IN ('shared','public') OR owner_id = $2)
          AND required_markings <@ $3::text[]
        ORDER BY updated_at DESC
        LIMIT $4`,
      [ontologyId, currentUser(req), userMarks, limit + 1]
    );
    const rows = result.rows;
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    sendSuccess(res, {
      data,
      totalCount: data.length,
      hasMore,
      // Include a cursor for the next page (the last item's updated_at).
      // Callers can pass this as `?cursor=<value>` to page past the cap.
      nextCursor: hasMore && data.length > 0
        ? data[data.length - 1].updated_at
        : null,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    routeMetric(req, "explorations.get", null);
    const { ontologyId } = req.params;
    const userMarks = callerMarkings(req);
    const result = await query(
      `SELECT * FROM saved_exploration
        WHERE exploration_id = $1
          AND ontology_id = $2
          AND (visibility IN ('shared','public') OR owner_id = $3)
          AND required_markings <@ $4::text[]`,
      [req.params.id, ontologyId, currentUser(req), userMarks]
    );
    if (result.rowCount === 0) {
      // T-08 — IDOR-prevention: do NOT distinguish between "exploration
      // does not exist", "owned by another user", and "user lacks
      // markings". All three return the same OBJECT_NOT_FOUND so an
      // attacker cannot enumerate exploration IDs via 403/404 timing.
      // We do, however, increment a marking-miss counter when the row
      // exists but is filtered solely by markings, for SOC dashboards.
      const sniff = await query(
        `SELECT 1 FROM saved_exploration
          WHERE exploration_id = $1
            AND ontology_id = $2
            AND (visibility IN ('shared','public') OR owner_id = $3)
            AND NOT (required_markings <@ $4::text[])`,
        [req.params.id, ontologyId, currentUser(req), userMarks]
      );
      if ((sniff.rowCount ?? 0) > 0) {
        incCounter("tellus_saved_exploration_marking_misses_total");
      }
      return sendError(
        res,
        "OBJECT_NOT_FOUND",
        "Exploration not found.",
        { kind: "saved_exploration" },
      );
    }
    sendSuccess(res, result.rows[0]);
  } catch (err) {
    next(err);
  }
});

router.put("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    routeMetric(req, "explorations.update", null);
    const { title, description, config, visibility } = req.body || {};
    // Re-resolve markings only when `config` is being touched. A pure
    // metadata edit (title/description/visibility) does not need to
    // re-walk the config tree — but if the caller sends `config: null`
    // or omits it, we leave the existing column value alone via COALESCE.
    let nextRequiredMarkings: string[] | null = null;
    if (config !== undefined && config !== null) {
      nextRequiredMarkings = await resolveRequiredMarkings(config);
      const userMarks = new Set(callerMarkings(req));
      const missing = nextRequiredMarkings.filter((m) => !userMarks.has(m));
      if (missing.length > 0 && !req.security?.systemPrincipal) {
        return sendError(
          res,
          "FORBIDDEN",
          "Cannot edit an exploration to reference markings the caller does not hold.",
          { missingMarkings: missing },
        );
      }
    }
    const { ontologyId } = req.params;
    const result = await query(
      `UPDATE saved_exploration
          SET title = COALESCE($2, title),
              description = COALESCE($3, description),
              config = COALESCE($4::jsonb, config),
              visibility = COALESCE($5, visibility),
              required_markings = COALESCE($7::text[], required_markings),
              updated_at = now()
        WHERE exploration_id = $1 AND owner_id = $6 AND ontology_id = $8
        RETURNING *`,
      [
        req.params.id,
        title,
        description,
        config ? JSON.stringify(config) : null,
        visibility,
        currentUser(req),
        nextRequiredMarkings,
        ontologyId,
      ]
    );
    if (result.rowCount === 0) {
      return sendError(
        res,
        "OBJECT_NOT_FOUND",
        "Exploration not found.",
        { kind: "saved_exploration" },
      );
    }
    sendSuccess(res, result.rows[0]);
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await query(
      "DELETE FROM saved_exploration WHERE exploration_id = $1 AND owner_id = $2",
      [req.params.id, currentUser(req)]
    );
    sendNoContent(res);
  } catch (err) {
    next(err);
  }
});

export default router;
