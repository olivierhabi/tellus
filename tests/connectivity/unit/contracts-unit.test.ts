// ---------------------------------------------------------------------------
// Unit tests for src/services/connectivity/contracts.ts.
// Verifies:
//   - ConnectionRid / TableImportRid / DatasetRid / CompassFolderRid format guards.
//   - PostgresConfig defaults and bounds.
//   - ConnectionCreateRequest cross-field superRefine:
//       workerType=agentProxy requires agentGroupRid;
//       config.connectorType must match top-level connectorType.
//   - EgressPolicy.allowlist requires ≥1 entry.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  AgentGroupRid,
  CompassFolderRid,
  Connection,
  ConnectionConfig,
  ConnectionCreateRequest,
  ConnectionRid,
  DatasetRid,
  EgressPolicy,
  PostgresConfig,
  RestApiConfig,
  TableImportRid,
} from "../../../src/services/connectivity/contracts";

describe("RID format guards", () => {
  const goodConn = "ri.magritte.main.source.00000000-1111-2222-3333-444444444444";
  const badConn = "ri.foo.bar.source.x";

  it("ConnectionRid accepts spec-shaped RID", () => {
    expect(ConnectionRid.safeParse(goodConn).success).toBe(true);
  });
  it("ConnectionRid rejects malformed RID", () => {
    expect(ConnectionRid.safeParse(badConn).success).toBe(false);
  });
  it("TableImportRid requires the .extract. type segment", () => {
    expect(
      TableImportRid.safeParse(
        "ri.magritte.main.extract.00000000-1111-2222-3333-444444444444",
      ).success,
    ).toBe(true);
    expect(TableImportRid.safeParse(goodConn).success).toBe(false);
  });
  it("DatasetRid requires ri.foundry.main.dataset", () => {
    expect(
      DatasetRid.safeParse(
        "ri.foundry.main.dataset.00000000-1111-2222-3333-444444444444",
      ).success,
    ).toBe(true);
  });
  it("CompassFolderRid accepts any Compass container (folder/project/space)", () => {
    const uuid = "00000000-1111-2222-3333-444444444444";
    for (const seg of ["folder", "compass-folder", "project", "space"]) {
      expect(
        CompassFolderRid.safeParse(`ri.compass.main.${seg}.${uuid}`).success,
      ).toBe(true);
    }
    // Non-compass RIDs and non-container compass types are still rejected.
    expect(CompassFolderRid.safeParse(goodConn).success).toBe(false);
    expect(
      CompassFolderRid.safeParse(`ri.compass.main.dataset.${uuid}`).success,
    ).toBe(false);
  });
});

describe("PostgresConfig", () => {
  it("applies defaults for omitted fields", () => {
    const r = PostgresConfig.parse({
      host: "db.example.com",
      database: "tellus",
    });
    expect(r.port).toBe(5432);
    expect(r.tlsMode).toBe("verify-full");
    expect(r.connectTimeoutMs).toBe(5000);
    expect(r.socketTimeoutMs).toBe(60000);
    expect(r.applicationName).toBe("tellus-magritte");
  });
  it("rejects out-of-range port", () => {
    expect(
      PostgresConfig.safeParse({
        host: "x",
        database: "y",
        port: 70000,
      }).success,
    ).toBe(false);
  });
  it("rejects too-short timeout", () => {
    expect(
      PostgresConfig.safeParse({
        host: "x",
        database: "y",
        connectTimeoutMs: 10,
      }).success,
    ).toBe(false);
  });
});

describe("RestApiConfig", () => {
  it("accepts multiple HTTPS domains and secret-name references", () => {
    const result = RestApiConfig.parse({
      domains: [
        {
          baseUrl: "https://api.example.com/v1",
          port: 443,
          authentication: "bearer",
        },
        {
          baseUrl: "https://auth.example.com/oauth",
          port: 8443,
          authentication: "basic",
        },
      ],
      additionalSecretNames: ["clientId", "clientSecret"],
      apiName: "ExampleApi",
    });
    expect(result.domains).toHaveLength(2);
    expect(result.additionalSecretNames).toEqual(["clientId", "clientSecret"]);
  });

  it("rejects insecure HTTP domains, duplicates, and invalid secret names", () => {
    expect(
      RestApiConfig.safeParse({
        domains: [{ baseUrl: "http://api.example.com", port: 443 }],
      }).success,
    ).toBe(false);
    expect(
      RestApiConfig.safeParse({
        domains: [
          { baseUrl: "https://api.example.com/v1", port: 443 },
          { baseUrl: "https://api.example.com/v1", port: 443 },
        ],
      }).success,
    ).toBe(false);
    expect(
      RestApiConfig.safeParse({
        domains: [{ baseUrl: "https://api.example.com", port: 443 }],
        additionalSecretNames: ["invalid-name"],
      }).success,
    ).toBe(false);
  });
});

describe("EgressPolicy", () => {
  it("requires at least one allowlist entry", () => {
    expect(EgressPolicy.safeParse({ allowlist: [] }).success).toBe(false);
  });
  it("accepts a host entry", () => {
    expect(
      EgressPolicy.safeParse({
        allowlist: [{ kind: "host", host: "db.example.com", port: 5432 }],
      }).success,
    ).toBe(true);
  });
  it("accepts a cidr entry", () => {
    expect(
      EgressPolicy.safeParse({
        allowlist: [{ kind: "cidr", cidr: "10.0.0.0/8", port: 5432 }],
      }).success,
    ).toBe(true);
  });
});

