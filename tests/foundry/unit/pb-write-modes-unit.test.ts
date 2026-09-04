// ---------------------------------------------------------------------------
// Foundry parity — write modes + replay-on-deploy.
//
// Doc (pipeline-builder/outputs-add-dataset-output), per mode:
//   default                    → "APPEND if at least one input is marked as
//                                 incremental and all incremental inputs had
//                                 only APPEND or additive UPDATE transactions
//                                 since the previous build. Otherwise ...
//                                 a SNAPSHOT transaction"
//   snapshot_replace           → "SNAPSHOT ... merged with the previous
//                                 output. Existing primary keys in the
//                                 previous output will be dropped in favor
//                                 of the new rows"
//   snapshot_replace_and_remove→ "SNAPSHOT ... merged ... followed by a
//                                 post-filtering stage to remove rows from
//                                 previous transactions based on a provided
//                                 boolean post_filtering_column"
//   changelog                  → "a series of APPEND transactions that
//                                 contain the complete history of changes"
//   append_only_new            → "APPEND ... only new rows, defined as newly
//                                 seen primary keys"
//   snapshot_only_new          → "SNAPSHOT ... only rows with newly seen
//                                 primary keys are kept"
//   always_append              → "an APPEND transaction"
//
// Replay (building-pipelines/create-incremental-pipeline-pb):
//   "Replaying on deploy will produce a SNAPSHOT transaction on the output
//    dataset."
// ---------------------------------------------------------------------------

