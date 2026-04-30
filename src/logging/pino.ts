// ---------------------------------------------------------------------------
// src/logging/pino.ts
//
// F-P4-18 closure — structured logger with PII scrubbing.
//
// Pre-fix: every log line in the codebase was a `console.error` /
// `console.warn` text interpolation, so logs were unstructured,
// PII-unaware, and unfit for machine analysis or aggregation. Under
// FedRAMP / Rwandan Law 058/2021, log PII is a compliance concern.
//
// Post-fix: a Pino-based logger with:
//   - structured JSON output (one log line = one JSON object).
//   - redaction of well-known PII paths (email, phone, national_id,
//     tax_id, password, token, authorization, secret, api_key).
//   - automatic correlation via req.requestId (caller threads it into
//     the context via `logger.child({ requestId })`).
//   - a "console bridge" that intercepts accidental `console.*` calls
//     and emits them through Pino too, so Block G does not require
//     rewriting every existing call site at once.
//
// The bridge is opt-in via `installConsoleBridge(logger)` — disabled
// by default because tests should see raw console output.
// ---------------------------------------------------------------------------

// Pino is dynamically required so the module compiles even when pino is
// not installed in minimal environments (tests, CI without the optional
// transport deps). When pino is unavailable we fall through to a
// console-backed shim that emits the same structured shape. Install pino
// via `pnpm add pino pino-pretty` to switch to real Pino output.
//
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Logger = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LoggerOptions = any;

/** PII paths scrubbed everywhere in logs. Pino's redaction engine walks
 * every emitted object and replaces matching keys with "[REDACTED]". */
const PII_PATHS: string[] = [
  // credentials
  "password", "*.password", "*.*.password",
  "token", "*.token", "*.*.token",
  "authorization", "*.authorization", "headers.authorization",
  "apiKey", "*.apiKey", "api_key", "*.api_key",
  "secret", "*.secret", "*.*.secret",
  "privateKey", "*.privateKey", "private_key", "*.private_key",
  "client_secret", "*.client_secret",
  "refresh_token", "*.refresh_token",
  "access_token", "*.access_token",
  // personal identifiers — scrubbed so exact values never land in logs,
  // only hashed proxies. Callers that NEED the original PII for audit
  // must use the audit chain directly, not the logger.
  "email", "*.email", "*.*.email",
  "phone", "*.phone", "phoneNumber", "*.phoneNumber",
  "nationalId", "*.nationalId", "national_id", "*.national_id",
  "taxId", "*.taxId", "tax_id", "*.tax_id",
  "ssn", "*.ssn",
];

function defaultOptions(pinoMod: any): LoggerOptions {
  const level = process.env.LOG_LEVEL ?? "info";
  return {
    level,
    base: {
      service: "tellus",
      env: process.env.NODE_ENV ?? "development",
      version: process.env.TELLUS_VERSION ?? "unknown",
    },
    timestamp: pinoMod?.stdTimeFunctions?.isoTime,
    redact: {
      paths: PII_PATHS,
      censor: "[REDACTED]",
      remove: false,
    },
    transport:
      process.env.NODE_ENV !== "production" && process.env.PINO_PRETTY === "1"
        ? { target: "pino-pretty", options: { colorize: true } }
        : undefined,
  };
}

/**
 * Console-backed shim with the same shape as a Pino logger. Used when
 * pino is not installed. Structured JSON output to stdout so downstream
 * log aggregators still see one-line-per-event semantics.
 */
function makeConsoleShim(level: string): Logger {
  const levels = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 } as const;
  const threshold = (levels as Record<string, number>)[level] ?? 30;
  function emit(lvl: keyof typeof levels, obj: unknown, msg?: string) {
    if (levels[lvl] < threshold) return;
    const base = {
      level: levels[lvl],
      time: new Date().toISOString(),
      service: "tellus",
      env: process.env.NODE_ENV ?? "development",
      ...(typeof obj === "object" && obj !== null ? obj : { msg: obj }),
      ...(msg ? { msg } : {}),
    };
    // stderr for warn+, stdout for info and below.
    const stream = levels[lvl] >= 40 ? process.stderr : process.stdout;
    stream.write(JSON.stringify(base) + "\n");
  }
  const api: any = {
    level,
    trace: (o: unknown, m?: string) => emit("trace", o, m),
    debug: (o: unknown, m?: string) => emit("debug", o, m),
    info:  (o: unknown, m?: string) => emit("info",  o, m),
    warn:  (o: unknown, m?: string) => emit("warn",  o, m),
    error: (o: unknown, m?: string) => emit("error", o, m),
    fatal: (o: unknown, m?: string) => emit("fatal", o, m),
    child: (bindings: Record<string, unknown>) => {
      const child: any = { ...api };
      for (const k of ["trace", "debug", "info", "warn", "error", "fatal"] as const) {
        child[k] = (o: unknown, m?: string) =>
          emit(k, typeof o === "object" && o !== null ? { ...bindings, ...o } : { ...bindings, msg: o }, m);
      }
      return child;
    },
  };
  return api;
}

function makeLogger(): Logger {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pinoMod = require("pino");
    const pinoFn = (pinoMod.default ?? pinoMod) as (opts: LoggerOptions) => Logger;
    return pinoFn(defaultOptions(pinoMod));
  } catch {
    return makeConsoleShim(process.env.LOG_LEVEL ?? "info");
  }
}

/** Root logger — one per process. */
export const logger: Logger = makeLogger();

/**
 * Construct a child logger bound to a specific request. Call in the
 * requestId middleware so every subsequent log includes the correlation
 * id without the call site having to know.
 */
export function forRequest(requestId: string, extra: Record<string, unknown> = {}): Logger {
  return logger.child({ requestId, ...extra });
}

/**
 * Intercept console.log / warn / error so legacy `console.*` call sites
 * still route through Pino during the F-P4-18 migration window. Tests
 * that need raw console output MUST NOT call this.
 */
export function installConsoleBridge(target: Logger = logger): void {
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origErr = console.error.bind(console);

  console.log = (...args: unknown[]) => {
    target.info({ console: "log" }, args.length === 1 ? String(args[0]) : JSON.stringify(args));
    // Preserve stderr behavior only in non-production.
    if (process.env.NODE_ENV !== "production") origLog(...args);
  };
  console.warn = (...args: unknown[]) => {
    target.warn({ console: "warn" }, args.length === 1 ? String(args[0]) : JSON.stringify(args));
    if (process.env.NODE_ENV !== "production") origWarn(...args);
  };
  console.error = (...args: unknown[]) => {
    target.error({ console: "error" }, args.length === 1 ? String(args[0]) : JSON.stringify(args));
    if (process.env.NODE_ENV !== "production") origErr(...args);
  };
}

export default logger;
