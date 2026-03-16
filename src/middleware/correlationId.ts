import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';

/**
 * Middleware that generates a unique correlation ID for each request.
 * The ID is attached to req.correlationId and set as a response header.
 * If the client sends an X-Correlation-ID header, it is reused.
 */
export function correlationId(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const id =
    (req.headers['x-correlation-id'] as string) || uuidv4();

  req.correlationId = id;
  res.setHeader('X-Correlation-ID', id);

  next();
}
