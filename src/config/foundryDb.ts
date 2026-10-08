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
    // TCP keepalive so half-open pooled sockets are detected/evicted
    // instead of surfacing as hung queries (the REQUEST_TIMEOUT 504s).
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  },
  pool: {
    min: 2,
    max: parseInt(envWithDefault('PG_POOL_MAX', '10'), 10),
    // A query that cannot get a connection, or a connection that cannot
    // be established, fails fast instead of hanging past the API budget.
    acquireTimeoutMillis: 10_000,
    createTimeoutMillis: 10_000,
    // Pin server-side guards per checkout: a leaked tx must not pin a
    // slot forever, and no single statement may hold the pool
    // indefinitely. Mirrors src/db.ts (the old 60s idle-tx ceiling
    // FATAL'd live scheduler transactions and poisoned pooled sessions
    // with dead sockets).
    afterCreate: (
      conn: { query: (s: string, cb: (e: unknown) => void) => void },
      done: (e: unknown, conn?: unknown) => void,
    ) => {
      conn.query(
        `SET idle_in_transaction_session_timeout = ${parseInt(envWithDefault('PG_IDLE_TX_TIMEOUT_MS', '300000'), 10)}; SET statement_timeout = ${parseInt(envWithDefault('PG_STATEMENT_TIMEOUT_MS', '120000'), 10)}`,
        (err) => done(err, conn),
      );
    },
  },
});

export default foundryDb;
