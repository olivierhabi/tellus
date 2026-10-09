// Global setup for vitest.funnel-oop.config.ts: lane identity first, then
// database bootstrap only (migrations + seal; Temporal is optional).
import "../laneEnv";
import { bootstrapTestStack } from "../testStackBootstrap";

export async function setup(): Promise<void> {
  await bootstrapTestStack();
}
