import { createHash } from "node:crypto";
import { query } from "../../db";
import {
  incCounter,
  observeHistogram,
  setGauge,
} from "../funnel/metrics";
import { ObjectSetExecutionError } from "./objectSetExecutor";

export interface EmbeddingRequest {
  tenantId: string;
  modelId: string;
  text: string;
  dimensions: number;
  timeoutMs: number;
  credential?: string;
  endpoint?: string;
}

export interface EmbeddingProvider {
  readonly name: string;
  embed(request: EmbeddingRequest): Promise<number[]>;
}

export interface EmbeddingConfig {
  provider: string;
  modelId: string;
  dimensions: number;
  endpoint: string | null;
  credentialEnv: string | null;
  timeoutMs: number;
  maxRetries: number;
  requestsPerSecond: number;
}

export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  readonly name = "deterministic";

  async embed(request: EmbeddingRequest): Promise<number[]> {
    const seed = createHash("sha256")
      .update(`${request.modelId}\0${request.text}`)
      .digest();
    const vector: number[] = [];
    for (let i = 0; i < request.dimensions; i++) {
      const byte = seed[i % seed.length]!;
      vector.push((byte - 127.5) / 127.5);
    }
    return vector;
  }
}

export class HttpEmbeddingProvider implements EmbeddingProvider {
  readonly name = "http";

  async embed(request: EmbeddingRequest): Promise<number[]> {
    if (!request.endpoint) {
      throw new Error("embedding endpoint is missing");
    }
    const response = await fetch(request.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(request.credential
          ? { authorization: `Bearer ${request.credential}` }
          : {}),
      },
      body: JSON.stringify({
        model: request.modelId,
        input: request.text,
        dimensions: request.dimensions,
      }),
      signal: AbortSignal.timeout(request.timeoutMs),
    });
    if (response.status === 429) {
      throw Object.assign(new Error("embedding provider rate limited"), {
        retryable: true,
        rateLimited: true,
      });
    }
    if (!response.ok) {
      throw Object.assign(
        new Error(`embedding provider returned HTTP ${response.status}`),
        { retryable: response.status >= 500 },
      );
    }
    const body = (await response.json()) as {
      embedding?: number[];
      data?: Array<{ embedding?: number[] }>;
    };
    const embedding = body.embedding ?? body.data?.[0]?.embedding;
    if (!Array.isArray(embedding)) {
      throw new Error("embedding provider returned no embedding");
    }
    return embedding;
  }
}

const providers = new Map<string, EmbeddingProvider>([
  ["deterministic", new DeterministicEmbeddingProvider()],
  ["http", new HttpEmbeddingProvider()],
]);

export function registerEmbeddingProvider(provider: EmbeddingProvider): void {
  providers.set(provider.name, provider);
}

interface BreakerState {
  failures: number;
  openUntil: number;
}

const breakers = new Map<string, BreakerState>();
const rateWindows = new Map<string, number[]>();

