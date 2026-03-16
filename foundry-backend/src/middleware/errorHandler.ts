import { Request, Response, NextFunction } from 'express';
import { AppError } from '@/utils/AppError';

/**
 * Global error handler middleware.
 * Express identifies this as an error handler by the 4-parameter signature.
 */
export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  // Always log the full error to stderr
  console.error('Unhandled error:', {
    name: err.name,
    message: err.message,
    stack: err.stack,
  });

  // Handle known operational errors
  if (err instanceof AppError && err.isOperational) {
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
      },
    });
    return;
  }

  // Handle JSON parse errors (malformed request body)
  // Express body-parser attaches a 'type' property to SyntaxError
  if ('type' in err && (err as { type: string }).type === 'entity.parse.failed') {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Malformed JSON in request body',
      },
    });
    return;
  }

  // Handle non-operational errors
  const isDev = process.env.NODE_ENV === 'development';

  if (isDev) {
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: err.message,
        stack: err.stack,
      },
    });
    return;
  }

  // Production: generic message only
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    },
  });
}
