import { Knex } from 'knex';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { foundryEnv } from '../config/foundryEnv';
import { AppError } from '../utils/foundryAppError';

const BCRYPT_ROUNDS = 12;
const ACCESS_TOKEN_EXPIRY = '1h';
const REFRESH_TOKEN_EXPIRY_DAYS = 7;

export class AuthService {
  constructor(private knex: Knex) {}

  async register(email: string, password: string, displayName: string) {
    const existing = await this.knex('users').where({ email: email.toLowerCase() }).first();
    if (existing) {
      throw new AppError('A user with this email already exists', 409, 'CONFLICT');
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const [user] = await this.knex('users')
      .insert({
        email: email.toLowerCase(),
        password_hash: passwordHash,
        display_name: displayName,
      })
      .returning(['id', 'email', 'display_name', 'created_at']);

    const tokens = await this.generateTokens(user.id);
    return { user, ...tokens };
  }

  async login(email: string, password: string) {
    const user = await this.knex('users').where({ email: email.toLowerCase() }).first();
    if (!user) {
      throw new AppError('Invalid email or password', 401, 'UNAUTHORIZED');
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      throw new AppError('Invalid email or password', 401, 'UNAUTHORIZED');
    }

    const tokens = await this.generateTokens(user.id);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { password_hash: _hash, ...safeUser } = user;
    return { user: safeUser, ...tokens };
  }

  async refresh(refreshToken: string) {
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const stored = await this.knex('refresh_tokens').where({ token_hash: tokenHash }).first();

    if (!stored) {
      throw new AppError('Invalid refresh token', 401, 'UNAUTHORIZED');
    }

    if (new Date(stored.expires_at) < new Date()) {
      await this.knex('refresh_tokens').where({ id: stored.id }).delete();
      throw new AppError('Refresh token expired', 401, 'UNAUTHORIZED');
    }

    // One-time use: delete the old token
    await this.knex('refresh_tokens').where({ id: stored.id }).delete();

    const tokens = await this.generateTokens(stored.user_id);
    return tokens;
  }

  async logout(refreshToken: string) {
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    await this.knex('refresh_tokens').where({ token_hash: tokenHash }).delete();
  }

  private async generateTokens(userId: string) {
    const accessToken = jwt.sign({ userId }, foundryEnv.JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });

    const refreshToken = crypto.randomBytes(40).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + REFRESH_TOKEN_EXPIRY_DAYS);

    await this.knex('refresh_tokens').insert({
      user_id: userId,
      token_hash: tokenHash,
      expires_at: expiresAt,
    });

    return { accessToken, refreshToken };
  }
}
