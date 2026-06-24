/**
 * columnNameReconciler — detect plausible same-column-renamed pairs between
 * two CSV/dataset schemas.
 *
 * Used by the pipeline-builder Union node to surface "Did you mean to align
 * these?" hints when one side has been renamed (e.g. `order_id` → `orderid`,
 * `customerName` → `customer_name`). Without this layer, Union by name
 * silently widens the output schema by every non-matching name on either
 * side, which is the bug behind the "12 columns from two 11-column inputs"
 * report.
 *
 * Detection runs in two passes:
 *   1) **Canonical equality** — strip everything but [a-z0-9] after lowercasing.
 *      This collapses `order_id`, `OrderId`, `orderId`, `Order ID`, `order-id`
 *      to the same canonical key `orderid`. Canonical matches are reported
 *      with `confidence: 'high'` (similarity = 1.0).
 *   2) **Bounded Levenshtein** on remaining residuals — uses the existing
 *      `levenshteinDistance` helper. We accept pairs with normalized edit
 *      distance ≤ 0.2 (i.e. >= 80% similar) AND raw distance ≤ 3. Reported
 *      with `confidence: 'medium'` and the computed similarity score.
 *
 * The function is pure, allocation-bounded (O(L*R) for the residual pass,
 * where L and R are the small left-only / right-only sets — not the full
 * column counts), and has no side effects.
 */

import { levenshteinDistance } from '../services/mappingSuggestionService';

export interface NearNameSuggestion {
  /** Column on the left side. */
  left: string;
  /** Column on the right side. */
  right: string;
  /** 0.0 .. 1.0 — 1.0 = canonical-equal, lower = edit-distance match. */
  similarity: number;
  /** Why the matcher fired. Useful for telemetry and UI copy. */
  reason: 'canonical-equal' | 'edit-distance';
  /** Coarse-grained category for the UI. */
  confidence: 'high' | 'medium';
}

/**
 * Canonicalize a column name to its loosest comparable form.
 * Idempotent. Pure. No-op for already-canonical names.
 */
export function canonicalizeColumnName(name: string): string {
  return (name ?? '').toString().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Find plausible same-column-renamed pairs between two column-name sets.
 *
 * @param leftOnly  Column names present on the left but not the right.
 * @param rightOnly Column names present on the right but not the left.
 * @returns Suggested pairs, sorted by descending confidence then similarity.
 *
 * Guarantees:
 *   - Each left name appears in at most one suggestion (greedy by best match).
 *   - Each right name appears in at most one suggestion.
 *   - Empty input → empty output.
 *   - Names that canonicalize to the empty string (e.g. `""`, `"___"`) are
 *     skipped to avoid degenerate false positives.
 */
export function findNearNameMatches(
  leftOnly: readonly string[],
  rightOnly: readonly string[],
): NearNameSuggestion[] {
  if (leftOnly.length === 0 || rightOnly.length === 0) return [];

  const suggestions: NearNameSuggestion[] = [];
  const consumedLeft = new Set<string>();
  const consumedRight = new Set<string>();

  // ── Pass 1: canonical equality ─────────────────────────────────
  const leftCanon = new Map<string, string>(); // canonical → original
  for (const name of leftOnly) {
    const c = canonicalizeColumnName(name);
    if (c.length === 0) continue;
    // First write wins — keeps output deterministic for left side.
    if (!leftCanon.has(c)) leftCanon.set(c, name);
  }
  for (const right of rightOnly) {
    const c = canonicalizeColumnName(right);
    if (c.length === 0) continue;
    const left = leftCanon.get(c);
    if (left !== undefined && !consumedLeft.has(left) && !consumedRight.has(right)) {
      suggestions.push({
        left,
        right,
        similarity: 1.0,
        reason: 'canonical-equal',
        confidence: 'high',
      });
      consumedLeft.add(left);
      consumedRight.add(right);
    }
  }

  // ── Pass 2: bounded Levenshtein on residuals ───────────────────
  const residualLeft = leftOnly.filter((n) => !consumedLeft.has(n));
  const residualRight = rightOnly.filter((n) => !consumedRight.has(n));

  if (residualLeft.length === 0 || residualRight.length === 0) {
    return suggestions;
  }

  type Candidate = { left: string; right: string; similarity: number; distance: number };
  const candidates: Candidate[] = [];

  for (const l of residualLeft) {
    const lc = canonicalizeColumnName(l);
    if (lc.length === 0) continue;
    for (const r of residualRight) {
      const rc = canonicalizeColumnName(r);
      if (rc.length === 0) continue;
      const dist = levenshteinDistance(lc, rc);
      const maxLen = Math.max(lc.length, rc.length);
      if (maxLen === 0) continue;
      const similarity = 1 - dist / maxLen;
      // Tight thresholds — only fire when we're confident enough to
      // be useful without being noisy.
      if (similarity >= 0.8 && dist <= 3) {
        candidates.push({ left: l, right: r, similarity, distance: dist });
      }
    }
  }

  // Greedy best-first assignment so each name participates in at most one pair.
  candidates.sort((a, b) =>
    b.similarity - a.similarity || a.distance - b.distance || a.left.localeCompare(b.left),
  );

  for (const c of candidates) {
    if (consumedLeft.has(c.left) || consumedRight.has(c.right)) continue;
    suggestions.push({
      left: c.left,
      right: c.right,
      similarity: Number(c.similarity.toFixed(3)),
      reason: 'edit-distance',
      confidence: 'medium',
    });
    consumedLeft.add(c.left);
    consumedRight.add(c.right);
  }

  return suggestions;
}
