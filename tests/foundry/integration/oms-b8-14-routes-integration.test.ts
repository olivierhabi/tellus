import { describe, expect, it } from "vitest";
import * as fs from "node:fs";

describe("B8.14 — omsV2 router wired", () => {
  const src = fs.readFileSync("src/server.ts", "utf8");
  const r = fs.readFileSync("src/routes/omsV2.ts", "utf8");
  it("server mounts /api/v2/oms", () => {
    expect(src).toMatch(/app\.use\("\/api\/v2\/oms", omsV2Router\)/);
  });
  it("POST /ontologies/:ontologyRid/object-types", () => {
    expect(r).toMatch(/router\.post\("\/ontologies\/:ontologyRid\/object-types"/);
  });
  it("GET /ontologies/:ontologyRid/object-types", () => {
    expect(r).toMatch(/router\.get\("\/ontologies\/:ontologyRid\/object-types"/);
  });
  it("PATCH /object-types/:rid", () => {
    expect(r).toMatch(/router\.patch\("\/object-types\/:rid"/);
  });
  it("POST /ontologies/:ontologyRid/link-types", () => {
    expect(r).toMatch(/router\.post\("\/ontologies\/:ontologyRid\/link-types"/);
  });
  it("POST /ontologies/:ontologyRid/shared-property-types", () => {
    expect(r).toMatch(/router\.post\("\/ontologies\/:ontologyRid\/shared-property-types"/);
  });
  it("POST /ontologies/:ontologyRid/interfaces", () => {
    expect(r).toMatch(/router\.post\("\/ontologies\/:ontologyRid\/interfaces"/);
  });
});
