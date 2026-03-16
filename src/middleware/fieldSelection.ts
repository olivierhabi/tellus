import { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/foundryAppError';

interface FieldSelectionConfig {
  allowedFields: string[];
}

export function fieldSelection(config: FieldSelectionConfig) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const fieldsParam = req.query.fields as string | undefined;
    if (!fieldsParam) {
      (req as any).selectedFields = undefined;
      return next();
    }
    const requested = fieldsParam.split(',').map(f => f.trim()).filter(Boolean);
    if (requested.length === 0) {
      (req as any).selectedFields = undefined;
      return next();
    }
    const invalid = requested.filter(f => !config.allowedFields.includes(f));
    if (invalid.length > 0) {
      return next(new AppError(`Unknown fields: ${invalid.join(', ')}. Allowed: ${config.allowedFields.join(', ')}`, 400, 'VALIDATION_ERROR'));
    }
    if (!requested.includes('id')) requested.unshift('id');
    (req as any).selectedFields = requested;
    next();
  };
}
