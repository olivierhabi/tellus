import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { foundryEnv } from '../config/foundryEnv';
import { AppError } from '../utils/foundryAppError';
import foundryDb from '../config/foundryDb';

export async function authenticateJWT(req: Request, _res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
    }

    const token = authHeader.slice(7);
    const decoded = jwt.verify(token, foundryEnv.JWT_SECRET) as { userId: string };

    const user = await foundryDb('users')
      .where({ id: decoded.userId })
      .select('id', 'email', 'display_name')
      .first();

    if (!user) {
      throw new AppError('User not found', 401, 'UNAUTHORIZED');
    }

    (req as unknown as { user: { id: string; email: string; displayName: string } }).user = {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
    };

    next();
  } catch (error) {
    if (error instanceof AppError) {
      next(error);
    } else if (error instanceof jwt.TokenExpiredError) {
      next(new AppError('Token expired', 401, 'TOKEN_EXPIRED'));
    } else if (error instanceof jwt.JsonWebTokenError) {
      next(new AppError('Invalid token', 401, 'UNAUTHORIZED'));
    } else {
      next(error);
    }
  }
}