async function withProviderTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(
        Object.assign(new Error("embedding provider timed out"), {
          name: "TimeoutError",
          retryable: true,
        }),
      );
    }, timeoutMs);
    timeout.unref?.();
  });
  try {
    return await Promise.race([operation, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function assertRateLimit(key: string, requestsPerSecond: number): void {
  const now = Date.now();
  const current = (rateWindows.get(key) ?? []).filter(
    (timestamp) => timestamp > now - 1000,
  );
  if (current.length >= requestsPerSecond) {
    throw new ObjectSetExecutionError(
      "EmbeddingProviderRateLimited",
      "The configured embedding provider rate limit was exceeded.",
      { retryAfterMs: Math.max(1, current[0]! + 1000 - now) },
      429,
    );
  }
  current.push(now);
  rateWindows.set(key, current);
}

export async function getEmbeddingConfig(input: {
  tenantId: string;
  ontologyId: string;
  objectType: string;
  property: string;
}): Promise<EmbeddingConfig> {
  const result = await query(
    `SELECT provider, model_id, dimensions, endpoint, credential_env,
            timeout_ms, max_retries, requests_per_second
       FROM ontology_embedding_config
      WHERE tenant_id = $1 AND ontology_id = $2
        AND object_type_api_name = $3 AND property_api_name = $4
        AND enabled = true`,
    [input.tenantId, input.ontologyId, input.objectType, input.property],
  );
  if (result.rows.length === 0) {
    throw new ObjectSetExecutionError(
      "NearestNeighborsTextNotConfigured",
      "No embedding model is configured for the vector property.",
      { objectType: input.objectType, property: input.property },
      400,
    );
  }
  const row = result.rows[0];
  return {
    provider: row.provider,
    modelId: row.model_id,
    dimensions: Number(row.dimensions),
    endpoint: row.endpoint,
    credentialEnv: row.credential_env,
    timeoutMs: Number(row.timeout_ms),
    maxRetries: Number(row.max_retries),
    requestsPerSecond: Number(row.requests_per_second),
  };
}

export async function embedTextForProperty(input: {
  tenantId: string;
  ontologyId: string;
  objectType: string;
  property: string;
  text: string;
}): Promise<number[]> {
  const config = await getEmbeddingConfig(input);
  const provider = providers.get(config.provider);
  if (!provider) {
    throw new ObjectSetExecutionError(
      "EmbeddingProviderNotConfigured",
      "The configured embedding provider is not registered.",
      { provider: config.provider },
      503,
    );
  }
  const key = `${input.tenantId}:${config.provider}:${config.modelId}`;
  assertRateLimit(key, config.requestsPerSecond);
  const breaker = breakers.get(key) ?? { failures: 0, openUntil: 0 };
  if (breaker.openUntil > Date.now()) {
    setGauge("tellus_embedding_circuit_breaker_state", 1, {
      provider: config.provider,
    });
    throw new ObjectSetExecutionError(
      "EmbeddingProviderUnavailable",
      "The embedding provider circuit breaker is open.",
      { retryAfterMs: breaker.openUntil - Date.now() },
      503,
    );
  }
  const started = performance.now();
  let lastError: unknown;
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      const vector = await withProviderTimeout(
        provider.embed({
          tenantId: input.tenantId,
          modelId: config.modelId,
          text: input.text,
          dimensions: config.dimensions,
          timeoutMs: config.timeoutMs,
          endpoint: config.endpoint ?? undefined,
          credential: config.credentialEnv
            ? process.env[config.credentialEnv]
            : undefined,
        }),
        config.timeoutMs,
      );
      if (
        vector.length !== config.dimensions ||
        vector.some((value) => !Number.isFinite(value))
      ) {
        throw new ObjectSetExecutionError(
          "NearestNeighborsDimensionMismatch",
          "The embedding provider returned a vector with the wrong dimension.",
          { expected: config.dimensions, actual: vector.length },
          400,
        );
      }
      breakers.set(key, { failures: 0, openUntil: 0 });
      setGauge("tellus_embedding_circuit_breaker_state", 0, {
        provider: config.provider,
      });
      incCounter("tellus_embedding_requests_total", {
        provider: config.provider,
        outcome: "success",
      });
      observeHistogram(
        "tellus_embedding_request_duration_ms",
        performance.now() - started,
        { provider: config.provider, outcome: "success" },
      );
      return vector;
    } catch (error) {
      lastError = error;
      if (error instanceof ObjectSetExecutionError) throw error;
      const retryable = Boolean(
        (error as { retryable?: boolean }).retryable ||
          (error as { name?: string })?.name === "TimeoutError",
      );
      if (!retryable || attempt === config.maxRetries) break;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(1000, 100 * 2 ** attempt)),
      );
    }
  }
  const failures = breaker.failures + 1;
  breakers.set(key, {
    failures,
    openUntil: failures >= 5 ? Date.now() + 30_000 : 0,
  });
  incCounter("tellus_embedding_requests_total", {
    provider: config.provider,
    outcome: "error",
  });
  observeHistogram(
    "tellus_embedding_request_duration_ms",
    performance.now() - started,
    { provider: config.provider, outcome: "error" },
  );
  const rateLimited = Boolean(
    (lastError as { rateLimited?: boolean })?.rateLimited,
  );
  throw new ObjectSetExecutionError(
    rateLimited
      ? "EmbeddingProviderRateLimited"
      : (lastError as { name?: string })?.name === "TimeoutError"
        ? "EmbeddingProviderTimeout"
        : "EmbeddingProviderUnavailable",
    "The embedding provider could not produce an embedding.",
    { provider: config.provider, retryable: true },
    rateLimited ? 429 : 503,
  );
}
