// ---------------------------------------------------------------------------
// Shared AppError — single definition used across all services
// ---------------------------------------------------------------------------

export interface AppError extends Error {
  code: string;
  details?: Record<string, unknown>;
}

/**
 * Create an AppError with a machine-readable code and human-readable message.
 * The code should match one of the ERROR_CODES in responseFormatter.ts.
 */
export function appError(
  code: string,
  message: string,
  details?: Record<string, unknown>
): AppError {
  const err = new Error(message) as AppError;
  err.code = code;
  if (details) err.details = details;
  return err;
}
