import { Request, Response, NextFunction } from 'express';
import { AppError } from '@/utils/AppError';
import db from '@/config/database';

export function authorizeRoles(...allowedRoles: string[]) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const user = (req as unknown as { user?: { id: string } }).user;
      if (!user) {
        throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
      }

      const projectId = (req.params.projectId || req.params.id) as string;
      if (!projectId) {
        return next();
      }

      const membership = await db('project_members')
        .where({ project_id: projectId, user_id: user.id })
        .first();

      if (!membership) {
        throw new AppError('Access denied: not a member of this project', 403, 'FORBIDDEN');
      }

      if (!allowedRoles.includes(membership.role)) {
        throw new AppError(`Access denied: requires one of: ${allowedRoles.join(', ')}`, 403, 'FORBIDDEN');
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}
