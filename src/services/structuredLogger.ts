// ---------------------------------------------------------------------------
// Structured JSON logger — PB-B9.
//
// Emits one JSON line per log call with the fields the spec pins:
//   ts, level, msg, trace_id, span_id, deployment_id, pipeline_id,
//   project_id, actor_user_id, ...custom
//
// Callers pass a custom object; trace fields are pulled from the
// AsyncLocalStorage set by middleware/traceContext.ts. Writes go to
// stdout so a container log driver (Loki / CloudWatch / stdout-sink)
// can ingest directly.
// ---------------------------------------------------------------------------

import { currentTrace } from "./traceContext";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogPayload {
  msg: string;
  [key: string]: unknown;
}

function emit(level: LogLevel, payload: LogPayload): void {
  const trace = currentTrace();
  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg: payload.msg,
    trace_id: trace?.traceId,
    span_id: trace?.spanId,
    deployment_id: trace?.deploymentId,
    pipeline_id: trace?.pipelineId,
    project_id: trace?.projectId,
    actor_user_id: trace?.actorUserId,
    ...Object.fromEntries(
      Object.entries(payload).filter(([k]) => k !== "msg"),
    ),
  };
  // Drop undefined keys so the JSON stays compact without polluting
  // downstream parsers with nulls they'd have to filter.
  for (const k of Object.keys(line)) {
    if (line[k] === undefined) delete line[k];
  }
  const out = JSON.stringify(line);
  if (level === "error") {
    process.stderr.write(out + "\n");
  } else {
    process.stdout.write(out + "\n");
  }
}

export const log = {
  debug(payload: LogPayload): void { emit("debug", payload); },
  info(payload: LogPayload): void { emit("info", payload); },
  warn(payload: LogPayload): void { emit("warn", payload); },
  error(payload: LogPayload): void { emit("error", payload); },
};
