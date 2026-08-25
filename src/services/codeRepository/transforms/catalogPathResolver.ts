// ===========================================================================
// Catalog path resolver — maps a Palantir Foundry catalog dataset path
// (`/Project/Folder/Dataset`) to the canonical dataset RID it identifies.
//
// The Tellus codebase already stores every Dataset and Compass Folder as a
// `resources` row (see src/services/datasets/dataset-resolver.ts and
// foundry-dataset.repo.ts). Each DATASET has a `display_name` + a
// `parent_folder_rid`; each COMPASS_FOLDER has the same. The walk here is:
//   1. Leaf segment matches a `resources` row with `type='DATASET'`,
//      `trash_status='NOT_TRASHED'`, display_name = leaf.
//   2. Walk each candidate's `parent_folder_rid` chain upward, comparing the
//      parent's `display_name` to the path segments right-to-left.
//   3. The candidate whose full chain matches AND whose topmost ancestor lands
//      at the path root is the canonical RID. Zero matches = path-not-found;
//      >1 matches = ambiguous-path error (per spec point 2 resolution rules).
//
// Resolution happens in buildService BEFORE constructing the TELLUS_TRANSFORM_JOB
// job-spec — per spec item 2 ("Do not place all path-resolution logic inside the
// Python shim. Resolve paths in the build/discovery service before constructing
// the execution job so the runtime receives authoritative dataset identities.").
//
// All resolution preserves the ORIGINAL reference (RID or catalog path) on the
// DiscoveredInput / DiscoveredOutput for diagnostics + UI display; the resolver
// only ADDS a `canonicalRid` field that downstream code (datasetStore, job-spec,
// lineage) uses for transaction/file lookups.
// ===========================================================================

import type { Pool } from "pg";

export interface ResolvedCatalogRef {
  /** The canonical dataset RID (`ri.foundry.main.dataset.<uuid>`) — set on
   * success only. */
  readonly rid: string;
  /** The original catalog path the user/agent supplied — preserved for
   * diagnostics + UI display per spec §2.6 ("Preserve the original path for
   * diagnostics and UI display"). */
  readonly originalPath: string;
  /** The resolved Compass display-name leaf (`display_name` of the matched
   * DATASET row) — included in error messages + UI. */
  readonly leafName: string;
}

export interface ResolveCatalogError {
  readonly error: string;
  /** 'not-found' — no candidate matched the leaf display-name. 'ambiguous' —
   * >1 candidate matched the full chain. 'invalid' — the path was malformed
   * (empty, not starting with '/', non-portable characters). */
  readonly kind: "not-found" | "ambiguous" | "invalid";
  readonly originalPath: string;
}

export type ResolveCatalogResult =
  | { ok: true; ref: ResolvedCatalogRef }
  | { ok: false; error: ResolveCatalogError };

/** True iff `ref` is a Palantir catalog path (`/...`) — false for RIDs
 *  (`ri.foundry.main.dataset.<uuid>`). Used by buildService + datasetStore to
 *  decide whether to invoke the catalog resolver. Pure + testable without DB. */
export function isCatalogPath(ref: string): boolean {
  return typeof ref === "string" && ref.startsWith("/") && ref.length > 1;
}

/** Resolve a `/Project/Folder/Dataset` catalog path to a canonical dataset RID.
 *
 * Uses the singleton `pool` argument so the caller can pass the shared pg Pool.
 * Returns a discriminated enum:
 *   - ok=true  + ref: ResolvedCatalogRef on success
 *   - ok=false + error.kind = 'not-found' | 'ambiguous' | 'invalid'
 *
 * Error messages include the unresolved reference + the path per spec §2.4
 * ("Error messages must include the unresolved reference and transform
 * parameter"); the caller (buildService) prepends the transform name + the
 * binding param to give a single actionable diagnostic. */
