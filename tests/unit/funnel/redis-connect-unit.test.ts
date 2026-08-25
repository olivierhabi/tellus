// ---------------------------------------------------------------------------
// connectRedisBounded / boundedReconnectStrategy — pure unit tests.
//
// These two functions exist because the funnel's Redis callers used to HANG
// rather than fail when Redis was down or frozen: node-redis' default numeric
// reconnect strategy retries forever, so `connect()` never settles and the
// merge checkpoint write blocked its stage indefinitely. What has to hold:
//
//   • the strategy eventually returns `false` (the only return value that makes
//     node-redis settle the pending connect with an error),
//   • `connectRedisBounded` rejects on the wall-clock deadline even when
//     `connect()` never settles, and tears the socket down so no background
//     reconnect loop or open handle survives a failed attempt.
//
// The `redis` package is mocked, so nothing here touches a real server.
// ---------------------------------------------------------------------------

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

let created: FakeClient[] = [];

class FakeClient {
  destroyed = false;
  disconnected = false;
  handlers: Record<string, ((err: Error) => void)[]> = {};
  constructor(
    private behaviour: "resolve" | "reject" | "hang",
    public options: Record<string, unknown>,
  ) {}
  connect(): Promise<unknown> {
    if (this.behaviour === "resolve") return Promise.resolve(this);
    if (this.behaviour === "reject") return Promise.reject(new Error("ECONNREFUSED"));
    return new Promise(() => {
      /* never settles — the frozen-Redis case */
    });
  }
  on(event: string, cb: (err: Error) => void): this {
    (this.handlers[event] ??= []).push(cb);
    return this;
  }
  destroy(): void {
    this.destroyed = true;
  }
  disconnect(): void {
    this.disconnected = true;
  }
}

let behaviour: "resolve" | "reject" | "hang" = "resolve";

vi.mock("redis", () => ({
  createClient: (options: Record<string, unknown>) => {
    const c = new FakeClient(behaviour, options);
    created.push(c);
    return c;
  },
  default: {
    createClient: (options: Record<string, unknown>) => {
      const c = new FakeClient(behaviour, options);
      created.push(c);
      return c;
    },
  },
}));

import {
  boundedReconnectStrategy,
  boundedRedisSocketOptions,
  connectRedisBounded,
  describeRedisError,
  redisConnectDeadlineMs,
} from "../../../src/lib/redisConnect";

beforeEach(() => {
  created = [];
  behaviour = "resolve";
});

afterEach(() => {
  delete process.env.REDIS_CONNECT_DEADLINE_MS;
});

describe("boundedReconnectStrategy", () => {
  it("backs off with increasing delays while under the attempt cap", () => {
    expect(boundedReconnectStrategy(0)).toBe(500);
    expect(boundedReconnectStrategy(1)).toBe(1_000);
    expect(boundedReconnectStrategy(2)).toBe(1_500);
  });

  it("gives up with `false` at the attempt cap — never a number, which would retry forever", () => {
    // false is the ONLY return that makes node-redis settle the pending
    // connect() with an error instead of looping.
    expect(boundedReconnectStrategy(3)).toBe(false);
    expect(boundedReconnectStrategy(99)).toBe(false);
  });

  it("is the strategy carried by boundedRedisSocketOptions", () => {
    const opts = boundedRedisSocketOptions();
    expect(opts.reconnectStrategy).toBe(boundedReconnectStrategy);
    expect(opts.connectTimeout).toBeGreaterThan(0);
  });
});

describe("redisConnectDeadlineMs", () => {
  it("defaults to 3s and ignores junk env values", () => {
    delete process.env.REDIS_CONNECT_DEADLINE_MS;
    expect(redisConnectDeadlineMs()).toBe(3_000);
    process.env.REDIS_CONNECT_DEADLINE_MS = "not-a-number";
    expect(redisConnectDeadlineMs()).toBe(3_000);
    process.env.REDIS_CONNECT_DEADLINE_MS = "-1";
    expect(redisConnectDeadlineMs()).toBe(3_000);
  });

  it("honours a positive override", () => {
    process.env.REDIS_CONNECT_DEADLINE_MS = "250";
    expect(redisConnectDeadlineMs()).toBe(250);
  });
});

describe("connectRedisBounded", () => {
  it("returns the client and installs the bounded socket options", async () => {
    const client = (await connectRedisBounded({ url: "redis://x:6379" })) as FakeClient;
    expect(client).toBe(created[0]);
    const socket = created[0].options.socket as { reconnectStrategy: unknown };
    expect(socket.reconnectStrategy).toBe(boundedReconnectStrategy);
  });

  it("rejects on the deadline when connect() never settles, instead of hanging", async () => {
    behaviour = "hang";
    await expect(
      connectRedisBounded({ url: "redis://frozen:6379", deadlineMs: 30 }),
    ).rejects.toThrow(/deadline exceeded after 30ms/);
  });

  it("tears the socket down after a deadline miss so no reconnect loop survives", async () => {
    behaviour = "hang";
    await expect(
      connectRedisBounded({ url: "redis://frozen:6379", deadlineMs: 20 }),
    ).rejects.toThrow();
    expect(created[0].destroyed).toBe(true);
  });

  it("propagates a hard connect refusal and still tears down", async () => {
    behaviour = "reject";
    await expect(connectRedisBounded({ url: "redis://down:6379" })).rejects.toThrow(
      /ECONNREFUSED/,
    );
    expect(created[0].destroyed).toBe(true);
  });

  it("passes a password through only when one is supplied", async () => {
    await connectRedisBounded({ url: "redis://x:6379" });
    expect(created[0].options).not.toHaveProperty("password");
    await connectRedisBounded({ url: "redis://x:6379", password: "s3cret" });
    expect(created[1].options.password).toBe("s3cret");
  });
});

describe("describeRedisError", () => {
  it("unwraps the first real cause out of node-redis' empty-message AggregateError", () => {
    const agg = Object.assign(new Error(""), {
      name: "AggregateError",
      errors: [new Error("connect ECONNREFUSED 127.0.0.1:6379")],
    });
    expect(describeRedisError(agg)).toBe(
      "AggregateError: connect ECONNREFUSED 127.0.0.1:6379",
    );
  });

  it("falls back to the message, then the name, then String()", () => {
    expect(describeRedisError(new Error("plain"))).toBe("plain");
    const nameOnly = new Error("");
    nameOnly.name = "SocketClosedUnexpectedlyError";
    expect(describeRedisError(nameOnly)).toBe("SocketClosedUnexpectedlyError");
    expect(describeRedisError("just a string")).toBe("just a string");
  });
});
