import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

import { createTicketStore, type RedisTicketClient } from "../../src/auth/ticketStore.js";
import { loadConfig, type AppConfig } from "../../src/config/env.js";
import { createLogger } from "../../src/observability/logger.js";
import { createConnectionRegistry } from "../../src/websocket/connections.js";
import { createHeartbeatController } from "../../src/websocket/heartbeat.js";
import { attachUpgradeHandler } from "../../src/websocket/upgrade.js";
import { handleHealthRequest } from "../../src/http/health.js";

function opaqueTicket(): string {
  return randomBytes(32).toString("base64url");
}

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base = loadConfig({
    WS_ALLOWED_ORIGINS: "http://localhost:3000",
    REDIS_URL: "redis://127.0.0.1:6379",
    WS_HEARTBEAT_INTERVAL_MS: "5000",
    WS_HEARTBEAT_TIMEOUT_MS: "10000",
    WS_MAX_CONNECTION_LIFETIME_MS: "60000",
    WS_MAX_PAYLOAD_BYTES: "8192",
    WS_MAX_CONNECTIONS: "10",
    WS_MAX_CONNECTIONS_PER_USER: "2",
    WS_MAX_CONNECTIONS_PER_IP: "5",
    PORT: "3001",
  });
  return { ...base, ...overrides };
}

async function seedTicket(
  map: Map<string, string>,
  prefix: string,
  userId: number,
): Promise<string> {
  const ticket = opaqueTicket();
  const key = `${prefix}${createHash("sha256").update(ticket, "utf8").digest("hex")}`;
  map.set(key, JSON.stringify({ user_id: userId, issued_at: new Date().toISOString() }));
  return ticket;
}

async function listenGateway(config: AppConfig, redisMap: Map<string, string>, ready = true) {
  const logger = createLogger({ level: "silent" });
  let shuttingDown = false;

  const redis: RedisTicketClient = {
    isReady: () => ready,
    async getDel(key) {
      if (!ready) {
        throw new Error("redis down");
      }
      const value = redisMap.get(key) ?? null;
      redisMap.delete(key);
      return value;
    },
  };

  const ticketStore = createTicketStore({
    redis,
    keyPrefix: config.WS_TICKET_REDIS_PREFIX,
  });

  const heartbeat = createHeartbeatController({
    intervalMs: config.WS_HEARTBEAT_INTERVAL_MS,
    timeoutMs: config.WS_HEARTBEAT_TIMEOUT_MS,
  });

  const registry = createConnectionRegistry({
    logger,
    heartbeat,
    limits: {
      maxConnections: config.WS_MAX_CONNECTIONS,
      maxPerUser: config.WS_MAX_CONNECTIONS_PER_USER,
      maxPerIp: config.WS_MAX_CONNECTIONS_PER_IP,
    },
  });

  const server = createServer((req, res) => {
    void handleHealthRequest(req, res, {
      isLive: () => !shuttingDown,
      isReady: async () => ready && !shuttingDown,
    });
  });

  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: config.WS_MAX_PAYLOAD_BYTES,
  });

  server.on(
    "upgrade",
    attachUpgradeHandler({
      wss,
      config,
      ticketStore,
      registry,
      logger,
      isShuttingDown: () => shuttingDown,
    }),
  );

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    port,
    registry,
    async close() {
      shuttingDown = true;
      registry.closeAll(1001, "test done");
      registry.dispose();
      await new Promise<void>((resolve, reject) => {
        wss.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          server.close((serverError) => (serverError ? reject(serverError) : resolve()));
        });
      });
    },
  };
}

function connectWs(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ ws: WebSocket; openError?: Error }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    ws.once("open", () => resolve({ ws }));
    ws.once("unexpected-response", (_req, res) => {
      resolve({
        ws,
        openError: new Error(`unexpected status ${res.statusCode}`),
      });
    });
    ws.once("error", (error) => resolve({ ws, openError: error }));
  });
}

