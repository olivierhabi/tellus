#!/usr/bin/env tsx
// ---------------------------------------------------------------------------
// temporal-versioning — ops CLI for the queue's Build-ID routing rules
// (FUNN-ISO-3 worker versioning on server 1.25 task-queue rules).
//
// Subcommands:
//   status   --queue Q [-n NS]                      dump assignment+redirect
//                                                    rules + current pollers
//   promote  --queue Q --build ID [--ramp PCT]
//            [--compatible-with OLD_ID]             insert assignment rule for
//                                                    the new build (ramp % of
//                                                    NEW executions); with
//                                                    --compatible-with also
//                                                    add a redirect rule
//                                                    OLD→new (declares the
//                                                    lineage compatible)
//   rollback --queue Q --build OLD_ID               restore the previous build
//                                                    to the first assignment
//                                                    slot (in-flight pinned
//                                                    runs keep their build)
//   drain-audit --queue Q                           show which builds still own
//                                                    OPEN workflow pollers
//                                                    (required before a build's
//                                                    worker is retired)
//
// The CLI is shell-invocable so it works identically in dev (docker exec
// into the temporal container) and CI/prod (host temporal binary present).
// ---------------------------------------------------------------------------

import { spawnSync } from "child_process";

interface CliRunner {
  run: (args: string[]) => { status: number; stdout: string; stderr: string };
  label: string;
}

function discoverRunner(): CliRunner {
  // Inside the auto-setup container the server binds to the container's
  // own address — existing stack scripts use --address temporal:7233.
  const host = spawnSync("temporal", ["--version"], { encoding: "utf8" });
  if (host.status === 0) {
    return { label: "host temporal binary", run: (args) => spawnSync("temporal", ["--address", "localhost:7233", ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }) };
  }
  const container = process.env.TEMPORAL_CLI_CONTAINER || "tellus-temporal-1";
  const probe = spawnSync("docker", ["exec", container, "temporal", "--version"], { encoding: "utf8" });
  if (probe.status === 0) {
    return {
      label: `docker exec ${container} temporal`,
      run: (args) => spawnSync("docker", ["exec", container, "temporal", "--address", "temporal:7233", ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }),
    };
  }
  throw new Error(
    "no temporal CLI found: install the host `temporal` binary or start the " +
      "dev container (TEMPORAL_CLI_CONTAINER env override available).",
  );
}

function parseArgs(argv: string[]): { cmd: string; flags: Record<string, string | true> } {
  const [cmd, ...rest] = argv;
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }
  return { cmd, flags };
}

function rq(runner: CliRunner, args: string[]): string {
  const r = runner.run(args);
  if (r.status !== 0) {
    throw new Error(`temporal ${args.join(" ")} failed:\n${r.stderr || r.stdout}`);
  }
  return (r.stdout ?? "").toString();
}

function main(): void {
  const { cmd, flags } = parseArgs(process.argv.slice(2));
  const queue = flags.queue as string | undefined;
  const ns = (flags.n as string) || "default";
  if (!queue) {
    console.error("usage: temporal-versioning {status|promote|rollback|drain-audit} --queue <taskQueue> [flags]");
    process.exit(2);
  }
  const runner = discoverRunner();
  console.error(`[versioning] runner: ${runner.label}`);

  switch (cmd) {
    case "status": {
      console.log(
        rq(runner, ["task-queue", "versioning", "get-rules", "-t", queue, "-n", ns, "-o", "json"]),
      );
      console.log(
        rq(runner, ["task-queue", "describe", "-t", queue, "-n", ns, "-o", "json"]),
      );
      return;
    }
    case "promote": {
      const build = flags.build as string;
      if (!build) throw new Error("promote requires --build");
      const ramp = (flags.ramp as string) || "100";
      console.log(
        rq(runner, [
          "task-queue", "versioning", "insert-assignment-rule",
          "-t", queue, "-n", ns,
          "--build-id", build,
          "--rule-index", "0",
          "--percentage", ramp,
          "-y",
        ]),
      );
      const compatWith = flags["compatible-with"] as string | undefined;
      if (compatWith) {
        console.log(
          rq(runner, [
            "task-queue", "versioning", "add-redirect-rule",
            "-t", queue, "-n", ns,
            "--source-build-id", compatWith,
            "--target-build-id", build,
            "-y",
          ]),
        );
      }
      console.log(`[versioning] promoted build ${build} on ${queue} (ramp=${ramp}${compatWith ? `, redirect ${compatWith}→${build}` : ""})`);
      return;
    }
    case "rollback": {
      const build = flags.build as string;
      if (!build) throw new Error("rollback requires --build");
      console.log(
        rq(runner, [
          "task-queue", "versioning", "insert-assignment-rule",
          "-t", queue, "-n", ns,
          "--build-id", build,
          "--rule-index", "0",
          "-y",
        ]),
      );
      console.log(`[versioning] rolled back ${queue} first assignment slot to ${build} — in-flight pinned executions keep their pinned builds`);
      return;
    }
    case "drain-audit": {
      const rules = rq(runner, ["task-queue", "versioning", "get-rules", "-t", queue, "-n", ns, "-o", "json"]);
      const desc = rq(runner, ["task-queue", "describe", "-t", queue, "-n", ns, "-o", "json"]);
      process.stdout.write(JSON.stringify({ queue, namespace: ns, rules: JSON.parse(rules), pollers: JSON.parse(desc) }, null, 2) + "\n");
      return;
    }
    default:
      console.error(`unknown subcommand '${cmd}'`);
      process.exit(2);
  }
}

main();
