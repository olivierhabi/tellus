import { Knex } from 'knex';
import { AppError } from '../utils/foundryAppError';
import { DEFAULT_PREFERENCES } from '../config/defaultPreferences';

export class PreferenceService {
  constructor(private knex: Knex) {}

  async getAllPreferences(userId: string): Promise<Record<string, any>> {
    const stored = await this.knex('user_preferences')
      .where({ user_id: userId })
      .select('preference_key', 'preference_value');
    const merged = { ...DEFAULT_PREFERENCES };
    for (const row of stored) {
      merged[row.preference_key] = row.preference_value;
    }
    return merged;
  }

  async getPreference(userId: string, key: string) {
    const stored = await this.knex('user_preferences')
      .where({ user_id: userId, preference_key: key })
      .first();
    if (stored) {
      return { key, value: stored.preference_value, isDefault: false };
    }
    if (key in DEFAULT_PREFERENCES) {
      return { key, value: DEFAULT_PREFERENCES[key], isDefault: true };
    }
    return null;
  }

  async setPreference(userId: string, key: string, value: any): Promise<void> {
    // Knex pg driver auto-serializes objects for JSONB columns;
    // wrapping in JSON.stringify() would double-serialize the value.
    await this.knex('user_preferences')
      .insert({ user_id: userId, preference_key: key, preference_value: value })
      .onConflict(['user_id', 'preference_key'])
      .merge({ preference_value: value, updated_at: this.knex.fn.now() });
  }

  async deletePreference(userId: string, key: string): Promise<boolean> {
    const deleted = await this.knex('user_preferences')
      .where({ user_id: userId, preference_key: key })
      .delete();
    return deleted > 0;
  }
}
