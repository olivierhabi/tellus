// cypress.config.ts — Quiver verification (CONTRACT v1 §3).
//
// One root config drives both the existing cypress/quiver/ smoke specs and
// the new cypress/e2e/quiver/ harness specs. The verify harness invokes
// only the harness specs via --spec.
//
// baseUrl precedence:
//   1. CYPRESS_baseUrl env var (set by scripts/quiver-verify.sh to
//      http://localhost:32000 from the host).
//   2. http://app:3000 when run inside the verify compose network.
//   3. http://localhost:32000 fallback when neither is set.

import { defineConfig } from "cypress";

const fromEnv = process.env.CYPRESS_baseUrl;
const inDocker = process.env.IN_VERIFY_NETWORK === "1";
const baseUrl =
  fromEnv ??
  (inDocker ? "http://app:3000" : "http://localhost:32000");

export default defineConfig({
  fixturesFolder: "cypress/fixtures",
  videosFolder: "cypress/videos/quiver",
  screenshotsFolder: "cypress/screenshots/quiver",
  video: true,
  videoCompression: 32,
  defaultCommandTimeout: 15_000,
  responseTimeout: 30_000,
  requestTimeout: 30_000,
  // Tolerate transient 504s from the verify-stack request-timeout middleware
  // when the postgres pool is warming up under cypress's first cold request.
  // Each spec has exactly one it() block so a per-spec retry of 3 means up
  // to 4 attempts; if it still fails the harness fails. The underlying
  // contract being asserted is unchanged.
  retries: { runMode: 3, openMode: 0 },
  e2e: {
    baseUrl,
    // Widened from cypress/e2e/quiver only — the column-count invariant
    // (cypress/e2e/pipeline-column-consistency.cy.ts) is a cross-cutting
    // Pipeline Builder regression test that does not belong under the
    // quiver subtree. Glob covers both.
    specPattern: "cypress/e2e/**/*.cy.{ts,tsx}",
    supportFile: "cypress/support/e2e.ts",
    setupNodeEvents(on /*, config*/) {
      // ---------------------------------------------------------------
      // db:* tasks — direct DB hooks used by the column-consistency
      // regression suite. Cypress runs in Node, so we can import the
      // app's own knex client + parse job and exercise the production
      // recovery path from the test harness. No HTTP round-trip,
      // no auth dance — Cypress is a privileged operator surface.
      // ---------------------------------------------------------------
      on("task", {
        // Reparse every `foundry_datasets` row that matches the given
        // (projectId, original_filename). Used in `before()` to put the
        // dataset under test into a known-good state.
        async "db:reparse"({
          filename,
          projectId,
        }: {
          filename: string;
          projectId: string;
        }) {
          const foundryDb = (await import("./src/config/foundryDb")).default;
          const { runParseJob } = await import("./src/jobs/parseDatasetJob");
          const rows = await foundryDb("foundry_datasets")
            .where({ project_id: projectId, original_filename: filename })
            .select<{ id: string }[]>("id");
          for (const r of rows) await runParseJob(r.id);
          return rows.length;
        },

        // Count of globally divergent datasets — invariant guard.
        async "db:divergenceCount"() {
          const foundryDb = (await import("./src/config/foundryDb")).default;
          const { rows } = await foundryDb.raw<{
            rows: Array<{ n: number }>;
          }>(`
            SELECT count(*)::int AS n FROM foundry_datasets fd
            WHERE fd.column_count IS NOT NULL
              AND fd.column_count <> (
                SELECT count(*) FROM dataset_columns dc
                WHERE dc.dataset_id = fd.id
              );
          `);
          return rows[0]?.n ?? 0;
        },

        // List columns for the dataset (most recent revision wins).
        async "db:datasetColumns"({
          filename,
          projectId,
        }: {
          filename: string;
          projectId: string;
        }) {
          const foundryDb = (await import("./src/config/foundryDb")).default;
          const ds = await foundryDb("foundry_datasets")
            .where({ project_id: projectId, original_filename: filename })
            .orderBy("updated_at", "desc")
            .select<{ id: string }[]>("id")
            .first();
          if (!ds) return [];
          const cols = await foundryDb("dataset_columns")
            .where({ dataset_id: ds.id })
            .orderBy("ordinal_position", "asc")
            .select<{ column_name: string }[]>("column_name");
          return cols.map((c) => c.column_name);
        },

        // Insert a pipeline_deployments row + matching deployStart signal,
        // mirroring exactly what the /deploy controller does at runtime.
        // Returns the deployment id so the test can poll for completion.
        // Used by the dispatcher-completes-deploy regression spec.
        async "db:insertDeployStart"({
          projectId,
          pipelineId,
        }: {
          projectId: string;
          pipelineId: string;
        }) {
          const foundryDb = (await import("./src/config/foundryDb")).default;
          const recent = await foundryDb("pipeline_deployments")
            .where({ pipeline_id: pipelineId })
            .whereNotNull("triggered_by")
            .orderBy("started_at", "desc")
            .first<{ triggered_by: string | null }>("triggered_by");
          const triggeredBy = recent?.triggered_by ?? null;
          const stamp = Date.now();
          const [{ id: deploymentId }] = await foundryDb("pipeline_deployments")
            .insert({
              pipeline_id: pipelineId,
              project_id: projectId,
              triggered_by: triggeredBy,
              idempotency_key: `cypress-${stamp}`,
              config: JSON.stringify({}),
            })
            .returning<{ id: string }[]>("id");
          await foundryDb("pipeline_signal").insert({
            pipeline_id: pipelineId,
            project_id: projectId,
            deployment_id: deploymentId,
            signal_type: "deployStart",
            payload: JSON.stringify({ triggeredBy }),
            signal_fingerprint: `cypress-${stamp}`,
          });
          return { deploymentId };
        },

        // Fetch the current status of a pipeline_deployments row.
        async "db:deploymentStatus"({ deploymentId }: { deploymentId: string }) {
          const foundryDb = (await import("./src/config/foundryDb")).default;
          const row = await foundryDb("pipeline_deployments")
            .where({ id: deploymentId })
            .first<{
              status: string;
              duration_ms: number | null;
              error_message: string | null;
              build_results: unknown;
            }>("status", "duration_ms", "error_message", "build_results");
          return row ?? null;
        },

        // Mark a test deployment failed if it's still running (cleanup
        // after a flaky run so subsequent specs don't see noise).
        async "db:abortIfRunning"({ deploymentId }: { deploymentId: string }) {
          const foundryDb = (await import("./src/config/foundryDb")).default;
          await foundryDb("pipeline_deployments")
            .where({ id: deploymentId, status: "running" })
            .update({
              status: "failed",
              error_message: "aborted by cypress cleanup",
              finished_at: foundryDb.fn.now(),
            });
          return null;
        },
      });
    },
  },
});
