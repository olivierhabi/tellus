import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { parse } from "csv-parse";

const client = new S3Client({
  endpoint: "http://localhost:9000",
  region: "us-east-1",
  forcePathStyle: true,
  credentials: { accessKeyId: "tellus-s3-49f524d9", secretAccessKey: "kYJtYYunruhlPtOow9PD5FyRa36BXPM" },
});
const Key = "projects/36271681-65d7-4c55-a6d0-20137f8212dc/folders/26a9aff1-2cbd-4437-8b76-940d67012041/f0880128-d9bf-4030-a604-a1e3b846700c_orders_bureau_transactional_system.part01.csv";

const r = await client.send(new GetObjectCommand({ Bucket: "tellus-uploads", Key }));
const stream = r.Body;
const parser = parse({ columns: true, skip_empty_lines: true, relax_column_count: true, trim: true });

let total = 0, dupCount = 0, distinct = 0;
const seen = new Set();
const samples = [];
const firstDupRows = [];
let orderCol = "order_id";

stream.pipe(parser);
for await (const row of parser) {
  if (total === 0) orderCol = (row.order_id !== undefined) ? "order_id" : Object.keys(row)[0];
  const pk = row[orderCol];
  total++;
  if (seen.has(pk)) {
    dupCount++;
    if (samples.length < 3) { samples.push(pk); firstDupRows.push({ dup: row, }); }
  } else { seen.add(pk); distinct++; }
}
console.log("column used as PK:", orderCol);
console.log("total rows:", total);
console.log("distinct PKs:", distinct);
console.log("duplicate occurrences (rows whose PK seen before):", dupCount);
console.log("sample dup PKs:", samples.slice(0,3));
