// ---------------------------------------------------------------------------
// Foundry parity — Datasets v2 storage model (transactions & branches).
//
// Docs:
//   "A default branch - `master` for most enrollments - will be created on
//    the Dataset."                                (Datasets v2 • Create Dataset)
//   "The output dataset is fully replaced by the latest pipeline output
//    every build."                    (pipeline-builder • computation modes)
//   errors: TransactionNotFound (404), BranchAlreadyExists (409 CONFLICT —
//   "The branch cannot be created because a branch with that name already
//    exists.")                                   (Datasets v2 • Transactions /
//                                                Branches resources)
//
// Acceptance: after N deploys the dataset exposes N correctly-ordered
// SNAPSHOT transactions on `master`, each committed; the dataset row's
// latest view comes from the same payload (verified live in the audit).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

import {
  DatasetTransactionService,
  DEFAULT_BRANCH,
} from "../../../src/services/datasets/transactionService";
import { AppError } from "../../../src/utils/foundryAppError";

const DATASET = "cdb81fc0-7f8e-4ee4-b2cb-3d17e61de155";
const DEPLOY = "b084fa9c-b470-46a9-bf35-77c269b8ba55";
const TX = "aaaaaaaa-0000-0000-0000-000000000001";

interface InsertRec {
  table: string;
  payload: Record<string, unknown>;
}

/** Chainable knex stub capturing inserts / first / orderBy / transaction. */
function stubKnex(opts: { firstResult?: unknown; insertError?: unknown } = {}) {
  const inserts: InsertRec[] = [];
  const orderBys: string[] = [];
  const chain = (table: string): Record<string, unknown> => {
    const c: Record<string, unknown> = {};
    c.where = () => c;
    c.whereNull = () => c;
    c.select = () => c;
    c.first = async () => opts.firstResult;
    c.orderBy = (col: string, dir?: string) => {
      orderBys.push(`${col}:${dir ?? "asc"}`);
      return c;
    };
    c.limit = () => c;
    c.insert = (payload: Record<string, unknown>) => {
      if (opts.insertError) {
        return {
          onConflict: () => ({ ignore: async () => { throw opts.insertError; } }),
          returning: async () => { throw opts.insertError; },
        };
      }
      inserts.push({ table, payload });
      return {
        onConflict: () => ({
          ignore: () => ({ returning: async () => [{ transaction_id: TX }] }),
        }),
        returning: async () => [{ transaction_id: TX }],
      };
    };
    return c;
  };
  const knex = Object.assign(chain as unknown as Function, {
    transaction: async (cb: (trx: unknown) => Promise<unknown>) => cb(knex),
    raw: (sql: string) => sql,
    queryBuilder: () => ({
      select: () => ({ from: () => ({ where: () => "optimistic-max-plus-one" }) }),
    }),
  });
  return {
    knex,
    get inserts() {
      return inserts;
    },
    orderBys,
  };
}

describe("recordBuild — commit the build as a transaction on `master`", () => {
  it("seeds the master branch, commits a SNAPSHOT with build id, writes a version", async () => {
    const stub = stubKnex();
    const svc = new DatasetTransactionService(stub.knex as never);

    const txId = await svc.recordBuild({
      datasetId: DATASET,
      deploymentId: DEPLOY,
      filePath: "projects/p/pipeline-outputs/pl/fraud_signal.csv",
      rowCount: 139,
      columnCount: 43,
      createdBy: "u1",
      metadata: { pipelineId: "pl", outputNodeId: "n1" },
    });

    expect(txId).toBe(TX);

    const branchSeed = stub.inserts.find((i) => i.table === "foundry_dataset_branches");
    expect(branchSeed).toMatchObject({
      payload: { dataset_id: DATASET, branch_name: DEFAULT_BRANCH, is_default: true },
    });

    const tx = stub.inserts.find((i) => i.table === "foundry_dataset_transactions");
    expect(tx).toBeTruthy();
    expect(tx!.payload).toMatchObject({
      dataset_id: DATASET,
      branch_name: "master",
      transaction_type: "SNAPSHOT", // default write mode
      status: "committed",
      deployment_id: DEPLOY,
      row_count: 139,
      column_count: 43,
    });
    expect(tx!.payload.committed_at).toBeInstanceOf(Date);

    const version = stub.inserts.find((i) => i.table === "dataset_versions");
    expect(version).toBeTruthy();
    expect(version!.payload.dataset_id).toBe(DATASET);
    expect(String(version!.payload.change_summary)).toContain(DEPLOY);
    // version_number is the optimistic max+1 subquery — no SELECT-then-INSERT race.
    expect(version!.payload.version_number).toBeTruthy();
  });

  it("seeds a non-default branch too when a build targets one", async () => {
    const stub = stubKnex();
    const svc = new DatasetTransactionService(stub.knex as never);
    await svc.recordBuild({ datasetId: DATASET, branch: "dev", filePath: "p" });
    const branches = stub.inserts.filter((i) => i.table === "foundry_dataset_branches");
    expect(branches).toHaveLength(2);
    expect(branches[1]!.payload).toMatchObject({ branch_name: "dev", is_default: false });
  });
});

describe("historical reads", () => {
  it("lists committed transactions on master, newest first", async () => {
    const stub = stubKnex();
    const svc = new DatasetTransactionService(stub.knex as never);
    await svc.listTransactions(DATASET);
    expect(stub.orderBys).toEqual(["committed_at:desc", "created_at:desc"]);
  });

  it("TransactionNotFound → 404 TRANSACTION_NOT_FOUND with parameters", async () => {
    const stub = stubKnex({ firstResult: undefined });
    const svc = new DatasetTransactionService(stub.knex as never);
    let err: AppError | undefined;
    try {
      await svc.getTransaction(DATASET, "nope");
    } catch (e) {
      err = e as AppError;
    }
    expect(err!.statusCode).toBe(404);
    expect(err!.code).toBe("TRANSACTION_NOT_FOUND");
    expect(err!.errorName).toBe("TransactionNotFound");
    expect(err!.parameters).toMatchObject({ transactionRid: "nope" });
  });
});

describe("createBranch", () => {
  it("BranchAlreadyExists → 409 with the documented shape", async () => {
    const stub = stubKnex({ firstResult: { id: DATASET }, insertError: { code: "23505" } });
    const svc = new DatasetTransactionService(stub.knex as never);
    let err: AppError | undefined;
    try {
      await svc.createBranch(DATASET, "dev");
    } catch (e) {
      err = e as AppError;
    }
    expect(err!.statusCode).toBe(409);
    expect(err!.code).toBe("BRANCH_ALREADY_EXISTS");
    expect(err!.errorName).toBe("BranchAlreadyExists");
    expect(err!.parameters).toMatchObject({ branchName: "dev" });
  });
});

describe("deploy wiring", () => {
  const source = readFileSync(
    resolve(__dirname, "../../../src/services/deploymentService.ts"),
    "utf-8",
  );

  it("BOTH build paths commit an output transaction", () => {
    const calls = source.match(/await this\.recordOutputTransaction\(\{/g) ?? [];
    expect(calls).toHaveLength(2);
  });

  it("routes expose transactions and branches with the documented errors", () => {
    const routes = readFileSync(
      resolve(__dirname, "../../../src/routes/foundryDatasets.ts"),
      "utf-8",
    );
    expect(routes).toContain("'/:datasetId/transactions'");
    expect(routes).toContain("'/:datasetId/transactions/:transactionId'");
    expect(routes).toContain("'/:datasetId/branches'");
    expect(routes).toContain("txService.createBranch");
  });
});
