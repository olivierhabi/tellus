import knex, { Knex } from 'knex';
import { env } from '@/config/environment';

const knexConfig: Knex.Config = {
  client: 'pg',
  connection: env.DATABASE_URL,
  pool: {
    min: 2,
    max: 10,
  },
  migrations: {
    directory: '../migrations',
    extension: 'ts',
  },
  seeds: {
    directory: '../seeds',
    extension: 'ts',
  },
};

const db: Knex = knex(knexConfig);

export default db;
export { knexConfig };
