// ---------------------------------------------------------------------------
// Functions router — extracted from admin/routes.ts.
//
//   GET /:rid/functions  — B2-C-13: published + working-tree + draft-overlay
//   read aggregator for the IDE's function browser.
//
// Mounted by codeRepositoryRouter() in ../routes.ts in the original
// registration order.
// ---------------------------------------------------------------------------

import { Router, type Request, type Response, type NextFunction } from "express";
import { codeReposError } from "../../errors";
import { isRid } from "../../../codeRepos/contracts/rid";
import { parseFunctionPath } from "../../../functions/discovery";
import { inferFunctionObjectType } from "../../functionObjectType";
import { listDrafts } from "../../drafts/draftStore";
import {
  compareSemverLoose,
  derivePrincipalSubUuid,
  deriveSignatureFromSource,
  isUuidV4,
  sendError,
  toWireSignature,
  type ListingSignature,
} from "../routeHelpers";
import type { CodeRepositoryRouteContext } from "../routeContext";

export function createFunctionsRouter(ctx: CodeRepositoryRouteContext): Router {
  const router = Router();

  // GET /:rid/functions  — B2-C-13 (user-facing read aggregator over B8)
  //
  // Returns the set of published functions for a repository on a given branch,
  // derived from the highest-semver AVAILABLE row per (repo, branch). The
  // manifest convention is { exports: string[] } (B8 publish payload).
  //
  // The IDE's FunctionBrowser calls this endpoint to populate the Published
  // tab. Published versions are produced by POST /:rid/tags (Tag & Release).
  // -------------------------------------------------------------------------
  router.get("/:rid/functions", ctx.auth, async (req, res, next) => {
    try {
      const { rid } = req.params;
      if (!isRid(rid)) {
        sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { repositoryRid: rid }));
        return;
      }

      const repo = await ctx.pool.query(
        `SELECT default_branch, state FROM code_repository WHERE rid = $1 LIMIT 1`,
        [rid],
      );
      if (repo.rowCount === 0) {
        sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { repositoryRid: rid }));
        return;
      }
      if (repo.rows[0].state === "ARCHIVED") {
        sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { repositoryRid: rid }));
        return;
      }

      const requestedBranch = typeof req.query.branch === "string" ? req.query.branch : null;
      const branch = requestedBranch ?? repo.rows[0].default_branch ?? "main";

      // Function rows returned to the client are the union of two sources:
      //   1. Published versions from `function_version` (post-CI-publish).
      //   2. Working-tree source files at `<root>/src/functions/<apiName>.{ts,py}`
      //      discovered via Stemma. The basename is the apiName per the
      //      template convention (one function per file, default export).
      // Published wins when both exist for the same apiName — the user
      // cares about the deployed artifact's metadata once it's available.
      type MergedFunctionRow = {
        apiName: string;
        versionRid: string | null;
        /** Stable registry RID for deep-links (function_registry_function). */
        functionRid: string | null;
        semver: string | null;
        branch: string;
        isPreview: boolean;
        runtime: string;
        commitSha: string | null;
        publishedAt: string | null;
        source: "published" | "working_tree";
        path: string | null;
        /** Path under `src/functions/` WITH extension (e.g. "orders/calc.ts")
         *  — drives the FE's subdirectory grouping (Foundry parity). */
        relativePath: string | null;
        /** True when the row exists ONLY as an uncommitted draft. */
        draftOnly: boolean;
        /** True when a committed file has an open (uncommitted) draft edit. */
        hasDraft: boolean;
        /** Object-type apiName the function binds to (from `@ontology/sdk`
         *  import / `ObjectSet<X>`), or null for a pure utility. The FE
         *  overlays the ontology display name + icon + colour. */
        objectTypeName: string | null;
        objectTypeIcon: string | null;
        /** Function input signature (null = not derivable) — drives the
         *  Functions tester's signature-driven Form tab. */
        signature: ListingSignature | null;
      };
      const byApiName = new Map<string, MergedFunctionRow>();

      // ---- Published versions (B8) ------------------------------------
      // The function_version table may not exist on test schemas that didn't
      // load migration 055_b8_functions_registry.sql. Probe first; treat
      // table-absent as "no published functions yet" rather than 500.
      const tablePresence = await ctx.pool.query<{ exists: boolean }>(
        `SELECT to_regclass('function_version') IS NOT NULL AS exists`,
      );
      if (tablePresence.rows[0]?.exists) {
        // For each apiName exported by any AVAILABLE version on this branch,
        // pick the highest-semver row. The aggregation is single-pass; the
        // semver comparator is the one B8 uses to keep ordering consistent.
        const rowsRes = await ctx.pool.query<{
          rid: string;
          branch: string;
          semver: string;
          is_preview: boolean;
          runtime: string;
          commit_sha: string;
          // NB: the app configures node-postgres to return TIMESTAMPTZ (OID
          // 1184) as a raw ISO string, not a JS Date (src/db.ts). So this is
          // a string at runtime — never call Date methods on it directly.
          published_at: string | Date;
          manifest_json: { exports?: unknown; signatures?: unknown; objectTypes?: unknown };
        }>(
          `SELECT rid, branch, semver, is_preview, runtime, commit_sha, published_at, manifest_json
             FROM function_version
            WHERE repository_rid = $1 AND branch = $2 AND state = 'AVAILABLE'`,
          [rid, branch],
        );

        for (const r of rowsRes.rows) {
          const exportsRaw = r.manifest_json?.exports;
          if (!Array.isArray(exportsRaw)) continue;
          // Ontology bindings stamped at publish time (functionsPublish
          // worker, manifest.objectTypes). Historical manifests predate the
          // field — their rows fall back to live-tree inference below.
          const manifestObjectTypes =
            r.manifest_json && typeof (r.manifest_json as { objectTypes?: unknown }).objectTypes === "object"
              ? ((r.manifest_json as { objectTypes: Record<string, unknown> }).objectTypes)
              : null;
          for (const name of exportsRaw) {
            if (typeof name !== "string" || name.length === 0) continue;
            const prev = byApiName.get(name);
            if (prev === undefined || compareSemverLoose(r.semver, prev.semver ?? "") > 0) {
              const stamped = manifestObjectTypes?.[name];
              byApiName.set(name, {
                apiName: name,
                versionRid: r.rid,
                functionRid: null, // resolved per-export below (registry deep-link)
                semver: r.semver,
                branch: r.branch,
                isPreview: r.is_preview,
                runtime: r.runtime,
                commitSha: r.commit_sha,
                // Robust to both string (production: db.ts type parser) and Date.
                publishedAt:
                  r.published_at instanceof Date
                    ? r.published_at.toISOString()
                    : new Date(r.published_at).toISOString(),
                source: "published",
                path: null,
                relativePath: null,
                draftOnly: false,
                hasDraft: false,
                // Publish-time binding from manifest.objectTypes when present;
                // historical manifests fall back to live-tree inference below.
                objectTypeName: typeof stamped === "string" ? stamped : null,
                objectTypeIcon: null,
                // Publish-time canonical signature (manifest.signatures) —
                // historical manifests predating the field fall back to the
                // live-tree derivation stamped below.
                signature: toWireSignature(
                  (r.manifest_json?.signatures as Record<string, unknown> | undefined)?.[name] ?? null,
                ),
              });
            }
          }
        }
      }

      // ---- Working-tree discovery (Stemma tree walk) ------------------
      // Convention (src/services/templates/manifest.ts:51 + :349):
      //   - typescript-functions: `<root>/src/functions/<apiName>.ts`
      //   - python-functions:     `<root>/src/functions/<apiName>.py`
      // One function per file, basename = identity, `export default`.
      // We walk at depth 5 to cover scaffold-nested layouts; if the branch
      // doesn't exist or the tree walk fails (transient), we silently fall
      // back to the published-only list — never 500 on discovery failure.
      // Working-tree entries are tracked SEPARATELY from published ones (not
      // merged into byApiName). A function that is both published AND present
      // in the working tree must surface under BOTH sources, because the
      // Published tab and the Live Preview tab are distinct surfaces: Published
      // runs the released artifact; Live Preview runs the current in-tree file
      // (which may differ from what was released). Masking working-tree behind
      // published would leave the Live Preview tab empty even though the file
      // exists — the exact symptom users hit after Tag & Release.
      const workingTree: MergedFunctionRow[] = [];
      const wtSeen = new Set<string>();
      // apiName → bound object-type apiName, inferred from each function's
      // source (`@ontology/sdk` import / `ObjectSet<X>`). Used to stamp BOTH
      // the working-tree row and the published row (the FE dedupes
      // published-first, so the published row must carry the type too).
      const objectTypeByApi = new Map<string, string | null>();
      try {
        const tree = await ctx.stemma.listTree({
          repositoryRid: rid,
          branch,
          path: "",
          depth: 5,
        });
        if (tree.kind === "ok") {
          for (const entry of tree.entries) {
            if (entry.type !== "blob") continue;
            // Shared identity rules (functions/discovery.ts): nested folders
            // supported — identity is the path under src/functions/ without
            // extension ("orders/calc"); root files keep their basename.
            const parsed = parseFunctionPath(entry.path);
            if (parsed === null) continue;
            const { apiName } = parsed;
            const ext = parsed.relativePath.endsWith(".py") ? "py" : "ts";
            if (wtSeen.has(apiName)) continue; // one working-tree entry per identity
            wtSeen.add(apiName);
            // Infer the bound object type from the source. TS only — Python
            // functions use a different convention and surface null (utility)
            // for now. Per-file try/catch so one unreadable file can't blank
            // detection for the rest.
            let objectTypeName: string | null = null;
            let signature: ListingSignature | null = null;
            if (ext === "ts") {
              try {
                const blob = await ctx.stemma.readBlob({
                  repositoryRid: rid,
                  branch,
                  path: entry.path,
                });
                if (blob.kind === "ok") {
                  const src = new TextDecoder("utf-8").decode(blob.content);
                  objectTypeName = inferFunctionObjectType(src);
                  // Same read already pays for the source: derive the input
                  // signature in the same pass (no extra I/O).
                  signature = deriveSignatureFromSource(entry.path, src);
                }
              } catch {
                // Best-effort: a read failure leaves this fn untyped (utility).
              }
            }
            objectTypeByApi.set(apiName, objectTypeName);
            workingTree.push({
              apiName,
              versionRid: null,
              functionRid: null,
              semver: null,
              branch,
              isPreview: true,
              runtime: parsed.runtime,
              commitSha: null,
              publishedAt: null,
              source: "working_tree",
              path: entry.path,
              relativePath: parsed.relativePath,
              draftOnly: false,
              hasDraft: false,
              objectTypeName,
              objectTypeIcon: null, // FE overlays icon/colour from the ontology
              signature,
            });
          }
        }
      } catch {
        // Discovery is best-effort. A Stemma fault must not break the
        // published-versions response.
      }

      // ---- Draft overlay (Foundry live-preview parity) ---------------------
      // Uncommitted editor work must appear in Live Preview BEFORE any
      // commit. Drafts are per-user (principal_sub), read fresh. A draft
      //     * editing a tracked file     → row content re-inferred from DRAFT
      //     * adding a NEW function file → extra row flagged draftOnly
      // File deletions are not drafts — the FE commits deletes immediately.
      const wtByApiName = new Map(workingTree.map((row) => [row.apiName, row]));
      const publishPrincipal = req.codeReposPrincipal;
      if (publishPrincipal) {
        try {
          const principalSub = isUuidV4(publishPrincipal.userId)
            ? publishPrincipal.userId
            : derivePrincipalSubUuid(publishPrincipal.userId);
          const drafts = await listDrafts(ctx.pool, { principalSub, repositoryRid: rid, branch });
          for (const draft of drafts) {
            const parsed = parseFunctionPath(draft.path);
            if (parsed === null) continue;
            const existing = wtByApiName.get(parsed.apiName);
            const objectTypeName =
              parsed.runtime === "NODE_20" ? inferFunctionObjectType(draft.content) : null;
            // The signature follows the DRAFT's source (Live Preview reflects
            // the editor, not HEAD) — same derivation pass as tree entries.
            const signature =
              parsed.runtime === "NODE_20"
                ? deriveSignatureFromSource(draft.path, draft.content)
                : null;
            objectTypeByApi.set(parsed.apiName, objectTypeName);
            if (existing) {
              // Draft wins over HEAD: the Live Preview tab reflects the
              // editor, not the last commit.
              existing.objectTypeName = objectTypeName;
              existing.hasDraft = true;
              existing.signature = signature;
            } else {
              const row: MergedFunctionRow = {
                apiName: parsed.apiName,
                versionRid: null,
                functionRid: null,
                semver: null,
                branch,
                isPreview: true,
                runtime: parsed.runtime,
                commitSha: null,
                publishedAt: null,
                source: "working_tree",
                path: draft.path,
                relativePath: parsed.relativePath,
                draftOnly: true,
                hasDraft: true,
                objectTypeName,
                objectTypeIcon: null,
                signature,
              };
              workingTree.push(row);
              wtByApiName.set(parsed.apiName, row);
            }
          }
        } catch {
          // Draft overlay is best-effort — the committed discovery above is
          // authoritative on its own.
        }
      }

      // Stamp the bound object type onto published rows WITHOUT a publish-time
      // `objectTypes` entry (historical manifests) via live-tree inference.
      for (const row of byApiName.values()) {
        if (row.objectTypeName === null && objectTypeByApi.has(row.apiName)) {
          row.objectTypeName = objectTypeByApi.get(row.apiName) ?? null;
        }
        // Historical manifests predating manifest.signatures: derive from the
        // live working-tree source (same apiName convention) when available.
        if (row.signature === null && objectTypeByApi.has(row.apiName)) {
          const wt = workingTree.find((w) => w.apiName === row.apiName);
          if (wt?.signature) row.signature = wt.signature;
        }
      }

      // Resolve registry function RIDs for deep-links (one query for all
      // published exports on this repo; retired rows excluded).
      if (byApiName.size > 0) {
        try {
          const apiNames = [...byApiName.keys()];
          const ridRes = await ctx.pool.query<{ rid: string; api_name: string }>(
            `SELECT rid, api_name FROM function_registry_function
              WHERE repository_rid = $1 AND api_name = ANY($2::text[]) AND retired_at IS NULL`,
            [rid, apiNames],
          );
          const ridByApi = new Map(ridRes.rows.map((r) => [r.api_name, r.rid]));
          for (const row of byApiName.values()) {
            row.functionRid = ridByApi.get(row.apiName) ?? null;
          }
        } catch {
          // Deep-link enrichment is optional — never fail the listing for it.
        }
      }

      const data = [...byApiName.values(), ...workingTree].sort((a, b) =>
        a.apiName.localeCompare(b.apiName) || a.source.localeCompare(b.source),
      );
      // The response embeds live working-tree + draft state; it must never
      // be served from a browser/intermediary cache or the IDE's Live
      // Preview would lag file adds/removes.
      res.setHeader("Cache-Control", "no-store");
      res
        .status(200)
        .type("application/json")
        .send(JSON.stringify({ data, totalCount: data.length, branch }));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
