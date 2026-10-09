// The auto-trigger scan must not COUNT(*) object_instances for every object
// type each tick (57014 statement timeouts on a 6.35M-row type), must ignore
// emissions without a base snapshot (full-snapshot row counts read as 100%),
// and must evaluate each emission once.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock, beginMock } = vi.hoisted(() => ({ queryMock: vi.fn(), beginMock: vi.fn() }));
vi.mock("../../../src/db", () => ({ query: queryMock }));
vi.mock("../../../src/services/quickwit/replacement/soakMonitor", () => ({ evaluateSoak: vi.fn() }));
vi.mock("../../../src/services/quickwit/replacement/versionManager", () => ({
  beginReplacementBackfill: beginMock,
  cutover: vi.fn(),
  finalizeCutover: vi.fn(),
  getActiveVersion: vi.fn(),
}));

import { resetAutoTriggerStateForTesting, tick } from "../../../src/services/funnel/replacementScheduler";

let candidates: Array<Record<string, unknown>> = [];
let total = 0;
const sqls: string[] = [];

beforeEach(() => {
  resetAutoTriggerStateForTesting();
  queryMock.mockReset();
  beginMock.mockReset().mockResolvedValue({});
  sqls.length = 0;
  queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
    sqls.push(sql);
    if (sql.includes("pg_catalog.pg_tables")) {
      return { rows: (params![0] as string[]).map((tablename) => ({ tablename })) };
    }
    if (sql.includes("funnel_changelog_watermark")) return { rows: candidates };
    if (sql.includes("FROM object_instances")) return { rows: [{ n: Math.min(total, Number(params![2])) }] };
    return { rows: [] };
  });
});

const row = (rows: number, runAt = "2026-10-09 16:40:00+00") => ({
  object_type_api_name: "Paysim", ontology_id: "o1", rows_changed: rows, last_run_at: runAt, state: "LIVE",
});

describe("replacement scheduler auto-trigger", () => {
  it("candidate scan has no per-type count and filters base-less / already-handled emissions", async () => {
    candidates = [];
    await tick();
    const scan = sqls.find((s) => s.includes("funnel_changelog_watermark"))!;
    expect(scan).not.toMatch(/COUNT\(\*\)/i);
    expect(scan).toContain("last_from_snapshot_id IS NOT NULL");
    expect(scan).toContain("backfill_started_at < w.last_run_at");
    expect(sqls.some((s) => s.includes("FROM object_instances"))).toBe(false);
  });

  it("triggers above 80% with a capped count", async () => {
    candidates = [row(900)];
    total = 1000;
    expect((await tick()).autoTriggered).toBe(1);
    expect(beginMock).toHaveBeenCalledWith("Paysim");
    const countCall = queryMock.mock.calls.find(([s]) => String(s).includes("FROM object_instances"))!;
    expect(countCall[1]).toEqual(["o1", "Paysim", 1126]);
  });

  it("does not trigger at or below 80%, and counts each emission once", async () => {
    candidates = [row(100)];
    total = 1000;
    expect((await tick()).autoTriggered).toBe(0);
    await tick();
    expect(sqls.filter((s) => s.includes("FROM object_instances"))).toHaveLength(1);
    candidates = [row(100, "2026-10-09 17:00:00+00")];
    await tick();
    expect(sqls.filter((s) => s.includes("FROM object_instances"))).toHaveLength(2);
    expect(beginMock).not.toHaveBeenCalled();
  });
});
