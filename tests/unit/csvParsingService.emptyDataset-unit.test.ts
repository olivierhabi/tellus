import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { Knex } from "knex";
import { CsvParsingService } from "../../src/services/csvParsingService";

describe("CsvParsingService header-only datasets", () => {
  it("persists schema without manufacturing a data row", async () => {
    const service = new CsvParsingService({} as Knex);

    const result = await service.parseFromStream(
      Readable.from(["primary-key\n"]),
      "permission-backing-dataset.csv",
    );

    expect(result.rowCount).toBe(0);
    expect(result.fileSizeBytes).toBe(Buffer.byteLength("primary-key\n"));
    expect(result.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.previewRows).toEqual([]);
    expect(result.columns).toEqual([
      expect.objectContaining({
        name: "primary-key",
        inferredType: "text",
        sampleValues: [],
      }),
    ]);
  });

  it("rejects an incomplete persisted record instead of silently dropping fields", async () => {
    const service = new CsvParsingService({} as Knex);

    await expect(
      service.parseFromStream(
        Readable.from(["transaction_id,transaction_date\nTXN-1,2024-01-01\nTXN-2\n"]),
        "financial-transactions.csv",
      ),
    ).rejects.toMatchObject({
      name: "DatasetCsvValidationError",
      code: "DATASET_CSV_VALIDATION_FAILED",
    });
  });

  it("accepts a complete rectangular CSV and records its persisted-object proof", async () => {
    const service = new CsvParsingService({} as Knex);
    const body = "transaction_id,transaction_date\nTXN-1,2024-01-01\nTXN-2,2024-01-02\n";

    const result = await service.parseFromStream(Readable.from([body]), "financial-transactions.csv");

    expect(result.rowCount).toBe(2);
    expect(result.fileSizeBytes).toBe(Buffer.byteLength(body));
    expect(result.contentHash).toBe(
      "sha256:d6e6fe599281a8d07433c2e2b00c5cb0d0f38eb4922f05c63c88ca020acae3e9",
    );
  });
});
