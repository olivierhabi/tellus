import { Request, Response, NextFunction } from 'express';

export function serverTiming(req: Request, res: Response, next: NextFunction) {
  const start = process.hrtime.bigint();
  const originalJson = res.json.bind(res);

  // Wrap res.json: restore the original after first call to prevent
  // stacking if another middleware or error handler also calls res.json.
  res.json = function serverTimingJson(body: any) {
    res.json = originalJson;
    const end = process.hrtime.bigint();
    const durationMs = Number(end - start) / 1_000_000;
    res.setHeader('Server-Timing', `total;dur=${durationMs.toFixed(2)};desc="Total Processing"`);
    return res.json.call(this, body);
  };
  next();
}
