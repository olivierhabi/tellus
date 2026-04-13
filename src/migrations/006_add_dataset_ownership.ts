import { Knex } from 'knex';

/**
 * Add created_by and updated_by columns to foundry_datasets.
 *
 * These reference the users table so the API can return the display_name
 * of the user who created or last modified a dataset — used in the
 * Pipeline Builder bottom panel "Updated … by X" / "Created … by X" UI.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('foundry_datasets', (table) => {
    table
      .uuid('created_by')
      .nullable()
      .references('id')
      .inTable('users')
      .onDelete('SET NULL');
    table
      .uuid('updated_by')
      .nullable()
      .references('id')
      .inTable('users')
      .onDelete('SET NULL');
  });

  // Create indexes for the FK columns
  await knex.schema.raw(
    'CREATE INDEX IF NOT EXISTS idx_foundry_datasets_created_by ON foundry_datasets (created_by)'
  );
  await knex.schema.raw(
    'CREATE INDEX IF NOT EXISTS idx_foundry_datasets_updated_by ON foundry_datasets (updated_by)'
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.raw('DROP INDEX IF EXISTS idx_foundry_datasets_updated_by');
  await knex.schema.raw('DROP INDEX IF EXISTS idx_foundry_datasets_created_by');
  await knex.schema.alterTable('foundry_datasets', (table) => {
    table.dropColumn('updated_by');
    table.dropColumn('created_by');
  });
}
