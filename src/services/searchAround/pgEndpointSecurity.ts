// ---------------------------------------------------------------------------
// Stage-4 — PostgreSQL-backed endpoint authorization (temporary rollback
// guard leading up to the OBJECT-side serving documents coming fully
// online). This is the SAME ruleset as
// `searchAroundService.defaultEndpointSecurityLookup`, made reusable so
// BOTH `countLinks` and any future serving interface calls honor the same
// fail-closed posture.
//
// CONTRACT:
//   * A PK without a row in object_instances is DENIED (never visible).
//   * A marking-not-granted PK is DENIED (markings are conjunctive).
//   * If the backend LOOKes:false or throws, the ENTIRE candidate set
//     is withheld (0 authorized); the caller must not invent a partial
//     interpretation of the error into "some trusted rows remained".
// ---------------------------------------------------------------------------

import { query } from "../../db";
import { userSees } from "./markingFilter";
import { incCounter } from "../funnel/metrics";

export interface EndpointAuthOutcome {
  authorizedCount: number;
  deniedCount: number;
  error: boolean;
}

export async function authorizeEndpointPks(
  objectTypeApiName: string,
  pks: string[],
  userMarkings: ReadonlySet<string>,
): Promise<EndpointAuthOutcome> {
  if (pks.length === 0) {
    return { authorizedCount: 0, deniedCount: 0, error: false };
  }
  const markingsByPk = new Map<string, string[]>();
  let error = false;
  try {
    const res = await query(
      `SELECT primary_key, markings
         FROM object_instances
        WHERE object_type_api_name = $1
          AND primary_key = ANY($2::text[])`,
      [objectTypeApiName, pks],
    );
    for (const row of res.rows as Array<{ primary_key: string; markings: string[] | null }>) {
      markingsByPk.set(row.primary_key, row.markings ?? []);
    }
  } catch (err) {
    console.warn(
      `[endpoint-security] authorization lookup failed (withholding results): ${(err as Error).message}`,
    );
    error = true;
  }
  if (error) {
    incCounter("indexed_security_backend_failure_total", {
      object_type: objectTypeApiName,
    });
    return { authorizedCount: 0, deniedCount: pks.length, error: true };
  }
  const authorized = pks.filter((pk) => {
    const markings = markingsByPk.get(pk);
    return markings != null && userSees(markings, userMarkings);
  });
  const denied = pks.length - authorized.length;
  if (denied > 0) {
    incCounter("traversal_authorization_denied_total", {
      object_type: objectTypeApiName,
    }, denied);
  }
  return { authorizedCount: authorized.length, deniedCount: denied, error: false };
}
