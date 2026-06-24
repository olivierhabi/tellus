/**
 * B5 — Cache key + config hash derivation.
 *
 * Per B5 C-04 / C-05:
 *   configHash = SHA256(canonicalJson(card.config) +
 *                       canonicalJson(parameterOverrides intersected with
 *                                     card's parameter dependencies))
 *   cacheKey   = SHA256(cardId || configHash || sortedUpstreamHashes ||
 *                       branch || ontologyVersionForBranch)
 *
 * sortedUpstreamHashes are sorted lexicographically before hashing so the
 * key is stable under reordering of the input upstream array.
 */

import { createHash } from 'node:crypto';

/** RFC 8785-style canonical JSON: sorted keys, no spaces, deterministic. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number in canonicalJson');
    return Number.isInteger(value) ? value.toString() : value.toString();
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const v = (value as Record<string, unknown>)[k];
      if (v === undefined) continue;
      parts.push(JSON.stringify(k) + ':' + canonicalJson(v));
    }
    return '{' + parts.join(',') + '}';
  }
  throw new Error(`unsupported type in canonicalJson: ${typeof value}`);
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export interface ConfigHashInput {
  config: unknown;
  parameterOverrides: Record<string, unknown>;
  parameterDependencies: ReadonlyArray<string>; // CardIds this card depends on (parameter cards)
}

/**
 * configHash per B5 C-05.
 * `parameterOverrides ∩ card's parameter dependencies` means: only the keys
 * in parameterOverrides whose CardId is listed in parameterDependencies.
 * Unused overrides MUST NOT affect the hash.
 */
export function computeConfigHash(input: ConfigHashInput): string {
  const intersected: Record<string, unknown> = {};
  for (const dep of input.parameterDependencies) {
    if (Object.prototype.hasOwnProperty.call(input.parameterOverrides, dep)) {
      intersected[dep] = input.parameterOverrides[dep];
    }
  }
  return sha256Hex(canonicalJson(input.config) + canonicalJson(intersected));
}

export interface CacheKeyInput {
  cardId: string;
  configHash: string;
  upstreamHashes: ReadonlyArray<string>;
  branch: string;
  ontologyVersionForBranch: string;
}

/**
 * cacheKey per B5 C-04.
 * Stable under reordering of upstreamHashes (sorted before hashing).
 */
export function computeCacheKey(input: CacheKeyInput): string {
  const sorted = [...input.upstreamHashes].sort();
  const payload =
    input.cardId +
    '|' +
    input.configHash +
    '|' +
    sorted.join(',') +
    '|' +
    input.branch +
    '|' +
    input.ontologyVersionForBranch;
  return sha256Hex(payload);
}
