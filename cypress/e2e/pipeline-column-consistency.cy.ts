/**
 * Pipeline Builder — dataset-node ↔ Transform-panel column-count invariant.
 *
 * The column count rendered on the dataset node card MUST equal the number
 * of column chips rendered in the Transform panel for that same node, AND
 * the literal "N columns" label inside the Transform panel.
 *
 * Bug this guards against
 * -----------------------
 * The Pipeline Builder reads column counts from two different sources:
 *   - Node card: `foundry_datasets.column_count`
 *     (`src/services/pipelineService.ts:319`)
 *   - Transform panel: `count(dataset_columns)` via
 *     `transformService.resolveNodeDataset`
 *     (`src/services/transformService.ts:1890-1898`)
 * When the two diverge — historically because an unsanitized CSV header
 * collapsed duplicate / blank cells at ingestion time — the user sees
 * "9 columns" on the node and "7 columns" on the panel for the same
 * dataset. This test pins the invariant so any future regression is
 * caught at PR time.
 *
 * Setup contract
 *   - `cy.task('db:reparse', { filename, projectId })` reparses every
 *     `foundry_datasets` row matching the filename inside the project so
 *     the test starts from a known-good state.
 *   - `cy.task('db:divergenceCount')` returns the global divergent-row
 *     count; the test fails fast if the DB is dirty before we even open
 *     the UI.
 *
 * Env (Cypress.env or CYPRESS_*):
 *   PROJECT_ID         project that owns the pipeline
 *   PIPELINE_ID        pipeline to open in the builder
 *   DATASET_FILENAME   filename of the dataset node under test
 */

describe("Pipeline Builder — column-count invariant", () => {
  const PROJECT_ID = Cypress.env("PROJECT_ID") as string;
  const PIPELINE_ID = Cypress.env("PIPELINE_ID") as string;
  const DATASET_FILENAME =
    (Cypress.env("DATASET_FILENAME") as string) ||
    "orders_bureau_transactional_system.csv";

  before(() => {
    expect(PROJECT_ID, "PROJECT_ID env").to.be.a("string").and.not.empty;
    expect(PIPELINE_ID, "PIPELINE_ID env").to.be.a("string").and.not.empty;

    // 1. Recover any historical divergence for this dataset so the test
    //    measures the steady-state contract, not yesterday's data bug.
    cy.task("db:reparse", { filename: DATASET_FILENAME, projectId: PROJECT_ID });

    // 2. Hard global check — if any dataset is still divergent globally
    //    the test fails before we even open the UI. Cheap and loud.
    cy.task("db:divergenceCount").then((count) => {
      expect(count, "global divergent-dataset count").to.eq(0);
    });
  });

  it("node card count = Transform panel chip count = panel header label", () => {
    cy.visit(`/projects/${PROJECT_ID}/pipeline-builder/${PIPELINE_ID}`);

    cy.contains('[data-testid="pipeline-node"]', DATASET_FILENAME)
      .as("datasetNode")
      .should("be.visible");

    // (a) read the card count
    cy.get("@datasetNode")
      .find('[data-testid="node-column-count"]')
      .invoke("text")
      .then((cardText) => {
        const cardCount = Number((cardText.match(/(\d+)/) || [])[1]);
        expect(cardCount, "card count is a positive integer").to.be.greaterThan(0);

        // (b) open the Transform panel anchored on the same node
        cy.get("@datasetNode")
          .find('[data-testid="add-transform-button"]')
          .click();

        cy.get('[data-testid="transform-panel"]', { timeout: 10_000 })
          .should("be.visible");

        // (c) panel header literal label
        cy.get('[data-testid="transform-source-label"]')
          .invoke("text")
          .should("match", new RegExp(`\\b${cardCount}\\s+columns\\b`));

        // (d) panel chip count
        cy.get('[data-testid="transform-column-chip"]')
          .should("have.length", cardCount);

        // (e) backend invariant — every chip's name must be a column we'd
        //     get from a clean re-read of `dataset_columns`. Catches the
        //     opposite drift (chips show MORE than the card).
        cy.task<string[]>("db:datasetColumns", {
          filename: DATASET_FILENAME,
          projectId: PROJECT_ID,
        }).then((expectedColumns) => {
          expect(expectedColumns.length, "DB column count").to.eq(cardCount);
          cy.get('[data-testid="transform-column-chip"]').each(($chip) => {
            const name = $chip.text().trim();
            expect(expectedColumns).to.include(name);
          });
        });
      });
  });
});
