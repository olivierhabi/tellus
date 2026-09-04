const k = require('knex')({ client: 'pg', connection: process.env.POSTGRES_URL });
(async () => {
  const tables = await k.raw(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND (table_name ILIKE '%audit%' OR table_name ILIKE '%history%')`,
  );
  console.log('candidate tables:', tables.rows.map(r => r.table_name).join(', '));
  const names = tables.rows.map(r => r.table_name);
  for (const t of names) {
    try {
      const hasCreated = (await k(t).columnInfo()).created_at;
      const q = k(t).orderBy(hasCreated ? 'created_at' : 'id', 'desc').limit(3);
      const rows = await q;
      const recent = rows.filter(r => (hasCreated && new Date(r.created_at).getTime() > Date.now() - 60 * 60 * 1000));
      if (recent.length) {
        console.log(`\n== ${t} (recent hour) ==`);
        for (const r of recent) console.log(JSON.stringify(r).slice(0, 800));
      }
    } catch (e) { /* skip */ }
  }
  await k.destroy();
})().catch(e => { console.error(e.message); process.exit(1); });
