import type { Logger } from "pino";

import { createRoomGrantStore } from "./auth/roomGrantStore.js";
import { createTicketStore } from "./auth/ticketStore.js";
import type { AppConfig } from "./config/env.js";
import { createHttpGateway, type HttpGateway } from "./http/server.js";
import { createOnlinePresenceStore } from "./presence/onlineStore.js";
import { createRedisHandle, type RedisHandle } from "./redis/client.js";
import { createNotificationSubscriber } from "./redis/notifications.js";
import { createConnectionRegistry } from "./websocket/connections.js";
import { createHeartbeatController } from "./websocket/heartbeat.js";

export type App = {
  config: AppConfig;
  logger: Logger;
  redis: RedisHandle;
  gateway: HttpGateway;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

export function createApp(deps: { config: AppConfig; logger: Logger }): App {
  let shuttingDown = false;

  const redis = createRedisHandle({
    url: deps.config.REDIS_URL,
    onError: (error) => {
      deps.logger.warn({ err: error.message }, "redis client error");
    },
  });

  const ticketStore = createTicketStore({
    redis: redis.ticketClient,
    keyPrefix: deps.config.WS_TICKET_REDIS_PREFIX,
  });

  const roomGrantStore = createRoomGrantStore({
    redis: redis.ticketClient,
    keyPrefix: deps.config.WS_ROOM_GRANT_REDIS_PREFIX,
  });

  const heartbeat = createHeartbeatController({
    intervalMs: deps.config.WS_HEARTBEAT_INTERVAL_MS,
    timeoutMs: deps.config.WS_HEARTBEAT_TIMEOUT_MS,
  });

  const presence = createOnlinePresenceStore({
    redis: redis.client,
    onlineSetKey: deps.config.PRESENCE_ONLINE_SET_KEY,
    connHashKey: deps.config.PRESENCE_CONN_HASH_KEY,
    logger: deps.logger,
  });

  const registry = createConnectionRegistry({
    logger: deps.logger,
    heartbeat,
    roomGrantStore,
    presence,
    maxRoomsPerConnection: deps.config.WS_MAX_ROOMS_PER_CONNECTION,
    limits: {
      maxConnections: deps.config.WS_MAX_CONNECTIONS,
      maxPerUser: deps.config.WS_MAX_CONNECTIONS_PER_USER,
      maxPerIp: deps.config.WS_MAX_CONNECTIONS_PER_IP,
    },
  });

  const notifications = createNotificationSubscriber({
    url: deps.config.REDIS_URL,
    channel: deps.config.REALTIME_NOTIFICATIONS_CHANNEL,
    logger: deps.logger,
    onMessage: (envelope) => {
      registry.deliverNotification(envelope);
    },
  });

  const gateway = createHttpGateway({
    config: deps.config,
    logger: deps.logger,
    ticketStore,
    registry,
    isShuttingDown: () => shuttingDown,
    isReady: async () => redis.ping(),
  });

  return {
    config: deps.config,
    logger: deps.logger,
    redis,
    gateway,
    async start() {
      await redis.connect();
      await notifications.start();
      await gateway.listen();
    },
    async stop() {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      deps.logger.info("graceful shutdown started");

      const deadline = setTimeout(() => {
        deps.logger.warn("shutdown deadline reached; forcing exit path");
      }, deps.config.SHUTDOWN_TIMEOUT_MS);
      deadline.unref?.();

      try {
        registry.closeAll(1001, "server shutting down");
        await Promise.race([
          gateway.close(),
          sleep(deps.config.SHUTDOWN_TIMEOUT_MS),
        ]);
        registry.dispose();
        await notifications.stop();
        await redis.disconnect();
        deps.logger.info("graceful shutdown complete");
      } finally {
        clearTimeout(deadline);
      }
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}
