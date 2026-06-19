// B7.09 — verify branchesV2 router file + wiring exist.
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";

describe("B7.09 — branchesV2 router wired", () => {
  it("server.ts mounts /api/v2/compass", () => {
    const src = fs.readFileSync("src/server.ts", "utf8");
    expect(src).toMatch(/app\.use\("\/api\/v2\/compass", branchesV2Router\)/);
  });
  it("router has POST /projects/:rid/branches", () => {
    const src = fs.readFileSync("src/routes/branchesV2.ts", "utf8");
    expect(src).toMatch(/router\.post\("\/projects\/:rid\/branches"/);
  });
  it("router has POST /branches/:id/proposals", () => {
    const src = fs.readFileSync("src/routes/branchesV2.ts", "utf8");
    expect(src).toMatch(/router\.post\("\/branches\/:id\/proposals"/);
  });
  it("router has POST /proposals/:id/approve", () => {
    const src = fs.readFileSync("src/routes/branchesV2.ts", "utf8");
    expect(src).toMatch(/router\.post\("\/proposals\/:id\/approve"/);
  });
  it("router has POST /branches/:id/merge", () => {
    const src = fs.readFileSync("src/routes/branchesV2.ts", "utf8");
    expect(src).toMatch(/router\.post\("\/branches\/:id\/merge"/);
  });
});
