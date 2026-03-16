import { Request, Response, NextFunction } from 'express';

/**
 * Stub authentication middleware (BE-005).
 * Sets a hardcoded test user on req.user until BE-013 implements real JWT auth.
 */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  (req as unknown as { user: { id: string; email: string; displayName: string } }).user = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    email: 'testuser@foundry.local',
    displayName: 'Test User',
  };
  next();
}

/**
 * Stub authorization middleware (BE-005).
 * Accepts any roles and calls next() until BE-013 implements real role checks.
 */
export function authorize(..._roles: string[]) {
  return (_req: Request, _res: Response, next: NextFunction): void => {
    next();
  };
}