describe("gateway integration", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn) {
        await fn();
      }
    }
  });

  it("rejects unauthenticated upgrades", async () => {
    const config = testConfig();
    const gateway = await listenGateway(config, new Map());
    cleanups.push(() => gateway.close());

    const { openError } = await connectWs(gateway.port, "/ws", {
      Origin: "http://localhost:3000",
    });
    expect(openError).toBeTruthy();
  });

  it("rejects foreign browser origins", async () => {
    const config = testConfig();
    const map = new Map<string, string>();
    const ticket = await seedTicket(map, config.WS_TICKET_REDIS_PREFIX, 7);
    const gateway = await listenGateway(config, map);
    cleanups.push(() => gateway.close());

    const { openError } = await connectWs(gateway.port, `/ws?ticket=${ticket}`, {
      Origin: "https://evil.example",
    });
    expect(openError).toBeTruthy();
  });

  it("accepts a valid ticket and emits connection.ready", async () => {
    const config = testConfig();
    const map = new Map<string, string>();
    const ticket = await seedTicket(map, config.WS_TICKET_REDIS_PREFIX, 99);
    const gateway = await listenGateway(config, map);
    cleanups.push(() => gateway.close());

    const message = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for ready")), 2_000);
      const ws = new WebSocket(`ws://127.0.0.1:${gateway.port}/ws?ticket=${ticket}`, {
        headers: { Origin: "http://localhost:3000" },
      });
      ws.once("message", (data) => {
        clearTimeout(timer);
        const parsed: unknown = JSON.parse(data.toString("utf8"));
        ws.close();
        resolve(parsed);
      });
      ws.once("unexpected-response", (_req, res) => {
        clearTimeout(timer);
        reject(new Error(`unexpected status ${res.statusCode}`));
      });
      ws.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    expect(message).toMatchObject({
      v: 1,
      type: "connection.ready",
      payload: { player_id: 99 },
    });
  });

  it("rejects ticket reuse", async () => {
    const config = testConfig();
    const map = new Map<string, string>();
    const ticket = await seedTicket(map, config.WS_TICKET_REDIS_PREFIX, 5);
    const gateway = await listenGateway(config, map);
    cleanups.push(() => gateway.close());

    const first = await connectWs(gateway.port, `/ws?ticket=${ticket}`, {
      Origin: "http://localhost:3000",
    });
    expect(first.openError).toBeUndefined();
    first.ws.close();

    const second = await connectWs(gateway.port, `/ws?ticket=${ticket}`, {
      Origin: "http://localhost:3000",
    });
    expect(second.openError).toBeTruthy();
  });

  it("rejects duplicate ticket query params", async () => {
    const config = testConfig();
    const gateway = await listenGateway(config, new Map());
    cleanups.push(() => gateway.close());

    const { openError } = await connectWs(
      gateway.port,
      "/ws?ticket=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&ticket=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      { Origin: "http://localhost:3000" },
    );
    expect(openError).toBeTruthy();
  });

  it("reports live and ready health", async () => {
    const config = testConfig();
    const gateway = await listenGateway(config, new Map(), true);
    cleanups.push(() => gateway.close());

    const live = await fetch(`http://127.0.0.1:${gateway.port}/health/live`);
    const ready = await fetch(`http://127.0.0.1:${gateway.port}/health/ready`);
    expect(live.status).toBe(200);
    expect(ready.status).toBe(200);
  });

  it("fails ready and upgrades when redis is down", async () => {
    const config = testConfig();
    const map = new Map<string, string>();
    const ticket = await seedTicket(map, config.WS_TICKET_REDIS_PREFIX, 1);
    const gateway = await listenGateway(config, map, false);
    cleanups.push(() => gateway.close());

    const ready = await fetch(`http://127.0.0.1:${gateway.port}/health/ready`);
    expect(ready.status).toBe(503);

    const { openError } = await connectWs(gateway.port, `/ws?ticket=${ticket}`, {
      Origin: "http://localhost:3000",
    });
    expect(openError).toBeTruthy();
  });

});
