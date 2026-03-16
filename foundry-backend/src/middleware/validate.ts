import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AppError } from '@/utils/AppError';

/**
 * Structured validation error detail.
 */
interface ValidationErrorDetail {
  source: 'body' | 'params' | 'query';
  path: (string | number)[];
  message: string;
  code: string;
}

/**
 * Schemas to validate against, keyed by request source.
 */
interface ValidationSchemas {
  body?: z.ZodTypeAny;
  params?: z.ZodTypeAny;
  query?: z.ZodTypeAny;
}

/**
 * Convert a PropertyKey[] path to (string | number)[].
 */
function normalizePath(path: PropertyKey[]): (string | number)[] {
  return path.map((p) => (typeof p === 'symbol' ? String(p) : p));
}

/**
 * Request validation middleware factory.
 *
 * Accepts Zod schemas for body, params, and/or query.
 * Validates all sources and collects errors before responding.
 * Uses Zod v4 `.issues` (not `.errors`).
 *
 * @example
 * router.post('/items',
 *   validate({ body: CreateItemSchema, params: ProjectParamsSchema }),
 *   controller.create
 * );
 */
export function validate(schemas: ValidationSchemas) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const errors: ValidationErrorDetail[] = [];

    // Validate body
    if (schemas.body) {
      const result = schemas.body.safeParse(req.body);
      if (!result.success) {
        for (const issue of result.error.issues) {
          errors.push({
            source: 'body',
            path: normalizePath(issue.path),
            message: issue.message,
            code: issue.code,
          });
        }
      } else {
        // Replace body with parsed/transformed data
        req.body = result.data;
      }
    }

    // Validate params
    if (schemas.params) {
      const result = schemas.params.safeParse(req.params);
      if (!result.success) {
        for (const issue of result.error.issues) {
          errors.push({
            source: 'params',
            path: normalizePath(issue.path),
            message: issue.message,
            code: issue.code,
          });
        }
      }
    }

    // Validate query
    if (schemas.query) {
      const result = schemas.query.safeParse(req.query);
      if (!result.success) {
        for (const issue of result.error.issues) {
          errors.push({
            source: 'query',
            path: normalizePath(issue.path),
            message: issue.message,
            code: issue.code,
          });
        }
      } else {
        // Replace query with parsed/transformed data (coerced types, defaults, etc.)
        (req as unknown as { query: unknown }).query = result.data;
      }
    }

    // If there are any errors, create a single error with details and pass to next
    if (errors.length > 0) {
      const err = new AppError(
        `Validation failed: ${errors.length} error(s)`,
        400,
        'VALIDATION_ERROR'
      );
      (err as unknown as { details: ValidationErrorDetail[] }).details = errors;
      next(err);
      return;
    }

    next();
  };
}
