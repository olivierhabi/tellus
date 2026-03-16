import type { Knex } from 'knex';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const baseConfig: Knex.Config = {
  client: 'pg',
  pool: {
    min: 2,
    max: 10,
  },
  migrations: {
    directory: path.resolve(__dirname, '../migrations'),
    extension: 'ts',
  },
  seeds: {
    directory: path.resolve(__dirname, '../seeds'),
    extension: 'ts',
  },
};

const config: Record<string, Knex.Config> = {
  development: {
    ...baseConfig,
    connection: process.env.DATABASE_URL,
  },
  test: {
    ...baseConfig,
    connection: process.env.DATABASE_URL,
  },
  production: {
    ...baseConfig,
    connection: process.env.DATABASE_URL,
    pool: {
      min: 2,
      max: 20,
    },
  },
};

export default config;

module.exports = config;
