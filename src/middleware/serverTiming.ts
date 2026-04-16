import { Request, Response, NextFunction } from 'express';

export function serverTiming(req: Request, res: Response, next: NextFunction) {
  const start = process.hrtime.bigint();

  // Intercept writeHead so the Server-Timing header is added for every
  // response type (json, send, end, status 204, HTML, etc.), not only
  // responses that go through res.json().
  const originalWriteHead = res.writeHead;
  res.writeHead = function (
    this: Response,
    statusCode: number,
    ...rest: unknown[]
  ): Response {
    // Only set if headers have not been sent yet
    if (!res.headersSent) {
      const end = process.hrtime.bigint();
      const durationMs = Number(end - start) / 1_000_000;
      res.setHeader('Server-Timing', `total;dur=${durationMs.toFixed(2)};desc="Total Processing"`);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (originalWriteHead as any).call(this, statusCode, ...rest);
  } as typeof res.writeHead;

  next();
}
