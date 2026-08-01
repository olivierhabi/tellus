#!/usr/bin/env tsx

import fs from "fs";
import path from "path";
import { Worker } from "@temporalio/worker";

const historyFile = process.argv[2];
if (!historyFile) throw new Error("usage: replay-funnel-histories <history-file>");

async function main(): Promise<void> {
  const fixtureDir = path.dirname(historyFile);
  const file = path.basename(historyFile);
  const history = JSON.parse(fs.readFileSync(historyFile, "utf8"));
  await Worker.runReplayHistory(
    {
      workflowsPath: path.resolve(
        fixtureDir,
        file.includes("funnel")
          ? "../../../../src/services/funnel/temporal/workflowsBundle.ts"
          : "../../../../scripts/temporal-probe/workflowBundle.ts",
      ),
    } as never,
    history,
  );
  console.log(`replayed ${file}`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
