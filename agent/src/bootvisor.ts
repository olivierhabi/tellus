// ---------------------------------------------------------------------------
// B6 — Agent bootvisor (spec §B6 line 305).
//
// Supervisor process that:
//   1. Loads /etc/tellus/agent/allowlist.yml (refuses to start if mode/owner
//      incorrect — criterion from §6 of the prompt).
//   2. Parses agent.yml for {coordinatorUrl, agentId, group, token}.
//   3. Starts the reconnecting WSS client.
//   4. Wires a TcpBridge bound to the client + allowlist.
//   5. On SIGTERM, gracefully drains tunnels (5s for tests; prod 60s via env).
//
// This file's `main()` is the entry point bundled by `pkg`. For tests, the
// individual pieces are exported and can be wired manually with stubbed
// dependencies.
// ---------------------------------------------------------------------------

import { promises as fs } from "node:fs";
import {
  loadAllowlist,
  AgentAllowlistMisconfigured,
  type Allowlist,
} from "./allowlist";
import { WsClient, type AgentIdentity } from "./tunnel/ws-client";
import { TcpBridge } from "./proxy/tcp-bridge";

const DRAIN_MS = Number(process.env.TELLUS_AGENT_DRAIN_MS ?? 5_000);
const AGENT_CONFIG_PATH =
  process.env.TELLUS_AGENT_CONFIG ?? "/etc/tellus/agent/agent.yml";

export interface AgentConfig {
  coordinatorUrl: string;
  agentId: string;
  group: string;
  version: string;
  /** Joining token; deferred-signing replaces this in v1.1. */
  token: string;
}

export async function loadConfig(path = AGENT_CONFIG_PATH): Promise<AgentConfig> {
  const raw = await fs.readFile(path, "utf8");
  return parseAgentYaml(raw);
}

export function parseAgentYaml(raw: string): AgentConfig {
  const cfg: Partial<AgentConfig> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*(\w+)\s*:\s*(.+?)\s*$/);
    if (!m) continue;
    const k = m[1];
    const v = m[2].replace(/^['"]|['"]$/g, "").replace(/#.*$/, "").trim();
    (cfg as any)[k] = v;
  }
  if (!cfg.coordinatorUrl || !cfg.agentId || !cfg.group || !cfg.token) {
    throw new Error(
      `agent config missing required fields (coordinatorUrl, agentId, group, token); got ${JSON.stringify(cfg)}`,
    );
  }
  cfg.version = cfg.version ?? "0.0.0-dev";
  return cfg as AgentConfig;
}

export interface RunningAgent {
  ws: WsClient;
  bridge: TcpBridge;
  stop(): Promise<void>;
}

export async function bootAgent(
  cfg: AgentConfig,
  allow: Allowlist,
): Promise<RunningAgent> {
  const identity: AgentIdentity = {
    agentId: cfg.agentId,
    version: cfg.version,
    tags: { group: cfg.group },
  };
  const ws = new WsClient(cfg.coordinatorUrl, identity);
  const bridge = new TcpBridge(ws, allow);
  await ws.start();
  return {
    ws,
    bridge,
    async stop() {
      bridge.closeAll();
      ws.stop();
      // Allow in-flight close frames to flush.
      await new Promise<void>((r) => setTimeout(r, DRAIN_MS));
    },
  };
}

async function main(): Promise<number> {
  try {
    const cfg = await loadConfig();
    const allow = await loadAllowlist();
    const running = await bootAgent(cfg, allow);
    const stop = async (sig: NodeJS.Signals) => {
      // eslint-disable-next-line no-console
      console.error(`[tellus-agent] received ${sig}, draining`);
      await running.stop();
      process.exit(0);
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    // Block forever.
    await new Promise(() => {
      /* never */
    });
    return 0;
  } catch (err) {
    if (err instanceof AgentAllowlistMisconfigured) {
      // eslint-disable-next-line no-console
      console.error(`[tellus-agent] FATAL: ${err.message}`);
      return 78; // EX_CONFIG
    }
    // eslint-disable-next-line no-console
    console.error(`[tellus-agent] FATAL: ${(err as Error).message}`);
    return 1;
  }
}

if (require.main === module) {
  main().then((c) => process.exit(c));
}
