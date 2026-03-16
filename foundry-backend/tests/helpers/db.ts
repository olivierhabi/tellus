import knex, { Knex } from 'knex';

let testDb: Knex | null = null;

export function getTestDb(): Knex {
  if (!testDb) {
    testDb = knex({
      client: 'pg',
      connection: process.env.DATABASE_URL || 'postgresql://tellus:tellus123@localhost:5432/foundry',
      pool: { min: 1, max: 3 },
    });
  }
  return testDb;
}

export async function truncateAllTables(): Promise<void> {
  const db = getTestDb();
  await db.raw('TRUNCATE dataset_columns, datasets, folders, projects CASCADE');
}

export async function closeTestDb(): Promise<void> {
  if (testDb) {
    await testDb.destroy();
    testDb = null;
  }
}
