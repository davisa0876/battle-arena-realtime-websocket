import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import type { RoomGrantStore } from "../auth/roomGrantStore.js";
import { TicketRejectedError, type TicketStore } from "../auth/ticketStore.js";
import type { OnlinePresenceStore } from "../presence/onlineStore.js";
import {
  ClientDiagnosticSchema,
  ErrorCode,
  NotificationEnvelopeSchema,
  RoomSubscribeSchema,
  RoomUnsubscribeSchema,
  type ErrorCodeName,
} from "../protocol/schemas.js";
import { validateOrigin } from "../websocket/upgrade.js";
import {
  buildConnectionError,
  buildConnectionReady,
  buildRoomSubscribed,
} from "../websocket/protocol.js";
import type { ConnectionRegistryStore } from "./registry.js";
import type { ConnectionPoster } from "./transport.js";

/**
 * Event-driven equivalent of the persistent gateway (src/websocket/*) for
 * API Gateway WebSocket + Lambda. Same wire protocol, same Redis ticket/grant/presence
 * contracts; state lives in Redis instead of process memory, and outbound frames go
 * through the API Gateway Management API instead of a held socket.
 */

export type ApiGatewayWebSocketEvent = {
  requestContext: {
    routeKey: string;
    eventType: "CONNECT" | "MESSAGE" | "DISCONNECT";
    connectionId: string;
    connectedAt?: number;
    identity?: { sourceIp?: string; userAgent?: string };
    domainName?: string;
    stage?: string;
  };
  headers?: Record<string, string | undefined> | null;
  queryStringParameters?: Record<string, string | undefined> | null;
  multiValueQueryStringParameters?: Record<string, string[] | undefined> | null;
  body?: string | null;
  isBase64Encoded?: boolean;
};

export const READY_EVENT_KIND = "battle-arena.realtime.connection-ready" as const;

export type ConnectionReadyEvent = {
  kind: typeof READY_EVENT_KIND;
  connection_id: string;
};

export type ProxyResult = {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
};

export type NotificationResult = {
  accepted: boolean;
  delivered: number;
  gone: number;
};

export type RealtimeLambdaSettings = {
  allowedOrigins: readonly string[];
  allowMissingOrigin: boolean;
  heartbeatIntervalMs: number;
  maxPayloadBytes: number;
  maxRoomsPerConnection: number;
  maxConnections: number;
  maxConnectionsPerUser: number;
  maxConnectionsPerIp: number;
  readyDeliveryAttempts: number;
  readyDeliveryBaseDelayMs: number;
};

export type RealtimeLambdaDeps = {
  settings: RealtimeLambdaSettings;
  logger: Logger;
  registry: ConnectionRegistryStore;
  tickets: TicketStore;
  grants: RoomGrantStore;
  presence: OnlinePresenceStore;
  poster: ConnectionPoster;
  invokeReady: (event: ConnectionReadyEvent) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type RealtimeLambdaCore = {
  dispatch: (event: unknown) => Promise<ProxyResult | NotificationResult | { status: string }>;
  handleConnect: (event: ApiGatewayWebSocketEvent) => Promise<ProxyResult>;
  handleMessage: (event: ApiGatewayWebSocketEvent) => Promise<ProxyResult>;
  handleDisconnect: (event: ApiGatewayWebSocketEvent) => Promise<ProxyResult>;
  handleReady: (event: ConnectionReadyEvent) => Promise<{ status: string }>;
  handleNotification: (event: unknown) => Promise<NotificationResult>;
};

export function isApiGatewayWebSocketEvent(event: unknown): event is ApiGatewayWebSocketEvent {
  if (typeof event !== "object" || event === null) {
    return false;
  }
  const ctx = (event as { requestContext?: unknown }).requestContext;
  if (typeof ctx !== "object" || ctx === null) {
    return false;
  }
  const { eventType, connectionId } = ctx as { eventType?: unknown; connectionId?: unknown };
  return (
    (eventType === "CONNECT" || eventType === "MESSAGE" || eventType === "DISCONNECT") &&
    typeof connectionId === "string" &&
    connectionId.length > 0
  );
}

function isReadyEvent(event: unknown): event is ConnectionReadyEvent {
  return (
    typeof event === "object" &&
    event !== null &&
    (event as { kind?: unknown }).kind === READY_EVENT_KIND &&
    typeof (event as { connection_id?: unknown }).connection_id === "string"
  );
}

function headerValue(
  headers: Record<string, string | undefined> | null | undefined,
  name: string,
): string | undefined {
  if (!headers) {
    return undefined;
  }
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) {
      return value;
    }
  }
  return undefined;
}

