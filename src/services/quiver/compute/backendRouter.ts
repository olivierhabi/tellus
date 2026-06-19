/**
 * B5 — Backend router with per-backend circuit breaker.
 *
 * Maps a `cardType` (registry symbol) to a `CardBackend`. Backend names are
 * a bounded set (g-09): OSS | MMDP | POLARS | CODEX | FUNCTIONS | AIP_LOGIC.
 */

import { getCardType, listCardTypes } from '../dag/cardTypeRegistry';
import { CircuitBreaker, CircuitOpenError } from './circuitBreaker';
import type { CardBackend, BackendExecuteInput, BackendExecuteOutput } from './types';
import { OssLimitExceededError, ActionApplyForbiddenError } from './oss/ossPort';

export type BackendName =
  | 'OSS'
  | 'MMDP'
  | 'POLARS'
  | 'CODEX'
  | 'FUNCTIONS'
  | 'AIP_LOGIC'
  | 'INLINE'; // for parameter cards / boolean formula / etc.

export class NoBackendForCardTypeError extends Error {
  readonly code = 'NO_BACKEND_FOR_CARD_TYPE';
  constructor(public readonly cardType: string) {
    super(`no backend registered for cardType=${cardType}`);
    this.name = 'NoBackendForCardTypeError';
  }
}

export class BackendRouter {
  private readonly registry = new Map<string, CardBackend>();
  private readonly breakers = new Map<string, CircuitBreaker>();

  register(backend: CardBackend): void {
    if (!getCardType(backend.cardType as any)) {
      throw new Error(`backend ${backend.backendName} declares unknown cardType=${backend.cardType}`);
    }
    this.registry.set(backend.cardType, backend);
    if (!this.breakers.has(backend.backendName)) {
      this.breakers.set(backend.backendName, new CircuitBreaker(backend.backendName));
    }
  }

  has(cardType: string): boolean {
    return this.registry.has(cardType);
  }

  list(): ReadonlyArray<{ cardType: string; backendName: string; circuit: string }> {
    return Array.from(this.registry.values()).map((b) => ({
      cardType: b.cardType,
      backendName: b.backendName,
      circuit: this.breakers.get(b.backendName)!.getState(),
    }));
  }

  getCircuit(name: BackendName): CircuitBreaker | undefined {
    return this.breakers.get(name);
  }

  /**
   * Resolve + dispatch through the per-backend circuit breaker.
   * Throws CircuitOpenError if the breaker is open & still cooling.
   */
  async dispatch(cardType: string, input: BackendExecuteInput): Promise<BackendExecuteOutput> {
    const backend = this.registry.get(cardType);
    if (!backend) throw new NoBackendForCardTypeError(cardType);
    const breaker = this.breakers.get(backend.backendName)!;
    breaker.guard();
    try {
      const out = await backend.execute(input);
      breaker.recordSuccess();
      return out;
    } catch (err) {
      // Don't count CircuitOpenError as a backend failure (it never reached the backend).
      // Don't count client validation errors as backend failures — they don't indicate
      // infrastructure issues. Counting them would allow attackers to trip the circuit
      // with malformed requests, causing a DoS for all users.
      const isClientError = err instanceof OssLimitExceededError || err instanceof ActionApplyForbiddenError;
      if (!(err instanceof CircuitOpenError) && !isClientError) {
        breaker.recordFailure();
      }
      throw err;
    }
  }
}

/**
 * Build a router with the v1 default backend set. B6/B7/B8/B9 will swap in
 * real backends; this iteration registers stub backends so end-to-end
 * compute tests can run before those iterations land.
 */
export function buildDefaultRouter(stubs: ReadonlyArray<CardBackend>): BackendRouter {
  const router = new BackendRouter();
  for (const s of stubs) router.register(s);
  // Ensure every known card type has a backend registered (B5 C-03 — defensive)
  // This is *not* enforced — production registers per-phase as backends ship.
  void listCardTypes;
  return router;
}
