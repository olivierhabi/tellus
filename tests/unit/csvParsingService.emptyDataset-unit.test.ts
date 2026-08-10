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
    expect(result.previewRows).toEqual([]);
    expect(result.columns).toEqual([
      expect.objectContaining({
        name: "primary-key",
        inferredType: "text",
        sampleValues: [],
      }),
    ]);
  });
});
