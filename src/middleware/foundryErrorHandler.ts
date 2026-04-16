import { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/foundryAppError';

/**
 * Global error handler middleware.
 * Express identifies this as an error handler by the 4-parameter signature.
 */
export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction) {
  console.error('Unhandled error:', { name: err.name, message: err.message, stack: err.stack });

  if (err instanceof AppError && err.isOperational) {
    res.status(err.statusCode).json({
      success: false,
      error: { code: err.code, message: err.message, details: null }
    });
    return;
  }

  if ('type' in err && (err as { type: string }).type === 'entity.parse.failed') {
    res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Malformed JSON in request body.', details: null }
    });
    return;
  }

  const isDev = process.env.NODE_ENV === 'development';
  if (isDev) {
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: err.message, details: null, stack: err.stack }
    });
    return;
  }

  res.status(500).json({
    success: false,
    error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.', details: null }
  });
}
