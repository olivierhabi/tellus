import { Router } from 'express';
import { AuthController } from '../controllers/authController';
import { AuthService } from '../services/authService';
import rateLimit from 'express-rate-limit';
import foundryDb from '../config/foundryDb';

const router = Router();
const authService = new AuthService(foundryDb);
const authController = new AuthController(authService);

const AUTH_RATE_LIMIT_MAX = parseInt(process.env.AUTH_RATE_LIMIT_MAX || '20', 10);
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: AUTH_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later' } },
});

router.post('/register', authLimiter, authController.register);
router.post('/login', authLimiter, authController.login);
router.post('/refresh', authController.refresh);
router.post('/logout', authController.logout);

export default router;