import { describe, expect, it, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

import {
  applyWriteMode,
  validateWriteModeConfig,
} from "../../../src/services/pipelines/writeModes";
import { AppError } from "../../../src/utils/foundryAppError";

const prevRows = [
  { claim_id: "C1", flagged: "true" },
  { claim_id: "C2", flagged: "false" },
];
const newRows = [
  { claim_id: "C2", flagged: "true" }, // update of an existing PK
  { claim_id: "C3", flagged: "false" }, // brand-new PK
  { claim_id: "C3", flagged: "true" }, // duplicate PK within the tx
];

describe("documented transaction type per write mode", () => {
  it("default → SNAPSHOT when inputs carry no incremental markers", () => {
    const r = applyWriteMode({
      config: { writeMode: "default" },
      prevRows,
      newRows,
      incrementalAppendEligible: false,
    });
    expect(r.transactionType).toBe("SNAPSHOT");
    // Full replace view — previous rows gone.
    expect(r.rows).toEqual(newRows);
  });

  it("default → APPEND only when all inputs are incremental appends", () => {
    const r = applyWriteMode({
      config: { writeMode: "default" },
      prevRows,
      newRows,
      incrementalAppendEligible: true,
    });
    expect(r.transactionType).toBe("APPEND");
    expect(r.rows).toHaveLength(2 + 3); // view = previous + new
  });

  it("always_append → APPEND, view = previous + new unmodified", () => {
    const r = applyWriteMode({
      config: { writeMode: "always_append" },
      prevRows,
      newRows,
    });
    expect(r.transactionType).toBe("APPEND");
    expect(r.rows.map((r2) => r2.claim_id)).toEqual(["C1", "C2", "C2", "C3", "C3"]);
  });

  it("changelog → APPEND preserving the complete history (no merge, no dedupe)", () => {
    const r = applyWriteMode({
      config: { writeMode: "changelog", primaryKey: "claim_id" },
      prevRows,
      newRows,
    });
    expect(r.transactionType).toBe("APPEND");
    expect(r.rows).toHaveLength(5);
  });

  it("append_only_new → APPEND with only newly seen primary keys added", () => {
    const r = applyWriteMode({
      config: { writeMode: "append_only_new", primaryKey: "claim_id" },
      prevRows,
      newRows,
    });
    expect(r.transactionType).toBe("APPEND");
    // C2 exists in prev → dropped; C3 appended once (in-tx dedupe keeps 1).
    expect(r.rows.map((x) => x.claim_id)).toEqual(["C1", "C2", "C3"]);
    expect(r.appendedRowCount).toBe(1);
  });

  it("snapshot_replace → SNAPSHOT with previous PKs dropped in favor of new rows", () => {
    const r = applyWriteMode({
      config: { writeMode: "snapshot_replace", primaryKey: "claim_id" },
      prevRows,
      newRows,
    });
    expect(r.transactionType).toBe("SNAPSHOT");
    // PK-unique view; C2 carries the NEW row's value.
    const byId = Object.fromEntries(r.rows.map((x) => [x.claim_id, x.flagged]));
    expect(Object.keys(byId).sort()).toEqual(["C1", "C2", "C3"]);
    expect(byId.C2).toBe("true");
    expect(byId.C3).toBe("true"); // in-tx dupes resolved (kept last)
  });

  it("snapshot_replace_and_remove → SNAPSHOT, post-filtering column removes flagged rows", () => {
    const r = applyWriteMode({
      config: {
        writeMode: "snapshot_replace_and_remove",
        primaryKey: "claim_id",
        postFilteringColumn: "flagged",
      },
      prevRows,
      newRows,
    });
    expect(r.transactionType).toBe("SNAPSHOT");
    // flagged=true rows removed: only C2? no — merged view has C1(true),
    // C2(new true), C3(last true) → all flagged → empty.
    expect(r.rows).toHaveLength(0);
  });

  it("snapshot_only_new → SNAPSHOT keeping only newly seen PKs (dupes kept)", () => {
    const r = applyWriteMode({
      config: { writeMode: "snapshot_only_new", primaryKey: "claim_id" },
      prevRows,
      newRows,
    });
    expect(r.transactionType).toBe("SNAPSHOT");
    expect(r.rows.map((x) => x.claim_id)).toEqual(["C3", "C3"]);
  });
});

describe("validation", () => {
  it("PK-dependent modes fail fast without a primary key", () => {
    for (const mode of [
      "snapshot_replace",
      "snapshot_replace_and_remove",
      "changelog",
      "append_only_new",
      "snapshot_only_new",
    ]) {
      expect(() =>
        validateWriteModeConfig({ writeMode: mode }),
      ).toThrowError(AppError);
    }
  });

  it("snapshot_replace_and_remove also requires postFilteringColumn", () => {
    expect(() =>
      validateWriteModeConfig({ writeMode: "snapshot_replace_and_remove", primaryKey: "k" }),
    ).toThrowError(AppError);
  });
});

describe("replay on deploy", () => {
  const PK_MODES = [
    "default",
    "always_append",
    "changelog",
    "append_only_new",
    "snapshot_replace",
    "snapshot_replace_and_remove",
    "snapshot_only_new",
  ];

  it.each(PK_MODES)(
    "mode %s under replay → SNAPSHOT with the fully recomputed result",
    (mode) => {
      const r = applyWriteMode({
        config: {
          writeMode: mode,
          primaryKey: "claim_id",
          postFilteringColumn: "flagged",
        },
        prevRows,
        newRows,
        incrementalAppendEligible: true, // even under an APPEND-eligible chain
        replay: true,
      });
      // Doc: "Replaying on deploy will produce a SNAPSHOT transaction on the
      // output dataset."
      expect(r.transactionType).toBe("SNAPSHOT");
      expect(r.rows).toEqual(newRows);
    },
  );
});

describe("wiring", () => {
  const deploy = readFileSync(
    resolve(__dirname, "../../../src/services/deploymentService.ts"),
    "utf-8",
  );
  const ctrl = readFileSync(
    resolve(__dirname, "../../../src/controllers/pipelineController.ts"),
    "utf-8",
  );

  it("executeBuild applies the write mode and forces SNAPSHOT on replay", () => {
    expect(deploy).toContain("applyWriteMode({");
    expect(deploy).toContain("validateWriteModeConfig(writeModeConfig)");
    expect(deploy).toContain("replayOnDeploy");
    expect(deploy).toContain("transactionType: buildTransactionType");
    // The previous view comes from the committed-transaction log.
    expect(deploy).toContain("readLatestViewRows(existingDatasetId)");
  });

  it("deploy API accepts ?replay=true and threads it to the deployment config", () => {
    expect(ctrl).toContain("const replay = truthy(req.query.replay);");
    expect(deploy).toContain('replay: opts.replay === true || undefined,');
  });
});
