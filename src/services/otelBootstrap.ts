// ---------------------------------------------------------------------------
// OpenTelemetry bootstrap — PB-B9.
//
// Must be imported BEFORE any instrumented library (`pg`, `express`,
// `@temporalio/client`, `kafkajs`) so auto-instrumentations can patch
// the module graph on first require. `src/server.ts` imports this file
// first.
//
// Span export targets `OTEL_EXPORTER_OTLP_ENDPOINT` (defaults to
// http://localhost:4318 — Jaeger/Tempo's OTLP/HTTP). Disabled entirely
// when `OTEL_SDK_DISABLED=true` so tests and cold-boot sandboxes
// don't pay the instrumentation cost.
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
import { logger } from "../utils/logger";

const disabled =
  process.env.OTEL_SDK_DISABLED === "true" ||
  process.env.NODE_ENV === "test";

let sdk: unknown = null;

if (!disabled) {
  try {
    // Lazy-require so TypeScript doesn't pull the types in at compile
    // time (auto-instrumentations modules don't ship clean .d.ts).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { NodeSDK } = require("@opentelemetry/sdk-node");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const {
      getNodeAutoInstrumentations,
    } = require("@opentelemetry/auto-instrumentations-node");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const {
      OTLPTraceExporter,
    } = require("@opentelemetry/exporter-trace-otlp-http");

    const serviceName = process.env.OTEL_SERVICE_NAME ?? "tellus-pipeline-builder";
    const endpoint =
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318";

    const instance = new NodeSDK({
      traceExporter: new OTLPTraceExporter({
        url: `${endpoint.replace(/\/+$/, "")}/v1/traces`,
      }),
      serviceName,
      instrumentations: [
        getNodeAutoInstrumentations({
          // `fs` instrumentation generates massive span volume — disable
          // for sanity; everything else is on by default.
          "@opentelemetry/instrumentation-fs": { enabled: false },
        }),
      ],
    });
    instance.start();
    sdk = instance;

    // Ensure graceful shutdown so in-flight spans flush. SIGTERM from
    // Kubernetes / docker-compose restarts propagates here.
    const shutdown = async (): Promise<void> => {
      try {
        await (instance as { shutdown: () => Promise<void> }).shutdown();
      } catch {
        /* ignore */
      }
    };
    process.on("SIGTERM", () => void shutdown());
    process.on("SIGINT", () => void shutdown());

    logger.info(
      { service: serviceName, endpoint },
      "[otel] NodeSDK started",
    );
  } catch (err) {
    logger.warn(
      { error: (err as Error).message },
      "[otel] bootstrap failed (instrumentation disabled)",
    );
  }
}

export const otelSdk = sdk;
