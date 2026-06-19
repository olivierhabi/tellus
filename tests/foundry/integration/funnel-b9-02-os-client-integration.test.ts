import { describe, expect, it } from "vitest";
import * as fs from "node:fs";

describe("B9.02 — OpenSearch client + index template", () => {
  it("client.ts exists", () => {
    expect(fs.existsSync("src/services/opensearch/client.ts")).toBe(true);
  });
  it("ensureIndexTemplate is exported from templateRegistry", () => {
    const src = fs.readFileSync("src/services/opensearch/templateRegistry.ts", "utf8");
    expect(src).toMatch(/export +(?:async +)?function ensureIndexTemplate/);
  });
  it("server.ts calls ensureIndexTemplate at startup", () => {
    const src = fs.readFileSync("src/server.ts", "utf8");
    expect(src).toMatch(/ensureIndexTemplate/);
  });
  it("bulkIndexer.ts exists for B9.05 indexer phase", () => {
    expect(fs.existsSync("src/services/opensearch/bulkIndexer.ts")).toBe(true);
  });
});
