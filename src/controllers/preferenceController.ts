import { Request, Response, NextFunction } from 'express';
import { PreferenceService } from '../services/preferenceService';
import { AppError } from '../utils/foundryAppError';

export class PreferenceController {
  constructor(private preferenceService: PreferenceService) {}

  private getUserId(req: Request): string {
    const user = (req as any).user;
    return user?.id ?? '550e8400-e29b-41d4-a716-446655440000';
  }

  getAll = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = this.getUserId(req);
      const prefs = await this.preferenceService.getAllPreferences(userId);
      res.json({ success: true, data: prefs });
    } catch (error) { next(error); }
  };

  getByKey = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = this.getUserId(req);
      const key = req.params.key;
      if (!/^[a-z][a-z0-9_]*$/.test(key)) {
        throw new AppError('Preference key must be lowercase snake_case.', 400, 'VALIDATION_ERROR');
      }
      const pref = await this.preferenceService.getPreference(userId, key);
      if (!pref) throw new AppError('Preference not found.', 404, 'NOT_FOUND');
      res.json({ success: true, data: pref });
    } catch (error) { next(error); }
  };

  update = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = this.getUserId(req);
      const key = req.params.key;
      if (!/^[a-z][a-z0-9_]*$/.test(key)) {
        throw new AppError('Preference key must be lowercase snake_case.', 400, 'VALIDATION_ERROR');
      }
      if (req.body.value === undefined) {
        throw new AppError('value is required.', 400, 'VALIDATION_ERROR');
      }
      await this.preferenceService.setPreference(userId, key, req.body.value);
      const pref = await this.preferenceService.getPreference(userId, key);
      res.json({ success: true, data: pref });
    } catch (error) { next(error); }
  };

  remove = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = this.getUserId(req);
      const key = req.params.key;
      const deleted = await this.preferenceService.deletePreference(userId, key);
      if (!deleted) throw new AppError('Preference not found.', 404, 'NOT_FOUND');
      res.status(204).send();
    } catch (error) { next(error); }
  };
}
