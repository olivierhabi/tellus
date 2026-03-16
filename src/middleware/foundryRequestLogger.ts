import { Request, Response, NextFunction } from 'express';

/**
 * Custom request logger middleware.
 * Logs method, URL, status code, and response duration.
 */
export function requestLogger(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const start = Date.now();

  // Log when the response finishes
  res.on('finish', () => {
    const duration = Date.now() - start;
    const logEntry = {
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      duration: `${duration}ms`,
      timestamp: new Date().toISOString(),
    };

    // Use stderr for error status codes, stdout otherwise
    if (res.statusCode >= 400) {
      console.error(JSON.stringify(logEntry));
    } else {
      console.log(JSON.stringify(logEntry));
    }
  });

  next();
}
