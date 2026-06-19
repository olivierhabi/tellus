// B6.07 — verify graph router file + wiring exist.
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";

describe("B6.07 — resourceGraphV2 wired into server", () => {
  it("server.ts mounts /api/v2/graph", () => {
    const src = fs.readFileSync("src/server.ts", "utf8");
    expect(src).toMatch(/app\.use\("\/api\/v2\/graph", resourceGraphV2Router\)/);
  });
  it("router has POST /resources/:rid/dependencies", () => {
    const src = fs.readFileSync("src/routes/resourceGraphV2.ts", "utf8");
    expect(src).toMatch(/router\.post\("\/resources\/:rid\/dependencies"/);
  });
  it("router has GET /resources/:rid/lineage", () => {
    const src = fs.readFileSync("src/routes/resourceGraphV2.ts", "utf8");
    expect(src).toMatch(/router\.get\("\/resources\/:rid\/lineage"/);
  });
  it("router has POST /projects/:rid/references", () => {
    const src = fs.readFileSync("src/routes/resourceGraphV2.ts", "utf8");
    expect(src).toMatch(/router\.post\("\/projects\/:rid\/references"/);
  });
});
