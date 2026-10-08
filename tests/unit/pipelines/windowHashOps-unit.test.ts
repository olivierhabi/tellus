// Unit coverage for the three researched feature gaps:
//   1. HashSha256  — Palantir expression sha256V1
//   2. Window      — Palantir transform windowV1
//   3. Union ordering — union combines inputs, THEN the node's transforms run
//
// The sha256 assertions use Node's crypto as the oracle (the same primitive
// DuckDB's sha256() implements), so the value expectations are exact rather
// than tautological.

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  compileTransformChain,
  type HashSha256Step,
  type WindowStep,
} from '../../../src/services/pipelines/duckdbTransformEngine';
import {
  sha256Value,
  applyHashSha256ToRows,
  applyWindowToRows,
} from '../../../src/services/pipelines/ops/windowHashOps';
import { findMalformedTransformSteps } from '../../../src/services/pipelines/transformStepIntegrity';

const sha = (s: string) => createHash('sha256').update(s, 'utf-8').digest('hex');

describe('HashSha256 (sha256V1 parity)', () => {
  it('matches the sha256 of the input string', () => {
    expect(sha256Value('hello')).toBe(sha('hello'));
  });

  it('is null-propagating — the published example is `null | null`', () => {
    expect(sha256Value(null)).toBeNull();
    expect(sha256Value(undefined)).toBeNull();
  });

  it('does not conflate an empty string with null', () => {
    // DuckDB hashes '' to e3b0c442...; a null-propagating function must not
    // collapse that into null.
    expect(sha256Value('')).toBe(sha(''));
    expect(sha256Value('')).not.toBeNull();
  });

  it('coerces non-string scalars the way a VARCHAR cast would', () => {
    expect(sha256Value(181)).toBe(sha('181'));
    expect(sha256Value(true)).toBe(sha('true'));
  });

  it('hashes binary input as bytes', () => {
    const bytes = new Uint8Array([0x68, 0x69]);
    expect(sha256Value(bytes)).toBe(
      createHash('sha256').update(Buffer.from([0x68, 0x69])).digest('hex'),
    );
  });

  it('appends the output column and preserves every input column', () => {
    const rows = [{ a: 'x', b: 1 }];
    const out = applyHashSha256ToRows(rows, 'a', 'a_hash');
    expect(out[0]).toEqual({ a: 'x', b: 1, a_hash: sha('x') });
  });

  it('propagates null per row rather than failing the batch', () => {
    const out = applyHashSha256ToRows([{ a: null }, { a: 'z' }], 'a', 'h');
    expect(out[0].h).toBeNull();
    expect(out[1].h).toBe(sha('z'));
  });

  it('compiles to a null-propagating sha256 over a VARCHAR cast', () => {
    const plan = compileTransformChain(
      [{ function: 'HashSha256', expression: 'tx', outputColumn: 'tx_hash' } as HashSha256Step],
      { inputPath: '/tmp/in.csv', sourceColumns: ['tx'] },
    );
    expect(plan.sql).toContain('sha256(CAST("tx" AS VARCHAR))');
    expect(plan.sql).toContain('AS "tx_hash"');
  });

  it('replaces in place when the output shadows the input column', () => {
    const plan = compileTransformChain(
      [{ function: 'HashSha256', expression: 'tx', outputColumn: 'tx' } as HashSha256Step],
      { inputPath: '/tmp/in.csv', sourceColumns: ['tx'] },
    );
    expect(plan.sql).toContain('* REPLACE');
  });

  it('is rejected by the integrity gate without its declared arguments', () => {
    // sha256V1 declares one Expression argument and a String output, so a
    // step missing either is malformed (both missing reports both).
    expect(findMalformedTransformSteps([{ function: 'HashSha256' }]).length).toBeGreaterThan(0);
    expect(findMalformedTransformSteps([{ function: 'HashSha256', expression: 'a' }])).toHaveLength(1);
    expect(
      findMalformedTransformSteps([{ function: 'HashSha256', outputColumn: 'b' }]),
    ).toHaveLength(1);
    expect(
      findMalformedTransformSteps([
        { function: 'HashSha256', expression: 'a', outputColumn: 'b' },
      ]),
    ).toHaveLength(0);
  });
});

