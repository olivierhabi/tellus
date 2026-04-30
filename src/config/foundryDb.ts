// F-P4-23: PG password fallback `|| 'tellus123'` removed. Every
// security-sensitive connection field is now read via `requireSecret`
// and the process fails to start if any is missing. Host/port/database
// keep a dev default via `envWithDefault` since they are not credentials.
import knex, { Knex } from 'knex';
import { envWithDefault, requireSecret } from '../utils/requireEnv';

const foundryDb: Knex = knex({
  client: 'pg',
  connection: {
    host: envWithDefault('PGHOST', 'localhost'),
    port: parseInt(envWithDefault('PGPORT', '5432'), 10),
    database: envWithDefault('PGDATABASE', 'tellus_db'),
    user: envWithDefault('PGUSER', 'tellus'),
    password: requireSecret('PGPASSWORD', 'Postgres password is required.'),
  },
  pool: { min: 2, max: 10 },
});

export default foundryDb;
