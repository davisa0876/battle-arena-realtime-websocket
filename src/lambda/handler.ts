import { createRoomGrantStore } from "../auth/roomGrantStore.js";
import { createTicketStore } from "../auth/ticketStore.js";
import { createLogger } from "../observability/logger.js";
import { createOnlinePresenceStore } from "../presence/onlineStore.js";
import { ErrorCode } from "../protocol/schemas.js";
import { createRedisHandle, type RedisHandle } from "../redis/client.js";
import { loadLambdaConfig } from "./config.js";
import {
  createRealtimeLambdaCore,
  isApiGatewayWebSocketEvent,
  type RealtimeLambdaCore,
} from "./core.js";
import { createRedisConnectionRegistry } from "./registry.js";
import { createAsyncInvoker, createManagementApiPoster } from "./transport.js";

/**
 * AWS Lambda entry point for API Gateway WebSocket routes ($connect, $disconnect, $default),
 * the deferred connection.ready delivery, and Laravel-initiated notification fan-out.
 *
 * Module scope is reused across warm invocations of one execution environment only.
 * Nothing here is shared between environments; all shared state lives in Redis.
 */

const config = loadLambdaConfig();
const logger = createLogger({ level: config.LOG_LEVEL });

let redis: RedisHandle | null = null;
let core: RealtimeLambdaCore | null = null;

async function ensureRedisReady(handle: RedisHandle, timeoutMs: number): Promise<void> {
  if (!handle.client.isOpen) {
    await handle.connect();
    return;
  }
  if (handle.client.isReady) {
    return;
  }
  // A thawed environment may hold a socket that died while frozen; wait for reconnect.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      handle.client.off("ready", onReady);
      reject(new Error("redis not ready"));
    }, timeoutMs);
    const onReady = (): void => {
      clearTimeout(timer);
      resolve();
    };
    handle.client.once("ready", onReady);
  });
}

async function getCore(): Promise<RealtimeLambdaCore> {
  if (!redis) {
    redis = createRedisHandle({
      url: config.REDIS_URL,
      onError: (error) => logger.warn({ err: error.message }, "redis client error"),
    });
  }
  await ensureRedisReady(redis, 2_000);

  if (!core) {
    core = createRealtimeLambdaCore({
      settings: {
        allowedOrigins: config.WS_ALLOWED_ORIGINS,
        allowMissingOrigin: config.WS_ALLOW_MISSING_ORIGIN,
        heartbeatIntervalMs: config.WS_HEARTBEAT_INTERVAL_MS,
        maxPayloadBytes: config.WS_MAX_PAYLOAD_BYTES,
        maxRoomsPerConnection: config.WS_MAX_ROOMS_PER_CONNECTION,
        maxConnections: config.WS_MAX_CONNECTIONS,
        maxConnectionsPerUser: config.WS_MAX_CONNECTIONS_PER_USER,
        maxConnectionsPerIp: config.WS_MAX_CONNECTIONS_PER_IP,
        readyDeliveryAttempts: config.WS_READY_DELIVERY_ATTEMPTS,
        readyDeliveryBaseDelayMs: config.WS_READY_DELIVERY_BASE_DELAY_MS,
      },
      logger,
      registry: createRedisConnectionRegistry({
        redis: redis.client,
        prefix: config.WS_REGISTRY_PREFIX,
        ttlSeconds: config.WS_REGISTRY_TTL_SECONDS,
      }),
      tickets: createTicketStore({
        redis: redis.ticketClient,
        keyPrefix: config.WS_TICKET_REDIS_PREFIX,
      }),
      grants: createRoomGrantStore({
        redis: redis.ticketClient,
        keyPrefix: config.WS_ROOM_GRANT_REDIS_PREFIX,
      }),
      presence: createOnlinePresenceStore({
        redis: redis.client,
        onlineSetKey: config.PRESENCE_ONLINE_SET_KEY,
        connHashKey: config.PRESENCE_CONN_HASH_KEY,
        logger,
      }),
      poster: createManagementApiPoster({
        endpoint: config.WS_MANAGEMENT_ENDPOINT,
        region: config.AWS_REGION,
      }),
      invokeReady: createAsyncInvoker({
        functionName: config.readyFunctionName,
        region: config.AWS_REGION,
        endpoint: config.LAMBDA_ENDPOINT,
      }),
    });
  }
  return core;
}

export const handler = async (event: unknown): Promise<unknown> => {
  let instance: RealtimeLambdaCore;
  try {
    instance = await getCore();
  } catch (error) {
    logger.error({ err: error instanceof Error ? error.message : String(error) }, "init failed");
    if (isApiGatewayWebSocketEvent(event) && event.requestContext.eventType === "CONNECT") {
      // Fail closed: no ticket redemption without Redis.
      return {
        statusCode: 503,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: ErrorCode.REDIS_UNAVAILABLE }),
      };
    }
    throw error;
  }
  return instance.dispatch(event);
};
