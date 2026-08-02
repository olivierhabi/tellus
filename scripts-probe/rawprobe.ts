const main = async () => {
  const url = new URL("http://localhost:8123");
  url.searchParams.set("database", "osv2_serving");
  url.searchParams.set("query", "SELECT name FROM system.tables WHERE name LIKE 'a_%' FORMAT JSONEachRow");
  const auth = "Basic " + Buffer.from("tellus:tellus_ch_pw").toString("base64");
  const r = await fetch(url.toString(), { headers: { Authorization: auth } });
  console.log("GET query param:", r.status, await r.text());
  const r2 = await fetch("http://localhost:8123/?database=osv2_serving", { method: "POST", body: "SELECT 1", headers: { Authorization: auth } });
  console.log("POST body-select:", r2.status, await r2.text());
};
main();
