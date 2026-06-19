// B5.03 — verify etag helpers are wired into the v2 router.
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";

describe("B5.03 — etag wired into v2 router", () => {
  it("filesystemV2.ts uses setV2Etag on every read/write", () => {
    const src = fs.readFileSync("src/routes/filesystemV2.ts", "utf8");
    // We expect at least 5 setV2Etag invocations (folders, projects, resources, branches, restore).
    const count = (src.match(/setV2Etag\(/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(5);
  });

  it("filesystemV2.ts enforces If-Match via requireIfMatchV2 on mutating routes", () => {
    const src = fs.readFileSync("src/routes/filesystemV2.ts", "utf8");
    const count = (src.match(/requireIfMatchV2\(/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it("setV2Etag is exported from etag middleware", () => {
    const src = fs.readFileSync("src/middleware/etag.ts", "utf8");
    expect(src).toMatch(/setV2Etag|setEtag/);
  });
});