describe("ConnectionCreateRequest cross-field validation", () => {
  const validPgConfig: any = {
    connectorType: "postgresql",
    postgres: { host: "db", database: "tellus" },
  };
  const validBase: any = {
    name: "my-source",
    connectorType: "postgresql",
    workerType: "foundryWorker",
    config: validPgConfig,
    egressPolicy: {
      allowlist: [{ kind: "host", host: "db", port: 5432 }],
    },
    compassFolderRid: "ri.compass.main.folder.00000000-1111-2222-3333-444444444444",
  };

  it("accepts a fully valid foundryWorker payload", () => {
    expect(ConnectionCreateRequest.safeParse(validBase).success).toBe(true);
  });

  it("accepts a REST API source with a matching config discriminator", () => {
    expect(
      ConnectionCreateRequest.safeParse({
        ...validBase,
        connectorType: "rest-api",
        config: {
          connectorType: "rest-api",
          restApi: {
            domains: [
              {
                baseUrl: "https://api.example.com/v1",
                port: 443,
                authentication: "bearer",
              },
            ],
            additionalSecretNames: ["accessToken"],
            apiName: "ExampleApi",
          },
        },
        egressPolicy: {
          allowlist: [
            { kind: "host", host: "api.example.com", port: 443 },
          ],
        },
      }).success,
    ).toBe(true);
  });

  it("rejects agentProxy without agentGroupRid", () => {
    const r = ConnectionCreateRequest.safeParse({
      ...validBase,
      workerType: "agentProxy",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) => i.path.join(".") === "agentGroupRid"),
      ).toBe(true);
    }
  });

  it("accepts agentProxy with agentGroupRid", () => {
    expect(
      ConnectionCreateRequest.safeParse({
        ...validBase,
        workerType: "agentProxy",
        agentGroupRid: "ri.magritte.main.agent-group.00000000-1111-2222-3333-444444444444",
      }).success,
    ).toBe(true);
  });

  it("rejects when config.connectorType mismatches top-level", () => {
    // top-level is 'postgresql', config uses a fictional 'mysql' — fail.
    const r = ConnectionCreateRequest.safeParse({
      ...validBase,
      config: { connectorType: "mysql", postgres: { host: "x", database: "y" } } as any,
    });
    expect(r.success).toBe(false);
  });

  it("rejects too-long name", () => {
    expect(
      ConnectionCreateRequest.safeParse({
        ...validBase,
        name: "a".repeat(200),
      }).success,
    ).toBe(false);
  });

  it("rejects name with leading digit", () => {
    expect(
      ConnectionCreateRequest.safeParse({
        ...validBase,
        name: "1bad",
      }).success,
    ).toBe(false);
  });
});

describe("ConnectionConfig discriminator", () => {
  it("rejects unknown connectorType", () => {
    expect(
      ConnectionConfig.safeParse({
        connectorType: "unknown" as any,
        postgres: { host: "x", database: "y" },
      }).success,
    ).toBe(false);
  });
  it("accepts postgresql discriminator", () => {
    expect(
      ConnectionConfig.safeParse({
        connectorType: "postgresql",
        postgres: { host: "x", database: "y" },
      }).success,
    ).toBe(true);
  });
  it("accepts REST API discriminator", () => {
    expect(
      ConnectionConfig.safeParse({
        connectorType: "rest-api",
        restApi: {
          domains: [
            {
              baseUrl: "https://api.example.com/v1",
              port: 443,
              authentication: "bearer",
            },
          ],
          additionalSecretNames: ["accessToken"],
          apiName: "ExampleApi",
        },
      }).success,
    ).toBe(true);
  });
});

describe("Connection full schema", () => {
  it("parses a fully populated Connection", () => {
    const conn = {
      rid: "ri.magritte.main.source.00000000-1111-2222-3333-444444444444",
      tenant: "t1",
      name: "my-source",
      description: "",
      connectorType: "postgresql",
      workerType: "foundryWorker",
      config: {
        connectorType: "postgresql",
        postgres: {
          host: "db",
          port: 5432,
          database: "tellus",
          applicationName: "tellus-magritte",
          tlsMode: "verify-full",
          clientKeyEncrypted: false,
          connectTimeoutMs: 5000,
          socketTimeoutMs: 60000,
          extraParams: {},
        },
      },
      egressPolicy: { allowlist: [{ kind: "host", host: "db", port: 5432 }] },
      compassFolderRid:
        "ri.compass.main.folder.00000000-1111-2222-3333-444444444444",
      status: { state: "UNKNOWN", lastCheckedAt: null, details: {} },
      version: 1,
      createdAt: "2026-05-18T12:00:00.000Z",
      createdBy: "00000000-1111-2222-3333-444444444444",
      updatedAt: "2026-05-18T12:00:00.000Z",
      updatedBy: "00000000-1111-2222-3333-444444444444",
    };
    expect(Connection.safeParse(conn).success).toBe(true);
  });
});

void AgentGroupRid; // satisfy unused import for forward-coverage scope.
