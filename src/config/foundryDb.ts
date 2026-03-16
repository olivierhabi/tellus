import knex, { Knex } from 'knex';

const foundryDb: Knex = knex({
  client: 'pg',
  connection: {
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10),
    database: process.env.PGDATABASE || 'tellus_db',
    user: process.env.PGUSER || 'tellus',
    password: process.env.PGPASSWORD || 'tellus123',
  },
  pool: { min: 2, max: 10 },
});

export default foundryDb;
