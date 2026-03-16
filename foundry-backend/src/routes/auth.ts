import { Router } from 'express';
import { AuthController } from '@/controllers/authController';
import { AuthService } from '@/services/authService';
import rateLimit from 'express-rate-limit';
import db from '@/config/database';

const router = Router();
const authService = new AuthService(db);
const authController = new AuthController(authService);

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later' } },
});

router.post('/register', authLimiter, authController.register);
router.post('/login', authLimiter, authController.login);
router.post('/refresh', authController.refresh);
router.post('/logout', authController.logout);

export default router;
