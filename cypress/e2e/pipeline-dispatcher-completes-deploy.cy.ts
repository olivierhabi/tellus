/**
 * pipeline-dispatcher-completes-deploy.cy.ts
 *
 * Regression test for the deploy-hang bug fixed in
 * `src/services/pipelines/pipelineDispatcher.ts`. Before the fix the
 * PG dispatcher would short-circuit on `deployStart` signals whenever
 * `isTemporalConnected()` returned true, on the false premise that
 * a Temporal worker would pick them up. There is no pipeline-deploy
 * Temporal workflow registered, so signals were consumed and dropped,
 * leaving `pipeline_deployments` rows pinned at `status='running'`
 * indefinitely.
 *
 * This spec exercises the same code path the production controller
 * uses (`pipeline_deployments` insert + matching `pipeline_signal`
 * row with `signal_type='deployStart'`) and polls the deployment
 * row until terminal status, asserting:
 *
 *   1. The dispatcher actually picks up the signal within the tick
 *      window (default 2s; we give it 15s for cold-start headroom).
 *   2. The deployment reaches `status='succeeded'`.
 *   3. The materialized output has the expected column count (drawn
 *      from the upstream union/join snapshot — the deploy-time schema
 *      invariant from `src/services/deploymentService.ts:2061-2114`).
 *
 * If this spec ever returns to red, the bug has reverted.
 *
 * Defaults target the previously-affected pipeline. Override via env:
 *   CYPRESS_PROJECT_ID=… CYPRESS_PIPELINE_ID=… CYPRESS_EXPECTED_COLUMNS=…
 *
 * Direct DB tasks are used (`db:insertDeployStart`, `db:deploymentStatus`,
 * `db:abortIfRunning`) instead of an HTTP round-trip so the test does
 * not depend on auth wiring or the controller's idempotency layer —
 * the dispatcher's behavior is the only thing under test.
 */

describe('Pipeline dispatcher — completes deployStart signals end-to-end', () => {
  const PROJECT_ID =
    (Cypress.env('PROJECT_ID') as string | undefined) ??
    '36271681-65d7-4c55-a6d0-20137f8212dc';
  const PIPELINE_ID =
    (Cypress.env('PIPELINE_ID') as string | undefined) ??
    '0c05f9cf-c4cb-488c-8f5b-1e1497390caa';
  const EXPECTED_COLUMNS = Number(Cypress.env('EXPECTED_COLUMNS') ?? 11);
  const POLL_BUDGET_MS = 20_000;
  const POLL_INTERVAL_MS = 1_000;

  let deploymentId: string | undefined;

  afterEach(() => {
    if (deploymentId) {
      cy.task('db:abortIfRunning', { deploymentId });
    }
  });

  it(
    'dispatcher consumes deployStart, executor materializes, ' +
      'row reaches succeeded with expected column count',
    () => {
      // 1. Enqueue the deploy exactly the way the controller does.
      cy.task<{ deploymentId: string }>('db:insertDeployStart', {
        projectId: PROJECT_ID,
        pipelineId: PIPELINE_ID,
      }).then((res) => {
        expect(res.deploymentId).to.match(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
        deploymentId = res.deploymentId;
      });

      // 2. Poll for a terminal state within budget.
      const deadline = Date.now() + POLL_BUDGET_MS;
      const pollOnce = (): Cypress.Chainable<unknown> =>
        cy
          .task<{
            status: string;
            duration_ms: number | null;
            error_message: string | null;
            build_results: Array<{
              status: string;
              columnCount: number;
              datasetId: string;
              nodeLabel: string;
            }> | null;
          } | null>('db:deploymentStatus', { deploymentId })
          .then((row) => {
            if (!row) {
              throw new Error(`deployment ${deploymentId} disappeared`);
            }
            if (
              row.status === 'succeeded' ||
              row.status === 'failed' ||
              row.status === 'cancelled'
            ) {
              return row;
            }
            if (Date.now() >= deadline) {
              throw new Error(
                `deployment ${deploymentId} did not reach terminal status ` +
                  `within ${POLL_BUDGET_MS}ms — dispatcher may be regressed ` +
                  `(last status: ${row.status})`,
              );
            }
            cy.wait(POLL_INTERVAL_MS, { log: false });
            return pollOnce();
          });

      pollOnce().then((row) => {
        const r = row as {
          status: string;
          duration_ms: number | null;
          error_message: string | null;
          build_results: Array<{
            status: string;
            columnCount: number;
            datasetId: string;
            nodeLabel: string;
          }> | null;
        };
        // 3. Assert terminal state.
        expect(
          r.status,
          `dispatcher must complete the deploy — got error=${r.error_message}`,
        ).to.equal('succeeded');
        expect(r.duration_ms, 'duration_ms recorded').to.be.greaterThan(0);

        // 4. Assert the materialized output schema width — pins the
        // deploy-time schema invariant on top of the dispatcher path.
        expect(r.build_results, 'build_results populated').to.be.an('array');
        const builds = r.build_results ?? [];
        expect(builds.length, 'at least one output built').to.be.greaterThan(0);
        for (const b of builds) {
          expect(b.status, `output ${b.nodeLabel} succeeded`).to.equal('succeeded');
          expect(
            b.columnCount,
            `output ${b.nodeLabel} materialized ${b.columnCount} columns ` +
              `(expected ${EXPECTED_COLUMNS}) — schema invariant failure`,
          ).to.equal(EXPECTED_COLUMNS);
          expect(b.datasetId, 'output dataset id').to.match(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
          );
        }
        // The test passed — clear the cleanup-hook handle so we don't
        // overwrite a green run with a "running" abort.
        deploymentId = undefined;
      });
    },
  );
});
