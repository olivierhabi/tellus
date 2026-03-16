import { Request, Response, NextFunction } from 'express';
import { authenticateJWT } from './authenticate';

/**
 * Authentication middleware.
 * Uses real JWT authentication (BE-013). Falls back to a hardcoded test user
 * ONLY when no Authorization header is present in development/test mode.
 */
export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  // If an Authorization header is present, always use real JWT validation
  if (authHeader && authHeader.startsWith('Bearer ')) {
    authenticateJWT(req, res, next);
    return;
  }

  // In production, require authentication — no fallback
  if (process.env.NODE_ENV === 'production') {
    res.status(401).json({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Authentication required',
        details: null,
      },
    });
    return;
  }

  // Development/test fallback: set a hardcoded test user when no auth header is provided
  (req as unknown as { user: { id: string; email: string; displayName: string } }).user = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    email: 'testuser@foundry.local',
    displayName: 'Test User',
  };
  next();
}

/**
 * Authorization middleware.
 * Checks that the authenticated user has one of the required roles.
 */
export function authorize(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as unknown as { user?: { id: string; role?: string } }).user;
    if (!user) {
      res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required', details: null },
      });
      return;
    }

    // If no roles specified, any authenticated user is allowed
    if (roles.length === 0) {
      next();
      return;
    }

    // Enforce role check when the user has a role assigned
    if (user.role && roles.includes(user.role)) {
      next();
      return;
    }

    // In non-production, if user has no role (e.g. hardcoded dev user), allow through
    if (!user.role && process.env.NODE_ENV !== 'production') {
      next();
      return;
    }

    res.status(403).json({
      success: false,
      error: {
        code: 'FORBIDDEN',
        message: `Insufficient permissions. Required role: ${roles.join(' or ')}`,
        details: null,
      },
    });
  };
}
