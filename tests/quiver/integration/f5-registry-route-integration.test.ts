/**
 * F5 — Card Type Registry endpoint contract surface (BE-side).
 *
 * F5 is FE-only per D-23, but the registry the FE relies on for build-time
 * plugin coverage (F5 C-08) MUST be exposed as a BE endpoint so the FE can
 * consume the canonical registry rather than duplicate it.
 *
 * Covers:
 *   F5 C-02 (registry exposes all 26 card types — assertion against
 *           tasks/quiver/registry-fixture.md is the build-time check)
 *   F5 C-08 (build-time plugin coverage check via this endpoint)
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { pool } from "../../../src/db";
import { applyQuiverMigrations, quiverApp } from "./_harness";

beforeAll(async () => {
  process.env.QUIVER_ALLOW_TEST_AUTH = "1";
  process.env.TELLUS_QUIVER_PHASE = "5";
  await applyQuiverMigrations();
});

afterAll(async () => {
  await pool.end();
});

describe("F5 — GET /quiver/api/v1/registry/cards", () => {
  it("F5 C-02: returns exactly 26 card types", async () => {
    const r = await request(quiverApp()).get("/quiver/api/v1/registry/cards");
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(26);
    expect(Array.isArray(r.body.cards)).toBe(true);
    expect(r.body.cards.length).toBe(26);
  });

  it("F5 C-08: every entry exposes the contract fields needed by the FE plugin loader", async () => {
    const r = await request(quiverApp()).get("/quiver/api/v1/registry/cards");
    expect(r.status).toBe(200);
    for (const c of r.body.cards) {
      expect(typeof c.type).toBe("string");
      expect(c.type.length).toBeGreaterThan(0);
      expect(typeof c.inputs).toBe("object");
      expect(typeof c.output).toBe("string");
    }
  });

  it("F5 C-02: is cacheable (Cache-Control + ETag emitted)", async () => {
    const r = await request(quiverApp()).get("/quiver/api/v1/registry/cards");
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toMatch(/max-age=\d+/);
    expect(r.headers["etag"]).toMatch(/^W\//);
  });

  it("F5 C-02: registry is stable across calls (no per-request mutation)", async () => {
    const r1 = await request(quiverApp()).get("/quiver/api/v1/registry/cards");
    const r2 = await request(quiverApp()).get("/quiver/api/v1/registry/cards");
    expect(r1.headers["etag"]).toBe(r2.headers["etag"]);
    expect(r1.body).toEqual(r2.body);
  });

  it("F5 C-02: every entry has a slot accept-types array of valid SlotType strings", async () => {
    const r = await request(quiverApp()).get("/quiver/api/v1/registry/cards");
    for (const c of r.body.cards) {
      for (const [slot, decl] of Object.entries<any>(c.inputs)) {
        expect(typeof slot).toBe("string");
        expect(Array.isArray(decl.accepts)).toBe(true);
        for (const t of decl.accepts) expect(typeof t).toBe("string");
        expect(typeof decl.optional).toBe("boolean");
        expect(typeof decl.list).toBe("boolean");
      }
    }
  });
});
