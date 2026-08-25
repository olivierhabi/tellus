import "dotenv/config";
import { recordProgress, readProgress } from "../src/services/uploadProgress";
(async () => {
  console.log("REDIS_URL:", process.env.REDIS_URL || "(unset)");
  const id = "test-" + Date.now();
  await recordProgress(id, { phase: "s3", loaded: 42, total: 100, fileIndex: 0, fileName: "x.csv" });
  const p = await readProgress(id);
  console.log("readBack:", JSON.stringify(p));
  if (p && p.loaded === 42) console.log("RESULT: OK — uploadProgress talks to Redis");
  else console.log("RESULT: FAIL — recordProgress did not write (getRedis fail-open?)");
})();
