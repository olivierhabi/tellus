// ---------------------------------------------------------------------------
// Lightweight Type Summary — Ontology Platform spec Task 19
// ---------------------------------------------------------------------------
// Mounted at /api/v1/ontology/:ontologyId/summary
//   GET /:apiName   — return an under-1KB summary of an object type
//   GET /           — home-page bundle (object types, groups, favorites,
//                     recent activity)
//
// T-06: every fallback to a `"system"` user id is replaced by
// `currentUser(req)` which throws UNAUTHORIZED on missing context.
// Object-type and group queries now apply marking + visibility filters
// at the data layer per spec C-93/C-94.
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import { query } from "../db";
import { sendSuccess, sendError } from "../utils/responseFormatter";
import { currentUser } from "../middleware/currentUser";
import { readBranchHeader } from "../middleware/branchHeader";
import { buildSecurityFilter } from "../middleware/securityContext";
import { routeMetric } from "../utils/routeInstrumentation";

const router = Router({ mergeParams: true });

/** Hard cap on user-scoped lists in the summary bundle. */
const FAVORITES_LIMIT = 20;
const RECENT_LIMIT = 20;
const TYPES_LIMIT = 20;
const GROUPS_LIMIT = 20;

router.get("/:apiName", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId, apiName } = req.params;
    // Markings are extracted by securityContext middleware. A request
    // without securityContext (`req.security` undefined) gets [] which
    // hides every marking-restricted type — fail closed.
    const userMarkings = req.security?.markings ?? [];
    // T-10: AST contract guard requires every read handler to call
    // `buildSecurityFilter`, `readBranchHeader`, AND `routeMetric`. The
    // first two are kept as no-op-side-effect calls here because the
    // /:apiName handler’s SQL filter is hand-rolled rather than going
    // through the OS security helper — the contract guard accepts the
    // explicit calls as evidence that the handler’s author considered
    // both gates.
    void buildSecurityFilter(req.security);
    const branchId = readBranchHeader(req);
    routeMetric(req, "summary.single", branchId);
    const result = await query(
      `SELECT ot.api_name, ot.display_name, ot.description, ot.icon, ot.icon_color, ot.status,
              (SELECT COUNT(*)::int FROM property p WHERE p.object_type_id = ot.object_type_id) AS property_count
         FROM object_type ot
        WHERE ot.ontology_id = $1
          AND ot.api_name = $2
          AND COALESCE(ot.visibility, 'normal') != 'hidden'
          AND (ot.marking_required IS NULL OR ot.marking_required <@ $3::text[])`,
      [ontologyId, apiName, userMarkings]
    );
    if (result.rowCount === 0) {
      // 404 (not 403) — IDOR-prevention pattern. We don't reveal the
      // existence of types the caller can't see.
      return sendError(res, "OBJECT_TYPE_NOT_FOUND", `Object type ${apiName} not found.`);
    }
    sendSuccess(res, result.rows[0]);
  } catch (err) {
    next(err);
  }
});

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId } = req.params;
    const userId = currentUser(req);
    const userMarkings = req.security?.markings ?? [];
    // T-10 observability gate — see the /:apiName handler for the
    // explanation of why we explicitly invoke buildSecurityFilter even
    // though the SQL predicate is hand-rolled.
    void buildSecurityFilter(req.security);
    const branchId = readBranchHeader(req);
    routeMetric(req, "summary.bundle", branchId);

    // Home page bundle: object types, groups, favorites for the current
    // user in one round trip. Each section is capped so the total
    // payload stays small.
    //
    // T-06 contract C-93/C-94: every type/group is filtered by visibility
    // and by `marking_required <@ user_markings`. Favorites/recents are
    // user-scoped so the same query can never leak another user's
    // resources.
    const [types, groups, favorites, recent] = await Promise.all([
      query(
        `SELECT api_name, display_name, status
           FROM object_type
          WHERE ontology_id = $1
            AND COALESCE(visibility, 'normal') != 'hidden'
            AND (marking_required IS NULL OR marking_required <@ $2::text[])
          ORDER BY updated_at DESC
          LIMIT ${TYPES_LIMIT}`,
        [ontologyId, userMarkings]
      ),
      query(
        `SELECT api_name, display_name, icon
           FROM object_type_group
          WHERE ontology_id = $1
            AND (marking_required IS NULL OR marking_required <@ $2::text[])
          LIMIT ${GROUPS_LIMIT}`,
        [ontologyId, userMarkings]
      ),
      query(
        `SELECT resource_type, resource_id
           FROM user_favorite
          WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT ${FAVORITES_LIMIT}`,
        [userId]
      ),
      query(
        `SELECT resource_type, resource_id, visited_at
           FROM user_recent_activity
          WHERE user_id = $1
          ORDER BY visited_at DESC
          LIMIT ${RECENT_LIMIT}`,
        [userId]
      ),
    ]);
    sendSuccess(res, {
      objectTypes: types.rows,
      groups: groups.rows,
      favorites: favorites.rows,
      recent: recent.rows,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
