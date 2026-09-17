// F8 — integration tests for the WebSocket gateway.
// Covers:
//   F8 C-01  WS path + auth via Sec-WebSocket-Protocol (or x-test-user in tests)
//   F8 C-03  inbound appliedInstruction event delivery
//   F8 C-04  outbound durable mutations go over HTTP, presence over WS
//   B3 C-11  WS endpoint upgrades on /quiver/api/v1/analyses/{rid}/stream
//   B3 C-12  rejected without token (close code 4001 / 401)
//   B3 C-13  presence broadcast across peers; ephemeral

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import { AddressInfo } from "node:net";
import WebSocket from "ws";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { pool } from "../../../src/db";
import { applyQuiverMigrations, quiverApp, teardownQuiverTables } from "./_harness";
import { attachQuiverWs } from "../../../src/services/quiver/ot/wsGateway";

const TEST_USER = "ri.multipass.main.user.alice";
const PEER_USER = "ri.multipass.main.user.bob";
const TEST_ORG = "ri.multipass.main.org.acme";

beforeAll(async () => {
  process.env.QUIVER_ALLOW_TEST_AUTH = "1";
  process.env.TELLUS_QUIVER_PHASE = "5";
  await applyQuiverMigrations();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await teardownQuiverTables();
});

interface RunningServer {
  url: string;
  wsUrl: string;
  close: () => Promise<void>;
  app: ReturnType<typeof quiverApp>;
}

async function startServer(): Promise<RunningServer> {
  const app = quiverApp();
  const httpSrv = http.createServer(app);
  const ws = attachQuiverWs(httpSrv);
  await new Promise<void>((resolve) => httpSrv.listen(0, "127.0.0.1", resolve));
  const port = (httpSrv.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
    app,
    async close() {
      await ws.close();
      await new Promise<void>((resolve) => httpSrv.close(() => resolve()));
    },
  };
}

async function createAnalysisHttp(srv: RunningServer): Promise<{ rid: string }> {
  const r = await request(srv.url)
    .post("/quiver/api/v1/analyses")
    .set({
      "x-test-user": TEST_USER,
      "X-Tellus-Test-Auth-Token": process.env.CODE_REPOS_TEST_AUTH_TOKEN ?? "",
      "x-test-org": TEST_ORG,
      "idempotency-key": randomUUID(),
    })
    .send({ parentFolderRid: "ri.compass.main.folder.f1", displayName: "F8 test" });
  expect(r.status).toBe(201);
  return { rid: r.body.rid };
}

async function waitForOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (e) => reject(e));
  });
}

async function nextMessage(ws: WebSocket, timeoutMs: number = 1500): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("ws timeout")), timeoutMs);
    ws.once("message", (data) => {
      clearTimeout(t);
      try {
        resolve(JSON.parse(data.toString("utf8")));
      } catch (e) {
        reject(e);
      }
    });
  });
}

