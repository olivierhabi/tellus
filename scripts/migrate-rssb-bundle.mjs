#!/usr/bin/env node
import fs from 'node:fs';
import pg from 'pg';

const { Client } = pg;
const mode = process.argv[2];
const bundlePath = process.argv[3];
const SOURCE = {
  project: '36271681-65d7-4c55-a6d0-20137f8212dc',
  folder: '69e97736-27b4-45f5-934b-b088650632c3',
};
const TARGET = {
  project: '0de8cb68-6f42-4cd2-87f4-8018d8adb078',
  folder: '4155f940-cff5-4cd7-9122-ee7645cd7d4e',
};
const rid = (kind, id) => `ri.compass.main.${kind}.${id}`;
const client = new Client();
await client.connect();

const encode = (value) => JSON.parse(JSON.stringify(value, (_key, v) =>
  v?.type === 'Buffer' && Array.isArray(v.data) ? { __bytea: Buffer.from(v.data).toString('base64') } : v));
const decode = (value) => value && typeof value === 'object'
  ? (value.__bytea ? Buffer.from(value.__bytea, 'base64')
    : Array.isArray(value) ? value.map(decode)
      : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decode(v)])))
  : value;
const rows = async (sql, params = []) => encode((await client.query(sql, params)).rows);

if (mode === 'export') {
  const selected = {};
  selected.pipelines = (await rows(`SELECT id FROM pipelines WHERE folder_id=$1`, [SOURCE.folder])).map(x => x.id);
  selected.workshops = (await rows(`SELECT rid FROM workshop_module WHERE parent_folder_rid=$1 AND deleted_at IS NULL`, [rid('folder', SOURCE.folder)])).map(x => x.rid);
  selected.repos = (await rows(`SELECT rid FROM code_repository WHERE parent_folder_rid=$1 AND state='ACTIVE'`, [rid('folder', SOURCE.folder)])).map(x => x.rid);
  selected.objects = (await rows(`WITH seed AS (SELECT object_type_id FROM object_type WHERE display_name ILIKE '[RSSB]%'), links AS (SELECT * FROM link_type WHERE source_object_type IN (SELECT object_type_id FROM seed) OR target_object_type IN (SELECT object_type_id FROM seed)) SELECT object_type_id FROM seed UNION SELECT source_object_type FROM links UNION SELECT target_object_type FROM links`)).map(x => x.object_type_id);
  selected.datasets = (await rows(`
    SELECT id FROM foundry_datasets WHERE folder_id=$1
    UNION SELECT dataset_id FROM pipeline_nodes WHERE pipeline_id=ANY($2::uuid[]) AND dataset_id IS NOT NULL
    UNION SELECT foundry_dataset_id FROM backing_datasource WHERE object_type_id=ANY($3::uuid[]) AND foundry_dataset_id IS NOT NULL
  `, [SOURCE.folder, selected.pipelines, selected.objects])).map(x => x.id);
  selected.links = (await rows(`SELECT link_type_id FROM link_type WHERE source_object_type=ANY($1::uuid[]) OR target_object_type=ANY($1::uuid[])`, [selected.objects])).map(x => x.link_type_id);
  selected.actions = (await rows(`SELECT action_type_id FROM action_type WHERE display_name ILIKE '[RSSB]%'`)).map(x => x.action_type_id);
  selected.legacyDatasets = (await rows(`SELECT DISTINCT dataset_id FROM backing_datasource WHERE object_type_id=ANY($1::uuid[]) AND dataset_id IS NOT NULL`, [selected.objects])).map(x => x.dataset_id);
  const specs = [
    ['resources', `parent_folder_rid=$1`, [rid('folder', SOURCE.folder)]],
    ['foundry_datasets', `id=ANY($1::uuid[])`, [selected.datasets]],
    ['dataset', `dataset_id=ANY($1::uuid[])`, [selected.legacyDatasets]],
    ['dataset_columns', `dataset_id=ANY($1::uuid[])`, [selected.legacyDatasets]],
    ['dataset_versions', `dataset_id=ANY($1::uuid[])`, [selected.legacyDatasets]],
    ['dataset_schema_version', `dataset_id=ANY($1::uuid[])`, [selected.legacyDatasets]],
    ['pipelines', `id=ANY($1::uuid[])`, [selected.pipelines]],
    ['pipeline_nodes', `pipeline_id=ANY($1::uuid[])`, [selected.pipelines]],
    ['pipeline_expectations', `pipeline_id=ANY($1::uuid[])`, [selected.pipelines]],
    ['pipeline_acl', `pipeline_id=ANY($1::uuid[])`, [selected.pipelines]],
    ['pipeline_cbac_rule', `pipeline_id=ANY($1::uuid[])`, [selected.pipelines]],
    ['code_repository', `rid=ANY($1::text[])`, [selected.repos]],
    ['coderepo_stemma_repo', `repository_rid=ANY($1::text[])`, [selected.repos]],
    ['coderepo_stemma_blob', `repository_rid=ANY($1::text[])`, [selected.repos]],
    ['coderepo_stemma_branch', `repository_rid=ANY($1::text[])`, [selected.repos]],
    ['code_repository_resource_imports', `repository_rid=ANY($1::text[])`, [selected.repos]],
    ['function_registry_function', `repository_rid=ANY($1::text[])`, [selected.repos]],
    ['function_registry_function_version', `function_rid IN (SELECT rid FROM function_registry_function WHERE repository_rid=ANY($1::text[]))`, [selected.repos]],
    ['function_version', `repository_rid=ANY($1::text[])`, [selected.repos]],
    ['job_spec', `repository_rid=ANY($1::text[])`, [selected.repos]],
    ['transform_build', `repository_rid=ANY($1::text[])`, [selected.repos]],
    ['transform_lineage', `repository_rid=ANY($1::text[])`, [selected.repos]],
    ['workshop_module', `rid=ANY($1::text[])`, [selected.workshops]],
    ['workshop_module_version', `rid=ANY($1::text[])`, [selected.workshops]],
    ['workshop_module_grants', `module_rid=ANY($1::text[])`, [selected.workshops]],
    ['object_type', `object_type_id=ANY($1::uuid[])`, [selected.objects]],
    ['property', `object_type_id=ANY($1::uuid[])`, [selected.objects]],
    ['backing_datasource', `object_type_id=ANY($1::uuid[])`, [selected.objects]],
    ['link_type', `link_type_id=ANY($1::uuid[])`, [selected.links]],
    ['action_type', `action_type_id=ANY($1::uuid[])`, [selected.actions]],
    ['action_type_definition_history', `action_type_id=ANY($1::uuid[])`, [selected.actions]],
    ['object_instances', `object_type_api_name IN (SELECT api_name FROM object_type WHERE object_type_id=ANY($1::uuid[]))`, [selected.objects]],
    ['object_rid_lookup', `object_type_api_name IN (SELECT api_name FROM object_type WHERE object_type_id=ANY($1::uuid[]))`, [selected.objects]],
    ['link_instances', `link_type_api_name IN (SELECT api_name FROM link_type WHERE link_type_id=ANY($1::uuid[]))`, [selected.links]],
  ];
  const tables = {};
  for (const [table, where, params] of specs) {
    const exists = await client.query(`SELECT to_regclass($1) IS NOT NULL ok`, [`public.${table}`]);
    if (exists.rows[0].ok) tables[table] = await rows(`SELECT * FROM ${table} WHERE ${where}`, params);
  }
  const sourceUsers = await rows(`SELECT id::text FROM users`);
  fs.writeFileSync(bundlePath, JSON.stringify({ version: 1, createdAt: new Date().toISOString(), source: SOURCE, target: TARGET, selected, sourceUsers: sourceUsers.map(x => x.id), tables }, null, 2));
  console.log(JSON.stringify(Object.fromEntries(Object.entries(tables).map(([k,v]) => [k,v.length])), null, 2));
} else if (mode === 'import') {
  const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
  const target = (await client.query(`SELECT p.owner_id FROM projects p JOIN folders f ON f.project_id=p.id WHERE p.id=$1 AND f.id=$2`, [TARGET.project, TARGET.folder])).rows[0];
  if (!target) throw new Error('Target project/folder does not exist');
  const replacements = new Map([
    [SOURCE.project, TARGET.project], [SOURCE.folder, TARGET.folder],
    [rid('project', SOURCE.project), rid('project', TARGET.project)],
    [rid('folder', SOURCE.folder), rid('folder', TARGET.folder)],
    ...bundle.sourceUsers.map(id => [id, target.owner_id]),
  ]);
  const remap = value => {
    if (typeof value === 'string') {
      let out = replacements.get(value) ?? value;
      out = out.replaceAll(SOURCE.project, TARGET.project).replaceAll(SOURCE.folder, TARGET.folder);
      return out;
    }
    if (Array.isArray(value)) return value.map(remap);
    if (value && typeof value === 'object' && !Buffer.isBuffer(value)) return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, remap(v)]));
    return value;
  };
  await client.query('BEGIN');
  try {
    const jsonColumns = new Map();
    const insert = async (table, inputRows, omit = []) => {
      if (!jsonColumns.has(table)) {
        const result = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND data_type IN ('json','jsonb')`, [table]);
        jsonColumns.set(table, new Set(result.rows.map(r => r.column_name)));
      }
      for (const raw of inputRows ?? []) {
        const row = remap(decode(raw)); for (const key of omit) delete row[key];
        const cols = Object.keys(row); const vals = cols.map(c => row[c] == null || !jsonColumns.get(table).has(c) ? row[c] : JSON.stringify(row[c]));
        const qcols = cols.map(c => `"${c}"`).join(',');
        await client.query(`INSERT INTO "${table}" (${qcols}) VALUES (${cols.map((_,i)=>`$${i+1}`).join(',')}) ON CONFLICT DO NOTHING`, vals);
      }
    };
    const order = ['resources','foundry_datasets','dataset','dataset_columns','dataset_versions','dataset_schema_version','pipelines','pipeline_nodes','pipeline_expectations','pipeline_acl','pipeline_cbac_rule','code_repository','coderepo_stemma_repo','coderepo_stemma_branch','coderepo_stemma_blob','code_repository_resource_imports','function_registry_function','function_registry_function_version','function_version','job_spec','transform_build','transform_lineage','workshop_module','workshop_module_version','workshop_module_grants'];
    for (const table of order) await insert(table, bundle.tables[table]);
    await insert('object_type', bundle.tables.object_type, ['primary_key_property_id','title_property_id']);
    await insert('property', bundle.tables.property);
    for (const raw of bundle.tables.object_type) { const row=decode(raw); await client.query(`UPDATE object_type SET primary_key_property_id=$2,title_property_id=$3 WHERE object_type_id=$1`,[row.object_type_id,row.primary_key_property_id,row.title_property_id]); }
    for (const table of ['backing_datasource','link_type','action_type','action_type_definition_history','object_instances','object_rid_lookup','link_instances']) await insert(table,bundle.tables[table]);
    await client.query('COMMIT');
    console.log('RSSB_BUNDLE_IMPORT_COMMITTED');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
} else throw new Error('Usage: migrate-rssb-bundle.mjs export|import bundle.json');
await client.end();
