// Quiver B9 — Property-value hint generator.
// Per spec §B9 + B9 C-08: top-N distinct values capped at 50; numeric sample
// capped at 1000. Bounded sample size enforced; emit metric on each call.

export const PROPERTY_HINT_TOP_N_CAP = 50;
export const PROPERTY_HINT_NUMERIC_SAMPLE_CAP = 1000;

export interface StringHint {
  readonly kind: "string";
  readonly topValues: ReadonlyArray<{ value: string; count: number }>;
  readonly truncated: boolean;
}

export interface NumericHint {
  readonly kind: "numeric";
  readonly min: number;
  readonly max: number;
  readonly q25: number;
  readonly q50: number;
  readonly q75: number;
  readonly sampleSize: number;
}

export type PropertyHint = StringHint | NumericHint;

export function summarizeStringProperty(
  values: ReadonlyArray<string>,
  topN = PROPERTY_HINT_TOP_N_CAP,
): StringHint {
  const cap = Math.min(topN, PROPERTY_HINT_TOP_N_CAP);
  const counts = new Map<string, number>();
  for (const v of values) {
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  const top = sorted.slice(0, cap).map(([value, count]) => ({ value, count }));
  return {
    kind: "string",
    topValues: top,
    truncated: sorted.length > cap,
  };
}

export function summarizeNumericProperty(
  values: ReadonlyArray<number>,
): NumericHint {
  if (values.length === 0) {
    throw new Error("summarizeNumericProperty: empty input");
  }
  const cap = Math.min(values.length, PROPERTY_HINT_NUMERIC_SAMPLE_CAP);
  // Deterministic stride sample (no randomness — keeps results reproducible).
  const sampled: number[] = [];
  if (values.length <= cap) {
    sampled.push(...values);
  } else {
    const stride = values.length / cap;
    for (let i = 0; i < cap; i++) {
      sampled.push(values[Math.floor(i * stride)]);
    }
  }
  const sorted = [...sampled].sort((a, b) => a - b);
  const q = (p: number): number => {
    const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
    return sorted[idx];
  };
  return {
    kind: "numeric",
    min: sorted[0],
    max: sorted[sorted.length - 1],
    q25: q(0.25),
    q50: q(0.5),
    q75: q(0.75),
    sampleSize: sorted.length,
  };
}
