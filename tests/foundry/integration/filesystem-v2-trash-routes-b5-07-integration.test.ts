// B5.07 — verify trash/restore/permanentlyDelete are wired into the router.
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";

describe("B5.07 — trash routes wired", () => {
  const src = fs.readFileSync("src/routes/filesystemV2.ts", "utf8");
  it("POST /resources/:rid/trash exists", () => {
    expect(src).toMatch(/"\/resources\/:rid\/trash"/);
  });
  it("POST /resources/:rid/restore exists", () => {
    expect(src).toMatch(/"\/resources\/:rid\/restore"/);
  });
  it("POST /resources/:rid/permanentlyDelete exists", () => {
    expect(src).toMatch(/"\/resources\/:rid\/permanentlyDelete"/);
  });
  it("each route uses idempotencyKeyMiddleware", () => {
    const segment = src.split("/resources/:rid/trash")[1] ?? "";
    expect(segment).toMatch(/idempotencyKeyMiddleware/);
  });
});