describe("F8 / B3 — WebSocket gateway", () => {
  it("F8 C-01 + B3 C-11 — connects on /quiver/api/v1/analyses/:rid/stream", async () => {
    const srv = await startServer();
    try {
      const { rid } = await createAnalysisHttp(srv);
      const ws = new WebSocket(`${srv.wsUrl}/quiver/api/v1/analyses/${rid}/stream`, {
        headers: { "x-test-user": TEST_USER, "X-Tellus-Test-Auth-Token": process.env.CODE_REPOS_TEST_AUTH_TOKEN ?? "" },
      });
      await waitForOpen(ws);
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    } finally {
      await srv.close();
    }
  });

  it("B3 C-12 — without test user, upgrade is rejected (401)", async () => {
    const srv = await startServer();
    try {
      // Create with auth enabled.
      const { rid } = await createAnalysisHttp(srv);
      // Disable test auth so the WS upgrade has no resolvable user.
      process.env.QUIVER_ALLOW_TEST_AUTH = "0";
      await new Promise<void>((resolve) => {
        const ws = new WebSocket(
          `${srv.wsUrl}/quiver/api/v1/analyses/${rid}/stream`,
        );
        ws.once("error", () => resolve());
        ws.once("unexpected-response", (_req, res) => {
          expect(res.statusCode).toBe(401);
          ws.terminate();
          resolve();
        });
      });
    } finally {
      process.env.QUIVER_ALLOW_TEST_AUTH = "1";
      await srv.close();
    }
  });

  it("B3 C-12b — untokened x-test-user on upgrade is rejected (401)", async () => {
    const srv = await startServer();
    try {
      const { rid } = await createAnalysisHttp(srv);
      await new Promise<void>((resolve) => {
        const ws = new WebSocket(
          `${srv.wsUrl}/quiver/api/v1/analyses/${rid}/stream`,
          { headers: { "x-test-user": TEST_USER } },
        );
        ws.once("error", () => resolve());
        ws.once("unexpected-response", (_req, res) => {
          expect(res.statusCode).toBe(401);
          ws.terminate();
          resolve();
        });
      });
    } finally {
      await srv.close();
    }
  });

  it("F8 C-03 + B3 C-11 — receives appliedInstruction when peer submits over HTTP", async () => {
    const srv = await startServer();
    try {
      const { rid } = await createAnalysisHttp(srv);
      const ws = new WebSocket(`${srv.wsUrl}/quiver/api/v1/analyses/${rid}/stream`, {
        headers: { "x-test-user": TEST_USER, "X-Tellus-Test-Auth-Token": process.env.CODE_REPOS_TEST_AUTH_TOKEN ?? "" },
      });
      await waitForOpen(ws);
      const messageP = nextMessage(ws);

      // Peer submits an instruction over HTTP (F8 C-04: durable over HTTP).
      const r = await request(srv.url)
        .post(`/quiver/api/v1/analyses/${rid}/instructions`)
        .set({ "x-test-user": PEER_USER, "x-test-org": TEST_ORG, "X-Tellus-Test-Auth-Token": process.env.CODE_REPOS_TEST_AUTH_TOKEN ?? "" })
        .send({
          baseVersion: 0,
          clientOpIds: [randomUUID()],
          instructions: [
            { kind: "addCard", card: { id: "$A", type: "OBJECT_SET", inputs: {}, config: {}, hidden: false } },
          ],
        });
      expect(r.status).toBe(200);

      const msg = await messageP;
      expect(msg.kind).toBe("appliedInstruction");
      expect(msg.rid).toBe(rid);
      expect(msg.appliedBy).toBe(PEER_USER);
      expect(msg.instructionType).toBe("addCard");
      ws.close();
    } finally {
      await srv.close();
    }
  });

  it("B3 C-13 — presence broadcast: peer A sees peer B's cursor", async () => {
    const srv = await startServer();
    try {
      const { rid } = await createAnalysisHttp(srv);
      const wsA = new WebSocket(`${srv.wsUrl}/quiver/api/v1/analyses/${rid}/stream`, {
        headers: { "x-test-user": TEST_USER, "X-Tellus-Test-Auth-Token": process.env.CODE_REPOS_TEST_AUTH_TOKEN ?? "" },
      });
      const wsB = new WebSocket(`${srv.wsUrl}/quiver/api/v1/analyses/${rid}/stream`, {
        headers: { "x-test-user": PEER_USER, "X-Tellus-Test-Auth-Token": process.env.CODE_REPOS_TEST_AUTH_TOKEN ?? "" },
      });
      await Promise.all([waitForOpen(wsA), waitForOpen(wsB)]);

      const recvA = nextMessage(wsA, 2000);
      // B sends a presence update; A should receive it.
      wsB.send(
        JSON.stringify({
          kind: "presenceUpdate",
          cursor: { x: 100, y: 200 },
          selectedCardIds: ["$A"],
        }),
      );
      const msg = await recvA;
      expect(msg.kind).toBe("presenceUpdate");
      expect(msg.userSubject).toBe(PEER_USER);
      expect(msg.cursor).toEqual({ x: 100, y: 200 });
      expect(msg.selectedCardIds).toEqual(["$A"]);
      wsA.close();
      wsB.close();
    } finally {
      await srv.close();
    }
  });
});
