// ---------------------------------------------------------------------------
// B2 — Boot-time in-memory Stemma rehydrator.
//
// Purpose. The in-memory `StemmaAdapter` test-double is process-local. When
// the backend restarts, every `code_repository` row in Postgres still
// resolves at the metadata layer (auth, list, get) but its branches and
// files are gone. The frontend then 404s on `GET /tree` and `GET /files`
// against existing RIDs, which looks like data loss to the user.
//
// This module re-injects every ACTIVE `code_repository` row into the
// in-memory adapter at startup so the read paths line up. It is a
// development-mode crutch that:
//
//   • Hard-rejects against any non-`InMemoryStemma` adapter — production
//     swaps in a real Stemma client whose persistence is authoritative,
//     and we MUST NOT accidentally write into it from Postgres metadata.
//   • Is idempotent — re-running over already-seeded RIDs is a no-op.
//   • Is best-effort — a single row failure logs and continues; it does
//     not block server start.
//
// When the real B1 Stemma server lands (with persistent ref + object
// storage), this module's only correct production behaviour is to log the
// "skipped" path and exit.
// ---------------------------------------------------------------------------

import type { Pool } from "pg";

import type { StemmaAdapter, TemplateAdapter } from "./adapters/types";
import { deriveDefaultPackageName } from "./saga/executor";

/**
 * Any StemmaAdapter that can report whether a repo has already been provisioned
 * durably. Both InMemoryStemma (sync) and PostgresStemma (async) expose this,
 * so the rehydrator works against either — it scaffolds repos that have no
 * content yet and SKIPS those already provisioned (preserving user commits).
 */
type RehydratableStemma = StemmaAdapter & {
  exists(rid: string): boolean | Promise<boolean>;
};
function isRehydratable(a: StemmaAdapter): a is RehydratableStemma {
  return typeof (a as Partial<RehydratableStemma>).exists === "function";
}

export interface RehydrateInMemoryStemmaArgs {
  readonly pool: Pool;
  readonly stemma: StemmaAdapter;
  /**
   * Template adapter used to re-scaffold each rehydrated branch. Wave 22
   * dropped the in-memory Stemma adapter's auto-seed (`DEFAULT_SCAFFOLD`)
   * because it was a placeholder that diverged from the real B3 manifest.
   * Without re-scaffolding here, every restart leaves existing repos as
   * empty branches and the frontend file viewer renders blank.
   *
   * Optional: if absent the rehydrator only re-creates the empty branch
   * (legacy behaviour, preserved for unit-test seams that don't need a
   * scaffold).
   */
  readonly template?: TemplateAdapter;
  /**
   * Optional structured logger. Receives `(event, meta)` so callers can
   * pipe through pino/winston/etc. Defaults to a no-op (intentional — the
   * server's request logger handles ordinary lifecycle).
   */
  readonly logger?: (event: string, meta?: Record<string, unknown>) => void;
}

export interface RehydrateInMemoryStemmaResult {
  /** True when the adapter is the in-memory test-double; false otherwise. */
  readonly applied: boolean;
  /** Number of RIDs newly injected into the in-memory adapter. */
  readonly rehydrated: number;
  /** Number of RIDs already present in the adapter (idempotent skip). */
  readonly skipped: number;
  /** Number of RIDs whose seed call returned non-ok. */
  readonly failed: number;
  /** Total ACTIVE rows scanned. */
  readonly total: number;
}

/**
 * Rehydrate the in-memory Stemma adapter from Postgres `code_repository` rows.
 *
 * Returns immediately (with `applied: false`) if `stemma` is not an
 * `InMemoryStemma`. Errors during the scan/insert loop are logged via the
 * provided `logger` and counted in `failed`; they do not throw.
 */
export async function rehydrateInMemoryStemma(
  args: RehydrateInMemoryStemmaArgs,
): Promise<RehydrateInMemoryStemmaResult> {
  const log = args.logger ?? (() => {});

  // ---------------------------------------------------------------------
  // Works against any adapter that can report `exists(rid)` — both the
  // in-memory adapter (re-scaffolds volatile state every boot) and the
  // durable PostgresStemma (scaffolds each repo exactly ONCE, then skips so
  // user commits persist). An adapter without `exists` cannot be reconciled
  // from metadata, so we skip.
  // ---------------------------------------------------------------------
  if (!isRehydratable(args.stemma)) {
    log("code-repos.rehydrate.skip-real-adapter");
    return { applied: false, rehydrated: 0, skipped: 0, failed: 0, total: 0 };
  }
  const stemma = args.stemma;

  type Row = {
    rid: string;
    default_branch: string;
    created_by: string;
    display_name: string;
    template_id: string;
    template_version: string;
  };
  let rows: ReadonlyArray<Row>;
  try {
    const r = await args.pool.query<Row>(
      `SELECT rid, default_branch, created_by,
              display_name, template_id, template_version
         FROM code_repository
        WHERE state = 'ACTIVE'`,
    );
    rows = r.rows;
  } catch (err) {
    log("code-repos.rehydrate.scan-failed", {
      message: (err as Error).message,
    });
    return { applied: true, rehydrated: 0, skipped: 0, failed: 0, total: 0 };
  }

  let rehydrated = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    if (await stemma.exists(row.rid)) {
      skipped += 1;
      continue;
    }
    try {
      const out = await stemma.createRepository({
        proposedRid: row.rid,
        defaultBranchName: row.default_branch,
        principalSub: row.created_by,
      });
      if (out.kind !== "ok") {
        failed += 1;
        log("code-repos.rehydrate.seed-non-ok", {
          rid: row.rid,
          kind: out.kind,
        });
        continue;
      }

      // Re-scaffold the branch from the template manifest. This mirrors the
      // saga's runStep3 (`executor.ts:267-323`): same packageName derivation,
      // same template adapter call, same parameters envelope. Without this
      // step the branch is structurally present but contains zero files,
      // which is what a user sees in the file viewer as "empty repo".
      if (args.template) {
        try {
          const scaffoldOut = await args.template.scaffoldAndPush({
            repositoryRid: row.rid,
            targetBranch: row.default_branch,
            templateId: row.template_id,
            templateVersion: row.template_version,
            principalSub: row.created_by,
            parameters: {
              packageName: deriveDefaultPackageName(row.display_name),
            },
          });
          if (scaffoldOut.kind !== "ok") {
            failed += 1;
            log("code-repos.rehydrate.scaffold-non-ok", {
              rid: row.rid,
              kind: scaffoldOut.kind,
            });
            continue;
          }
        } catch (err) {
          failed += 1;
          log("code-repos.rehydrate.scaffold-threw", {
            rid: row.rid,
            message: (err as Error).message,
          });
          continue;
        }
      }

      rehydrated += 1;
      log("code-repos.rehydrate.seeded", {
        rid: row.rid,
        branch: row.default_branch,
        scaffolded: Boolean(args.template),
      });
    } catch (err) {
      failed += 1;
      log("code-repos.rehydrate.seed-threw", {
        rid: row.rid,
        message: (err as Error).message,
      });
    }
  }

  log("code-repos.rehydrate.done", {
    total: rows.length,
    rehydrated,
    skipped,
    failed,
  });

  return { applied: true, rehydrated, skipped, failed, total: rows.length };
}
