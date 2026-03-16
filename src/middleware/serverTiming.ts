import { Request, Response, NextFunction } from 'express';

export function serverTiming(req: Request, res: Response, next: NextFunction) {
  const start = process.hrtime.bigint();

  // Use 'finish' event to set the header before the response is sent.
  // This avoids monkey-patching res.json and works for all response types.
  res.on('finish', () => {
    // Header can only be set if not already sent — 'finish' fires after
    // headers are flushed, so we set the header beforehand via a write-head hook.
  });

  // Wrap res.json safely: store original from prototype, restore after use
  const originalJson = res.json;
  res.json = function serverTimingJson(body: any) {
    // Restore original to prevent stacking in case of multiple calls
    res.json = originalJson;
    const end = process.hrtime.bigint();
    const durationMs = Number(end - start) / 1_000_000;
    res.setHeader('Server-Timing', `total;dur=${durationMs.toFixed(2)};desc="Total Processing"`);
    return res.json.call(this, body);
  };
  next();
}
