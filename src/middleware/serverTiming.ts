import { Request, Response, NextFunction } from 'express';

export function serverTiming(req: Request, res: Response, next: NextFunction) {
  const start = process.hrtime.bigint();
  const originalJson = res.json.bind(res);
  res.json = function(body: any) {
    const end = process.hrtime.bigint();
    const durationMs = Number(end - start) / 1_000_000;
    res.setHeader('Server-Timing', `total;dur=${durationMs.toFixed(2)};desc="Total Processing"`);
    return originalJson(body);
  };
  next();
}