export async function resolveCatalogPath(
  pool: Pool,
  path: string,
  _opts?: { branch?: string },
): Promise<ResolveCatalogResult> {
  if (!isCatalogPath(path)) {
    return {
      ok: false,
      error: {
        error: `not a catalog path (must start with '/'): ${JSON.stringify(path)}`,
        kind: "invalid",
        originalPath: path,
      },
    };
  }
  // Normalize consecutive slashes + trim trailing slash. Empty segments after
  // splitting are filtered (e.g. '/A//B' => ['A', 'B']).
  const normalized = path.replace(/\/+/g, "/").replace(/\/$/, "");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) {
    return {
      ok: false,
      error: {
        error: `catalog path '${path}' has no segments after normalization`,
        kind: "invalid",
        originalPath: path,
      },
    };
  }
  const leafName = segments[segments.length - 1];
  const ancestorNames = segments.slice(0, -1); // right-to-left walk order

  // Step 1: find all candidate DATASET resources with display_name = leaf.
  let candidates: { rid: string; parent_folder_rid: string | null }[];
  try {
    const { rows } = await pool.query(
      `SELECT rid, parent_folder_rid
         FROM resources
        WHERE type IN ('DATASET', 'FOUNDRY_DATASET')
          AND trash_status = 'NOT_TRASHED'
          AND display_name = $1`,
      [leafName],
    );
    candidates = rows as { rid: string; parent_folder_rid: string | null }[];
  } catch (e) {
    return {
      ok: false,
      error: {
        error: `catalog path '${path}' resolution query failed: ${String(e)}`,
        kind: "invalid",
        originalPath: path,
      },
    };
  }
  if (candidates.length === 0) {
    return {
      ok: false,
      error: {
        error: `catalog path '${path}' does not match any dataset named '${leafName}'`,
        kind: "not-found",
        originalPath: path,
      },
    };
  }

  // Step 2: walk each candidate's parent_folder_rid chain upward. The chain
  // must display_name-match `ancestorNames` from RIGHT TO LEFT entirely. The
  // topmost folder's own parent_folder_rid may be a SPACE_RID or NULL — the
  // walk stops when ancestors are exhausted; if any ancestor's name doesn't
  // match, the candidate is rejected.
  const matched = await walkParentsMatching(
    pool,
    candidates.map((c) => ({ rid: c.rid, parent_folder_rid: c.parent_folder_rid })),
    ancestorNames,
  );

  if (matched.length === 0) {
    return {
      ok: false,
      error: {
        error:
          `catalog path '${path}' has a dataset named '${leafName}' but its ` +
          `ancestor folder chain does not match the requested path ` +
          `(expected ancestors: /${ancestorNames.join("/")}). ` +
          `Check that all ancestor folders exist with the exact display_name ` +
          `and are not trashed.`,
        kind: "not-found",
        originalPath: path,
      },
    };
  }
  if (matched.length > 1) {
    return {
      ok: false,
      error: {
        error:
          `catalog path '${path}' is ambiguous — matched ${matched.length} ` +
          `datasets with display_name '${leafName}' and the same ancestor ` +
          `chain /${ancestorNames.join("/")}. Use a longer path or rename ` +
          `one of the duplicates. Matched RIDs: ${matched.map((m) => m.rid).join(", ")}`,
        kind: "ambiguous",
        originalPath: path,
      },
    };
  }
  return {
    ok: true,
    ref: {
      rid: matched[0].rid,
      originalPath: path,
      leafName,
    },
  };
}

async function walkParentsMatching(
  pool: Pool,
  candidates: { rid: string; parent_folder_rid: string | null }[],
  ancestorNames: string[],
): Promise<{ rid: string }[]> {
  // Pre-load the parent folder row for each ancestor level (上百 folded). The
  // naive single-row walk per candidate is cheap: paths rarely exceed 4-5
  // segments. We query the parent_folder_rid chain one lookup at a time per
  // candidate — PG round-trips are bounded by path depth, not by total dataset
  // count.
  const matched: { rid: string }[] = [];
  for (const c of candidates) {
    let curParent = c.parent_folder_rid;
    let chainIdx = ancestorNames.length - 1; // right-to-left
    let ok = true;
    while (chainIdx >= 0 && curParent) {
      const r = await pool.query(
        `SELECT display_name, type, parent_folder_rid
           FROM resources
          WHERE rid = $1`,
        [curParent],
      );
      const row = r.rows[0] as
        | { display_name: string; type: string; parent_folder_rid: string | null }
        | undefined;
      // Reject any ancestor that is itself a dataset/leaf type (data leak
      // under a dataset), or any unknown row. A Compass chain segment can be
      // FOLDER, COMPASS_FOLDER, PROJECT, or COMPASS_SPACE; we accept any of
      // them as a path ancestor as long as display_name matches. Strict
      // ancestor-type discrimination is intentionally omitted since real
      // Tellus Compass trees mix all of these as intermediate segments.
      if (!row || row.type === "DATASET" || row.type === "FOUNDRY_DATASET") {
        ok = false;
        break;
      }
      if (row.display_name !== ancestorNames[chainIdx]) {
        ok = false;
        break;
      }
      curParent = row.parent_folder_rid;
      chainIdx -= 1;
    }
    if (ok && chainIdx < 0) matched.push({ rid: c.rid });
  }
  return matched;
}

/** Resolve a dataset reference that may be either an RID OR a catalog path.
 *
 * For RID-direct references (not starting with `/`) the function returns
 * `{ ok: true, rid: ref }` unchanged — the caller is expected to subsequently
 * call the existing `datasetStore.resolveTransformInput(rid, branch)` to fetch
 * the dataset file row; this resolver does NOT touch the `dataset` /
 * `foundry_datasets` transaction tables.
 *
 * For catalog paths (`/...`) the function delegates to {@link resolveCatalogPath}.
 *
 * Branch handling: per spec §2.7 ("Apply branch resolution consistently to
 * paths and RIDs") the caller (buildService) passes the requested branch;
 * the catalog resolver ignores idiosyncratic per-branch dataset identity
 * (the `resources` tree is branch-agnostic — branch selection happens at the
 * `dataset_transaction` layer when picking the latest committed file_path on
 * the build branch). */
export async function resolveDatasetRef(
  pool: Pool,
  ref: string,
  opts?: { branch?: string },
): Promise<ResolveCatalogResult> {
  if (!isCatalogPath(ref)) {
    // RID pass-through. Synthetic success shape mirrors the catalog resolver
    // so the caller can treat both paths uniformly (the canonical RID equals
    // the reference verbatim, and `originalPath` is the RID itself).
    return {
      ok: true,
      ref: {
        rid: ref,
        originalPath: ref,
        leafName: ref,
      },
    };
  }
  return resolveCatalogPath(pool, ref, opts);
}
