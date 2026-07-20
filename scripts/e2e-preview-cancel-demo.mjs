// Live end-to-end demo: FE Stop → backend req.on('close') → server-side kill.
// Uses node's http module + req.destroy() to abort (closes the socket — the
// same mechanism axios uses in the real FE). pgrep-verifies the backend driver
// is GONE after Stop, not just that the request was aborted client-side.
import http from "http";
import { execSync } from "child_process";

const BASE_HOST = "localhost";
const PORT = 3000;
const RID = "ri.stemma.main.repository.055419ff-9dc1-4328-b731-1757dea114f2";
const ENTRY = "lightweight_transform";
const FILE = "src/transform-05/datasets/lightweight_transform.py";
const SLEEP_PY = `from transforms.api import transform_pandas, Output, Input
import time
@transform_pandas(
    output=Output("ri.foundry.main.dataset.5786dafb-265a-47b6-a92f-a5bc6af7a9b9"),
    orders=Input("ri.foundry.main.dataset.c3a54ed5-19a3-4394-a66b-7e8b0d5dee95"),
)
def lightweight_transform(ctx, orders):
    time.sleep(180)
    return orders.pandas()
`;

function pgrep() {
  try { return execSync("pgrep -f 'tellus-transform-'", { encoding: "utf8" }).trim(); } catch { return ""; }
}

// 1. login-bypass → superadmin token
const loginResp = await fetch(`http://${BASE_HOST}:${PORT}/api/v1/auth/_test/login-bypass`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Tellus-Test-Hook": "1" },
  body: JSON.stringify({ username: "cypress@tellus.local", password: "Password123!" }),
});
const login = await loginResp.json();
const token = login?.data?.accessToken;
if (!token) { console.error("no token:", JSON.stringify(login).slice(0, 200)); process.exit(1); }
console.log("token: ok");

// 2. kick the preview (sleeping transform) via http — keep the socket handle to abort.
const body = JSON.stringify({ branch: "main", entryPoint: ENTRY, fileOverrides: { [FILE]: SLEEP_PY } });
const httpReq = http.request({
  host: BASE_HOST, port: PORT,
  path: `/api/v1/code-repositories/${RID}/transforms/preview`,
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "Content-Length": Buffer.byteLength(body) },
});
let settledRaw = "";
httpReq.on("response", (res) => { res.on("data", (c) => { settledRaw += c; }); res.on("end", () => { settledRaw = settledRaw.slice(0, 120); }); });
httpReq.on("error", (e) => { settledRaw = `error: ${String(e).slice(0, 120)}`; });
httpReq.write(body);
httpReq.end();

// 3. poll until the driver process is alive (input staging may take a few s)
let alive = "";
for (let i = 0; i < 60 && !alive; i++) {
  alive = pgrep();
  if (!alive) await new Promise((r) => setTimeout(r, 500));
}
console.log("driver process BEFORE abort (pgrep -f tellus-transform-):", alive || "(NOT FOUND)");

if (!alive) {
  httpReq.destroy();
  console.error("driver never started — preview settled early:", settledRaw.slice(0, 200));
  process.exit(2);
}

// 4. FE Stop — req.destroy() closes the socket → backend req.on('close') → kill
httpReq.destroy();
await new Promise((r) => setTimeout(r, 4000)); // close-detection + SIGTERM(+5s SIGKILL backstop)

// 5. pgrep again — expect GONE
const after = pgrep();
console.log("driver process AFTER abort  (pgrep -f tellus-transform-):", after || "(GONE — cancelled server-side)");

process.exit(after ? 3 : 0);
