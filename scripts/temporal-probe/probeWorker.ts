// Single versioned probe worker — one build id per process. Each executed
// workflow's receipt is recorded by an ACTIVITY (runs in this Node process,
// outside the workflow sandbox) appending to <out>/<buildId>.log.
//
//   tsx scripts/temporal-probe/probeWorker.ts --build probe-a --queue Q \
//       --namespace N --out /tmp/versioning-probe
import fs from "fs";
import path from "path";
import { NativeConnection, Worker } from "@temporalio/worker";

function flag(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

async function main(): Promise<void> {
  const buildId = flag("build", `probe-${process.pid}`);
  const queue = flag("queue", "funniso-versioning-probe");
  const namespace = flag("namespace", "default");
  const out = flag("out", "/tmp/versioning-probe");
  fs.mkdirSync(out, { recursive: true });

  const recordReceipt = async (wfId: string): Promise<void> => {
    fs.appendFileSync(
      path.join(out, `${buildId}.log`),
      JSON.stringify({ wf: wfId, build: buildId, pid: process.pid, at: new Date().toISOString() }) + "\n",
    );
  };

  const worker = await Worker.create({
    connection: await NativeConnection.connect({ address: "localhost:7233" }),
    namespace,
    taskQueue: queue,
    identity: `versioning-probe:${buildId}:${process.pid}`,
    buildId,
    useVersioning: true,
    workflowsPath: require.resolve("./workflowBundle"),
    activities: { recordReceipt },
  });
  console.log(JSON.stringify({ type: "probe_worker_ready", buildId, queue, namespace }));
  await worker.run();
}

void main();
