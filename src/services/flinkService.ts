/**
 * Flink JobManager REST client.
 *
 * Backend-side wrapper for the streaming-compute layer. Today we only
 * need read APIs (cluster overview, task managers, jobs) so the UI can
 * render the Funnel streaming pipeline view. Future iterations will
 * submit Flink SQL jobs via the same client.
 */

const FLINK_URL = process.env.FLINK_URL || "http://localhost:8083";

export interface FlinkOverview {
  taskmanagers: number;
  slotsTotal: number;
  slotsAvailable: number;
  jobsRunning: number;
  jobsFinished: number;
  jobsCancelled: number;
  jobsFailed: number;
  flinkVersion: string;
  flinkCommit: string;
}

export async function getFlinkOverview(): Promise<FlinkOverview> {
  const res = await fetch(`${FLINK_URL}/overview`);
  if (!res.ok) throw new Error(`flink /overview ${res.status}`);
  const json = (await res.json()) as Record<string, unknown>;
  return {
    taskmanagers: json["taskmanagers"] as number,
    slotsTotal: json["slots-total"] as number,
    slotsAvailable: json["slots-available"] as number,
    jobsRunning: json["jobs-running"] as number,
    jobsFinished: json["jobs-finished"] as number,
    jobsCancelled: json["jobs-cancelled"] as number,
    jobsFailed: json["jobs-failed"] as number,
    flinkVersion: json["flink-version"] as string,
    flinkCommit: json["flink-commit"] as string,
  };
}

export interface FlinkTaskManager {
  id: string;
  slotsNumber: number;
  freeSlots: number;
  cpuCores: number;
  totalMemoryMb: number;
}

export async function getFlinkTaskManagers(): Promise<FlinkTaskManager[]> {
  const res = await fetch(`${FLINK_URL}/taskmanagers`);
  if (!res.ok) throw new Error(`flink /taskmanagers ${res.status}`);
  const json = (await res.json()) as { taskmanagers: any[] };
  return (json.taskmanagers ?? []).map((tm) => ({
    id: tm.id,
    slotsNumber: tm.slotsNumber,
    freeSlots: tm.freeSlots,
    cpuCores: tm.hardware?.cpuCores ?? 0,
    totalMemoryMb: tm.hardware?.physicalMemory
      ? Math.round(tm.hardware.physicalMemory / (1024 * 1024))
      : 0,
  }));
}

export async function listFlinkJobs(): Promise<{ jobs: { id: string; status: string }[] }> {
  const res = await fetch(`${FLINK_URL}/jobs`);
  if (!res.ok) throw new Error(`flink /jobs ${res.status}`);
  const json = (await res.json()) as { jobs?: { id: string; status: string }[] };
  return { jobs: json.jobs ?? [] };
}