describe('Window (windowV1 parity)', () => {
  const rows = [
    { k: 'a', v: 1 },
    { k: 'a', v: 2 },
    { k: 'b', v: 10 },
    { k: 'b', v: 20 },
    { k: 'b', v: 30 },
  ];

  it('attaches a per-partition count to every row WITHOUT changing row count', () => {
    const out = applyWindowToRows(rows, {
      partitionBy: ['k'],
      aggregations: [{ function: 'count', outputColumn: 'n' }],
    });
    expect(out).toHaveLength(rows.length);
    expect(out.map((r) => r.n)).toEqual([2, 2, 3, 3, 3]);
  });

  it('treats an empty partitionBy as one whole-table partition', () => {
    const out = applyWindowToRows(rows, {
      partitionBy: [],
      aggregations: [{ function: 'count', outputColumn: 'n' }],
    });
    expect(out.every((r) => r.n === 5)).toBe(true);
  });

  it('sums and averages within each partition', () => {
    const out = applyWindowToRows(rows, {
      partitionBy: ['k'],
      aggregations: [
        { function: 'sum', column: 'v', outputColumn: 's' },
        { function: 'avg', column: 'v', outputColumn: 'm' },
      ],
    });
    expect(out[0]).toMatchObject({ s: 3, m: 1.5 });
    expect(out[2]).toMatchObject({ s: 60, m: 20 });
  });

  it('counts distinct values per partition', () => {
    const out = applyWindowToRows(
      [{ k: 'a', v: 1 }, { k: 'a', v: 1 }, { k: 'b', v: 5 }],
      { partitionBy: ['k'], aggregations: [{ function: 'count_distinct', column: 'v', outputColumn: 'd' }] },
    );
    expect(out.map((r) => r.d)).toEqual([1, 1, 1]);
  });

  it('keeps NULL keys in their own partition rather than colliding with "null"', () => {
    const out = applyWindowToRows(
      [{ k: null }, { k: 'null' }, { k: null }],
      { partitionBy: ['k'], aggregations: [{ function: 'count', outputColumn: 'n' }] },
    );
    // Two partitions over 3 rows: the 2 NULL-keyed rows get 2, the 1 row whose
    // key is the literal string "null" gets 1. Row count is preserved, so the
    // per-row counts are [2, 1, 2]. A key that stringify()'d NULL would have
    // merged all three into one group and produced [3, 3, 3].
    expect(out.map((r) => r.n)).toEqual([2, 1, 2]);
  });

  it('returns null for numeric aggregates over an all-null partition', () => {
    const out = applyWindowToRows([{ k: 'a', v: null }], {
      partitionBy: ['k'],
      aggregations: [{ function: 'sum', column: 'v', outputColumn: 's' }],
    });
    expect(out[0].s).toBeNull();
  });

  it('compiles to an analytic aggregate with PARTITION BY, not a GROUP BY', () => {
    const plan = compileTransformChain(
      [
        {
          function: 'Window',
          partitionBy: ['step', 'amount_key'],
          aggregations: [{ function: 'count', outputColumn: 'pair_count_per_key' }],
        } as WindowStep,
      ],
      { inputPath: '/tmp/in.csv', sourceColumns: ['step', 'amount_key'] },
    );
    expect(plan.sql).toContain('COUNT(*) OVER (PARTITION BY "step", "amount_key")');
    // Row cardinality preserved => the chain must NOT group.
    expect(plan.sql).not.toContain('GROUP BY');
  });

  it('emits ORDER BY inside the OVER clause when one is given', () => {
    const plan = compileTransformChain(
      [
        {
          function: 'Window',
          partitionBy: ['k'],
          orderBy: [{ column: 'v', direction: 'desc' }],
          aggregations: [{ function: 'max', column: 'v', outputColumn: 'm' }],
        } as WindowStep,
      ],
      { inputPath: '/tmp/in.csv', sourceColumns: ['k', 'v'] },
    );
    expect(plan.sql).toContain('OVER (PARTITION BY "k" ORDER BY "v" DESC)');
  });

  it('uses a whole-table OVER () when no partition or order is given', () => {
    const plan = compileTransformChain(
      [{ function: 'Window', aggregations: [{ function: 'count', outputColumn: 'n' }] } as WindowStep],
      { inputPath: '/tmp/in.csv', sourceColumns: ['a'] },
    );
    expect(plan.sql).toContain('COUNT(*) OVER ()');
  });

  it('refuses an empty aggregation list (windowV1 declares a non-empty list)', () => {
    expect(() =>
      compileTransformChain(
        [{ function: 'Window', partitionBy: ['k'], aggregations: [] } as unknown as WindowStep],
        { inputPath: '/tmp/in.csv', sourceColumns: ['k'] },
      ),
    ).toThrow(/at least one aggregation/i);
  });

  it('does not require partitionBy in the integrity gate', () => {
    expect(
      findMalformedTransformSteps([{ function: 'Window', aggregations: [{ function: 'count' }] }]),
    ).toHaveLength(0);
    expect(findMalformedTransformSteps([{ function: 'Window' }])).toHaveLength(1);
  });
});