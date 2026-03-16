import { Request, Response, NextFunction } from 'express';
import { AuthService } from '@/services/authService';
import { AppError } from '@/utils/AppError';
import { z } from 'zod';

const RegisterSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  displayName: z.string().min(1, 'Display name is required').max(255),
});

const LoginSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(1, 'Password is required'),
});

const RefreshSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

export class AuthController {
  constructor(private authService: AuthService) {}

  register = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = RegisterSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      }
      const result = await this.authService.register(
        parsed.data.email,
        parsed.data.password,
        parsed.data.displayName
      );
      res.status(201).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  };

  login = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = LoginSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      }
      const result = await this.authService.login(parsed.data.email, parsed.data.password);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  };

  refresh = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = RefreshSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      }
      const result = await this.authService.refresh(parsed.data.refreshToken);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  };

  logout = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = RefreshSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      }
      await this.authService.logout(parsed.data.refreshToken);
      res.json({ success: true, message: 'Logged out successfully' });
    } catch (error) {
      next(error);
    }
  };
}
