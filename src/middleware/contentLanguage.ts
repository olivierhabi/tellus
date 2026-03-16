import { Request, Response, NextFunction } from 'express';

export function contentLanguage(_req: Request, res: Response, next: NextFunction) {
  res.setHeader('Content-Language', 'en-US');
  next();
}
