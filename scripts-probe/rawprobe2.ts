const main = async () => {
  const auth = "Basic " + Buffer.from("tellus:tellus_ch_pw").toString("base64");
  const u = new URL("http://localhost:8123");
  u.searchParams.set("database", "osv2_serving");
  const post = async (sql: string) => {
    const r = await fetch(u.toString(), { method: "POST", body: sql, headers: { Authorization: auth } });
    return `${r.status} ${await r.text()}`;
  };
  console.log("show-tables:", await post(`SHOW TABLES FORMAT JSONEachRow`));
  console.log("create:", await post(`CREATE TABLE IF NOT EXISTS q_probe (a UInt64) ENGINE=MergeTree ORDER BY a`));
  console.log("show-tables2:", await post(`SHOW TABLES FORMAT JSONEachRow`));
  console.log("system-tables:", await post(`SELECT name, database FROM system.tables WHERE lower(name) LIKE '%probe%' FORMAT JSONEachRow`));
};
main();
