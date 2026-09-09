// ---------------------------------------------------------------------------
// src/utils/logger.ts
//
// Canonical structured logger for the API process.
//
// This is the import surface new code should use:
//
//   import { logger } from "../utils/logger";
//   logger.info({ deploymentId }, "deployment started");
//
// It wraps the Pino instance from src/logging/pino.ts (structured JSON,
// PII redaction, LOG_LEVEL / PINO_PRETTY=1 controls) so there is exactly
// ONE logger implementation in the codebase; this module exists to give
// utils-level consumers a stable path that does not reach into the
// logging/ internals. When pino is not installed the underlying module
// falls back to a console-backed shim with the same call shape.
// ---------------------------------------------------------------------------

export { logger, forRequest, installConsoleBridge } from "../logging/pino";
export { default } from "../logging/pino";