function reject(statusCode: number, code: ErrorCodeName): ProxyResult {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error: code }),
  };
}

const OK: ProxyResult = { statusCode: 200 };

export function createRealtimeLambdaCore(deps: RealtimeLambdaDeps): RealtimeLambdaCore {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const s = deps.settings;

  const send = async (connectionId: string, frame: Record<string, unknown>) =>
    deps.poster.post(connectionId, JSON.stringify(frame));

  /** Unregisters exactly once and releases presence; safe to call from any path. */
  const forget = async (connectionId: string): Promise<void> => {
    const removed = await deps.registry.unregister(connectionId);
    if (removed) {
      await deps.presence.trackDisconnect(removed.playerId);
    }
  };

  const sendErrorAndClose = async (connectionId: string, code: ErrorCodeName): Promise<void> => {
    try {
      await send(connectionId, buildConnectionError({ code }));
    } catch (error) {
      deps.logger.warn({ connectionId, err: errorMessage(error) }, "error frame delivery failed");
    }
    await forget(connectionId);
    try {
      await deps.poster.close(connectionId);
    } catch (error) {
      deps.logger.warn({ connectionId, err: errorMessage(error) }, "delete connection failed");
    }
  };

  const sendError = async (connectionId: string, code: ErrorCodeName): Promise<void> => {
    const outcome = await send(connectionId, buildConnectionError({ code }));
    if (outcome === "gone") {
      await forget(connectionId);
    }
  };

  const handleConnect = async (event: ApiGatewayWebSocketEvent): Promise<ProxyResult> => {
    const connectionId = event.requestContext.connectionId;
    const sourceIp = event.requestContext.identity?.sourceIp ?? "unknown";

    if (!validateOrigin(headerValue(event.headers, "origin"), s.allowedOrigins, s.allowMissingOrigin)) {
      return reject(403, ErrorCode.ORIGIN_REJECTED);
    }

    const tickets = event.multiValueQueryStringParameters?.ticket;
    if (tickets && tickets.length > 1) {
      return reject(400, ErrorCode.TICKET_MALFORMED);
    }
    const ticket = event.queryStringParameters?.ticket;
    if (!ticket) {
      return reject(401, ErrorCode.TICKET_MISSING);
    }

    if (!deps.registry.isReady()) {
      return reject(503, ErrorCode.REDIS_UNAVAILABLE);
    }

    try {
      if ((await deps.registry.countActive({ kind: "all" })) >= s.maxConnections) {
        return reject(429, ErrorCode.CONNECTION_LIMIT);
      }
      if ((await deps.registry.countActive({ kind: "ip", ip: sourceIp })) >= s.maxConnectionsPerIp) {
        return reject(429, ErrorCode.CONNECTION_LIMIT);
      }
    } catch {
      return reject(503, ErrorCode.REDIS_UNAVAILABLE);
    }

    let playerId: number;
    try {
      const meta = await deps.tickets.consume(ticket);
      playerId = meta.user_id;
    } catch (error) {
      if (error instanceof TicketRejectedError) {
        if (error.reason === "redis_unavailable") {
          return reject(503, ErrorCode.REDIS_UNAVAILABLE);
        }
        if (error.reason === "malformed") {
          return reject(400, ErrorCode.TICKET_MALFORMED);
        }
        return reject(401, ErrorCode.TICKET_INVALID);
      }
      return reject(503, ErrorCode.REDIS_UNAVAILABLE);
    }

    try {
      if ((await deps.registry.countActive({ kind: "user", playerId })) >= s.maxConnectionsPerUser) {
        return reject(429, ErrorCode.CONNECTION_LIMIT);
      }
      await deps.registry.register({ connectionId, playerId, sourceIp, connectedAt: now() });
    } catch {
      return reject(503, ErrorCode.REDIS_UNAVAILABLE);
    }
    await deps.presence.trackConnect(playerId);

    // API Gateway rejects @connections posts until $connect has returned, so the
    // connection.ready frame is delivered by a separate asynchronous invocation.
    try {
      await deps.invokeReady({ kind: READY_EVENT_KIND, connection_id: connectionId });
    } catch (error) {
      deps.logger.error({ connectionId, err: errorMessage(error) }, "ready self-invoke failed");
      await forget(connectionId);
      return reject(503, ErrorCode.REDIS_UNAVAILABLE);
    }

    deps.logger.info({ connectionId, playerId, outcome: "accepted" }, "connect accepted");
    return OK;
  };

  const handleReady = async (event: ConnectionReadyEvent): Promise<{ status: string }> => {
    const connectionId = event.connection_id;
    const record = await deps.registry.get(connectionId);
    if (!record) {
      return { status: "unknown_connection" };
    }

    const frame = buildConnectionReady({
      connectionId,
      playerId: record.playerId,
      heartbeatIntervalMs: s.heartbeatIntervalMs,
    });

    for (let attempt = 0; attempt < s.readyDeliveryAttempts; attempt += 1) {
      const outcome = await send(connectionId, frame);
      if (outcome === "ok") {
        deps.logger.info({ connectionId, playerId: record.playerId, attempt }, "connection ready");
        return { status: "delivered" };
      }
      // 410 right after $connect usually means the handshake has not completed yet.
      await sleep(s.readyDeliveryBaseDelayMs * 2 ** attempt);
    }

    deps.logger.warn({ connectionId }, "connection.ready undeliverable; dropping registration");
    await forget(connectionId);
    return { status: "gone" };
  };

  const handleMessage = async (event: ApiGatewayWebSocketEvent): Promise<ProxyResult> => {
    const connectionId = event.requestContext.connectionId;
    const record = await deps.registry.get(connectionId);
    if (!record) {
      // Registry entry expired or was cleaned up: the socket is no longer authenticated.
      await deps.poster.close(connectionId).catch(() => undefined);
      return OK;
    }

    if (event.isBase64Encoded) {
      await sendErrorAndClose(connectionId, ErrorCode.PROTOCOL_UNSUPPORTED);
      return OK;
    }

    const raw = event.body ?? "";
    if (Buffer.byteLength(raw, "utf8") > s.maxPayloadBytes) {
      await sendErrorAndClose(connectionId, ErrorCode.PAYLOAD_TOO_LARGE);
      return OK;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      await sendErrorAndClose(connectionId, ErrorCode.PROTOCOL_UNSUPPORTED);
      return OK;
    }

    if (ClientDiagnosticSchema.safeParse(parsed).success) {
      return OK;
    }

    const subscribe = RoomSubscribeSchema.safeParse(parsed);
    if (subscribe.success) {
      if ((await deps.registry.roomCount(connectionId)) >= s.maxRoomsPerConnection) {
        await sendError(connectionId, ErrorCode.CONNECTION_LIMIT);
        return OK;
      }
      try {
        const meta = await deps.grants.consume(subscribe.data.payload.grant);
        if (meta.user_id !== record.playerId) {
          await sendError(connectionId, ErrorCode.GRANT_MISMATCH);
          return OK;
        }
        await deps.registry.addRoom(connectionId, meta.room_id);
        const outcome = await send(
          connectionId,
          buildRoomSubscribed({
            roomId: meta.room_id,
            ...(meta.room_version !== undefined ? { version: meta.room_version } : {}),
          }),
        );
        if (outcome === "gone") {
          await forget(connectionId);
          return OK;
        }
        deps.logger.info(
          { connectionId, roomId: meta.room_id, playerId: record.playerId },
          "room subscribed",
        );
      } catch (error) {
        if (error instanceof TicketRejectedError) {
          const code =
            error.reason === "redis_unavailable"
              ? ErrorCode.REDIS_UNAVAILABLE
              : error.reason === "malformed"
                ? ErrorCode.GRANT_MALFORMED
                : ErrorCode.GRANT_INVALID;
          await sendError(connectionId, code);
          return OK;
        }
        await sendError(connectionId, ErrorCode.REDIS_UNAVAILABLE);
      }
      return OK;
    }

    const unsubscribe = RoomUnsubscribeSchema.safeParse(parsed);
    if (unsubscribe.success) {
      const removed = await deps.registry.removeRoom(connectionId, unsubscribe.data.payload.room_id);
      if (!removed) {
        await sendError(connectionId, ErrorCode.ROOM_NOT_SUBSCRIBED);
      }
      return OK;
    }

    await sendErrorAndClose(connectionId, ErrorCode.PROTOCOL_UNSUPPORTED);
    return OK;
  };

  const handleDisconnect = async (event: ApiGatewayWebSocketEvent): Promise<ProxyResult> => {
    await forget(event.requestContext.connectionId);
    deps.logger.info({ connectionId: event.requestContext.connectionId }, "socket closed");
    return OK;
  };

  const deliver = async (
    connectionIds: Iterable<string>,
    frame: Record<string, unknown>,
  ): Promise<{ delivered: number; gone: number }> => {
    let delivered = 0;
    let gone = 0;
    await Promise.all(
      [...connectionIds].map(async (connectionId) => {
        try {
          const outcome = await send(connectionId, frame);
          if (outcome === "ok") {
            delivered += 1;
            return;
          }
          gone += 1;
          await forget(connectionId);
        } catch (error) {
          deps.logger.warn({ connectionId, err: errorMessage(error) }, "fanout post failed");
        }
      }),
    );
    return { delivered, gone };
  };

  const handleNotification = async (event: unknown): Promise<NotificationResult> => {
    const parsed = NotificationEnvelopeSchema.safeParse(event);
    if (!parsed.success) {
      deps.logger.warn("ignored invalid notification envelope");
      return { accepted: false, delivered: 0, gone: 0 };
    }
    const envelope = parsed.data;
    const frame = {
      v: 1 as const,
      type: envelope.type,
      event_id: envelope.event_id,
      sent_at: envelope.sent_at,
      payload: envelope.payload,
    };

    let delivered = 0;
    let gone = 0;

    if (envelope.target_user_id) {
      const result = await deliver(
        await deps.registry.connectionsForUser(envelope.target_user_id),
        frame,
      );
      delivered += result.delivered;
      gone += result.gone;
    }

    if (envelope.target_room_id) {
      const roomId = envelope.target_room_id;
      const result = await deliver(await deps.registry.connectionsForRoom(roomId), frame);
      delivered += result.delivered;
      gone += result.gone;

      if (envelope.type === "room.subscription.revoked") {
        // Mirrors ConnectionRegistry.revokeRoom in the persistent gateway.
        const reasonValue = (envelope.payload as { reason?: unknown }).reason;
        const reason = String(reasonValue ?? "revoked");
        const former = await deps.registry.dropRoom(roomId);
        await deliver(former, {
          v: 1,
          type: "room.subscription.revoked",
          event_id: randomUUID(),
          sent_at: new Date(now()).toISOString(),
          payload: { room_id: roomId, reason },
        });
      }
    }

    deps.logger.info({ type: envelope.type, delivered, gone }, "notification fanned out");
    return { accepted: true, delivered, gone };
  };

  return {
    handleConnect,
    handleMessage,
    handleDisconnect,
    handleReady,
    handleNotification,
    async dispatch(event) {
      if (isApiGatewayWebSocketEvent(event)) {
        switch (event.requestContext.eventType) {
          case "CONNECT":
            return handleConnect(event);
          case "MESSAGE":
            return handleMessage(event);
          case "DISCONNECT":
            return handleDisconnect(event);
        }
      }
      if (isReadyEvent(event)) {
        return handleReady(event);
      }
      return handleNotification(event);
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
