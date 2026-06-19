import { describe, it, expect } from 'vitest';
import {
  canonicalizeColumnName,
  findNearNameMatches,
} from '../../../src/utils/columnNameReconciler';

describe('canonicalizeColumnName', () => {
  it.each([
    ['order_id', 'orderid'],
    ['OrderId', 'orderid'],
    ['orderId', 'orderid'],
    ['Order ID', 'orderid'],
    ['order-id', 'orderid'],
    ['ORDER__ID', 'orderid'],
    ['customer_name_v2', 'customernamev2'],
    ['', ''],
    ['___', ''],
  ])('canonicalizes %j → %j', (input, expected) => {
    expect(canonicalizeColumnName(input)).toBe(expected);
  });

  it('is idempotent', () => {
    const once = canonicalizeColumnName('Order_ID');
    const twice = canonicalizeColumnName(once);
    expect(twice).toBe(once);
  });
});

describe('findNearNameMatches', () => {
  it('returns [] when either side is empty', () => {
    expect(findNearNameMatches([], ['order_id'])).toEqual([]);
    expect(findNearNameMatches(['order_id'], [])).toEqual([]);
    expect(findNearNameMatches([], [])).toEqual([]);
  });

  it('detects the production-reported pair (`orderid` ↔ `order_id`) with high confidence', () => {
    const out = findNearNameMatches(['orderid'], ['order_id']);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      left: 'orderid',
      right: 'order_id',
      similarity: 1.0,
      reason: 'canonical-equal',
      confidence: 'high',
    });
  });

  it('detects camelCase ↔ snake_case canonical pairs', () => {
    const out = findNearNameMatches(['customerName'], ['customer_name']);
    expect(out[0]).toMatchObject({ confidence: 'high', reason: 'canonical-equal' });
  });

  it('detects edit-distance pairs (`order_id` ↔ `orders_id`) with medium confidence', () => {
    const out = findNearNameMatches(['order_id'], ['orders_id']);
    expect(out).toHaveLength(1);
    expect(out[0].reason).toBe('edit-distance');
    expect(out[0].confidence).toBe('medium');
    expect(out[0].similarity).toBeGreaterThanOrEqual(0.8);
  });

  it('does not match unrelated names', () => {
    const out = findNearNameMatches(['order_id'], ['quantity']);
    expect(out).toEqual([]);
  });

  it('assigns each column to at most one suggestion (greedy best-first)', () => {
    const out = findNearNameMatches(
      ['order_id'],
      ['orderid', 'order_id_v2', 'order_idx'],
    );
    // Canonical match `orderid` wins over the edit-distance candidates.
    expect(out).toHaveLength(1);
    expect(out[0].right).toBe('orderid');
    expect(out[0].confidence).toBe('high');
  });

  it('skips names that canonicalize to empty', () => {
    const out = findNearNameMatches(['___'], ['---']);
    expect(out).toEqual([]);
  });

  it('returns deterministic output for repeated runs', () => {
    const a = findNearNameMatches(['orderid', 'qty'], ['order_id', 'quantity']);
    const b = findNearNameMatches(['orderid', 'qty'], ['order_id', 'quantity']);
    expect(a).toEqual(b);
  });

  it('rejects edit-distance matches below the 0.8 similarity threshold', () => {
    // "id" vs "name" — < 80% similar after canonicalization.
    const out = findNearNameMatches(['id'], ['name']);
    expect(out).toEqual([]);
  });

  it('handles the user-reported 11+11→12 scenario end-to-end', () => {
    // Two 11-column inputs identical except for `order_id` ↔ `orderid`
    const leftOnly = ['orderid'];
    const rightOnly = ['order_id'];
    const out = findNearNameMatches(leftOnly, rightOnly);
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBe('high');
  });
});
