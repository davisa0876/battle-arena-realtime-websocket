import { randomUUID } from "node:crypto";

import type { Logger } from "pino";
import type { WebSocket } from "ws";

import { TicketRejectedError } from "../auth/ticketStore.js";
import type { RoomGrantStore } from "../auth/roomGrantStore.js";
import {
  ClientDiagnosticSchema,
  ErrorCode,
  RoomSubscribeSchema,
  RoomUnsubscribeSchema,
  type NotificationEnvelope,
} from "../protocol/schemas.js";
import type { OnlinePresenceStore } from "../presence/onlineStore.js";
import type { HeartbeatController } from "./heartbeat.js";
import {
  buildConnectionError,
  buildConnectionReady,
  buildRoomSubscribed,
  safeJsonSend,
} from "./protocol.js";

export type AuthenticatedConnection = {
  id: string;
  playerId: number;
  remoteIp: string;
  socket: WebSocket;
  connectedAt: number;
  roomIds: Set<string>;
};

export type ConnectionRegistry = {
  accept: (input: {
    socket: WebSocket;
    playerId: number;
    remoteIp: string;
    heartbeatIntervalMs: number;
    maxLifetimeMs: number;
    maxBufferedBytes: number;
    maxPayloadBytes: number;
  }) => AuthenticatedConnection | null;
  count: () => number;
  countForUser: (playerId: number) => number;
  countForIp: (remoteIp: string) => number;
  deliverNotification: (envelope: NotificationEnvelope) => void;
  revokeRoom: (roomId: string, reason: string) => void;
  closeAll: (code: number, reason: string) => void;
  dispose: () => void;
};

export function createConnectionRegistry(deps: {
  logger: Logger;
  heartbeat: HeartbeatController;
  roomGrantStore?: RoomGrantStore;
  presence?: OnlinePresenceStore;
  maxRoomsPerConnection?: number;
  limits: {
    maxConnections: number;
    maxPerUser: number;
    maxPerIp: number;
  };
  now?: () => number;
  createId?: () => string;
}): ConnectionRegistry {
  const connections = new Map<string, AuthenticatedConnection>();
  const lifetimeTimers = new Map<string, NodeJS.Timeout>();
  const roomIndex = new Map<string, Set<string>>();
  const now = deps.now ?? (() => Date.now());
  const createId = deps.createId ?? (() => randomUUID());
  const maxRooms = deps.maxRoomsPerConnection ?? 5;

  const remove = (connectionId: string): void => {
    const existing = connections.get(connectionId);
    if (!existing) {
      return;
    }
    for (const roomId of existing.roomIds) {
      const set = roomIndex.get(roomId);
      set?.delete(connectionId);
      if (set && set.size === 0) {
        roomIndex.delete(roomId);
      }
    }
    deps.heartbeat.stop(existing.socket);
    const timer = lifetimeTimers.get(connectionId);
    if (timer) {
      clearTimeout(timer);
      lifetimeTimers.delete(connectionId);
    }
    connections.delete(connectionId);
    if (deps.presence) {
      void deps.presence.trackDisconnect(existing.playerId);
    }
  };

  const sendError = (connection: AuthenticatedConnection, code: (typeof ErrorCode)[keyof typeof ErrorCode]): void => {
    if (connection.socket.readyState === connection.socket.OPEN) {
      safeJsonSend(
        (data) => connection.socket.send(data),
        buildConnectionError({ code }),
      );
    }
  };

  const closeSocket = (
    connection: AuthenticatedConnection,
    code: number,
    reason: string,
    errorCode?: (typeof ErrorCode)[keyof typeof ErrorCode],
  ): void => {
    try {
      if (errorCode) {
        sendError(connection, errorCode);
      }
      connection.socket.close(code, reason);
    } catch {
      try {
        connection.socket.terminate();
      } catch {
        // ignore
      }
    } finally {
      remove(connection.id);
    }
  };

  const subscribeRoom = (connection: AuthenticatedConnection, roomId: string): void => {
    connection.roomIds.add(roomId);
    const set = roomIndex.get(roomId) ?? new Set<string>();
    set.add(connection.id);
    roomIndex.set(roomId, set);
  };

  const unsubscribeRoom = (connection: AuthenticatedConnection, roomId: string): void => {
    connection.roomIds.delete(roomId);
    const set = roomIndex.get(roomId);
    set?.delete(connection.id);
    if (set && set.size === 0) {
      roomIndex.delete(roomId);
    }
  };

  const handleMessage = async (
    connection: AuthenticatedConnection,
    parsed: unknown,
    maxBufferedBytes: number,
  ): Promise<void> => {
    const diagnostic = ClientDiagnosticSchema.safeParse(parsed);
    if (diagnostic.success) {
      return;
    }

    const subscribe = RoomSubscribeSchema.safeParse(parsed);
    if (subscribe.success) {
      if (!deps.roomGrantStore) {
        sendError(connection, ErrorCode.PROTOCOL_UNSUPPORTED);
        return;
      }
      if (connection.roomIds.size >= maxRooms) {
        sendError(connection, ErrorCode.CONNECTION_LIMIT);
        return;
      }
      try {
        const meta = await deps.roomGrantStore.consume(subscribe.data.payload.grant);
        if (meta.user_id !== connection.playerId) {
          sendError(connection, ErrorCode.GRANT_MISMATCH);
          return;
        }
        subscribeRoom(connection, meta.room_id);
        if (connection.socket.bufferedAmount > maxBufferedBytes) {
          closeSocket(connection, 1008, "backpressure", ErrorCode.RATE_LIMITED);
          return;
        }
        safeJsonSend(
          (payload) => connection.socket.send(payload),
          buildRoomSubscribed({
            roomId: meta.room_id,
            ...(meta.room_version !== undefined ? { version: meta.room_version } : {}),
          }),
        );
        deps.logger.info(
          { connectionId: connection.id, roomId: meta.room_id, playerId: connection.playerId },
          "room subscribed",
        );
      } catch (error) {
        if (error instanceof TicketRejectedError) {
          if (error.reason === "redis_unavailable") {
            sendError(connection, ErrorCode.REDIS_UNAVAILABLE);
            return;
          }
          if (error.reason === "malformed") {
            sendError(connection, ErrorCode.GRANT_MALFORMED);
            return;
          }
          sendError(connection, ErrorCode.GRANT_INVALID);
          return;
        }
        sendError(connection, ErrorCode.REDIS_UNAVAILABLE);
      }
      return;
    }

    const unsubscribe = RoomUnsubscribeSchema.safeParse(parsed);
    if (unsubscribe.success) {
      if (!connection.roomIds.has(unsubscribe.data.payload.room_id)) {
        sendError(connection, ErrorCode.ROOM_NOT_SUBSCRIBED);
        return;
      }
      unsubscribeRoom(connection, unsubscribe.data.payload.room_id);
      return;
    }

    closeSocket(connection, 1003, "unsupported", ErrorCode.PROTOCOL_UNSUPPORTED);
  };

  return {
    accept(input) {
      if (connections.size >= deps.limits.maxConnections) {
        return null;
      }
      if (this.countForUser(input.playerId) >= deps.limits.maxPerUser) {
        return null;
      }
      if (this.countForIp(input.remoteIp) >= deps.limits.maxPerIp) {
        return null;
      }

      const connection: AuthenticatedConnection = {
        id: createId(),
        playerId: input.playerId,
        remoteIp: input.remoteIp,
        socket: input.socket,
        connectedAt: now(),
        roomIds: new Set(),
      };

      connections.set(connection.id, connection);
      if (deps.presence) {
        void deps.presence.trackConnect(connection.playerId);
      }

      input.socket.on("pong", () => {
        deps.heartbeat.notePong(input.socket);
      });

      input.socket.on("message", (data, isBinary) => {
        if (isBinary) {
          closeSocket(connection, 1003, "unsupported", ErrorCode.PROTOCOL_UNSUPPORTED);
          return;
        }
        const raw = typeof data === "string" ? data : data.toString("utf8");
        if (Buffer.byteLength(raw, "utf8") > input.maxPayloadBytes) {
          closeSocket(connection, 1009, "too large", ErrorCode.PAYLOAD_TOO_LARGE);
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw) as unknown;
        } catch {
          closeSocket(connection, 1003, "bad json", ErrorCode.PROTOCOL_UNSUPPORTED);
          return;
        }
        void handleMessage(connection, parsed, input.maxBufferedBytes);
      });

      input.socket.on("close", () => {
        remove(connection.id);
        deps.logger.info({ connectionId: connection.id, playerId: connection.playerId }, "socket closed");
      });

      input.socket.on("error", (error) => {
        deps.logger.warn({ connectionId: connection.id, err: error.message }, "socket error");
        remove(connection.id);
      });

      deps.heartbeat.start(input.socket, () => {
        deps.logger.info({ connectionId: connection.id }, "heartbeat timeout");
        closeSocket(connection, 1001, "heartbeat", ErrorCode.HEARTBEAT_TIMEOUT);
      });

      const lifetimeTimer = setTimeout(() => {
        deps.logger.info({ connectionId: connection.id }, "max lifetime exceeded");
        closeSocket(connection, 1001, "lifetime", ErrorCode.LIFETIME_EXCEEDED);
      }, input.maxLifetimeMs);
      lifetimeTimer.unref?.();
      lifetimeTimers.set(connection.id, lifetimeTimer);

      if (input.socket.bufferedAmount > input.maxBufferedBytes) {
        closeSocket(connection, 1008, "backpressure", ErrorCode.RATE_LIMITED);
        return null;
      }

      safeJsonSend(
        (payload) => input.socket.send(payload),
        buildConnectionReady({
          connectionId: connection.id,
          playerId: connection.playerId,
          heartbeatIntervalMs: input.heartbeatIntervalMs,
        }),
      );

      deps.logger.info(
        { connectionId: connection.id, playerId: connection.playerId },
        "connection ready",
      );

      return connection;
    },

    count() {
      return connections.size;
    },

    countForUser(playerId) {
      let n = 0;
      for (const conn of connections.values()) {
        if (conn.playerId === playerId) {
          n += 1;
        }
      }
      return n;
    },

    countForIp(remoteIp) {
      let n = 0;
      for (const conn of connections.values()) {
        if (conn.remoteIp === remoteIp) {
          n += 1;
        }
      }
      return n;
    },

    deliverNotification(envelope) {
      const frame = {
        v: 1 as const,
        type: envelope.type,
        event_id: envelope.event_id,
        sent_at: envelope.sent_at,
        payload: envelope.payload,
      };

      if (envelope.target_user_id) {
        for (const conn of connections.values()) {
          if (conn.playerId === envelope.target_user_id && conn.socket.readyState === conn.socket.OPEN) {
            safeJsonSend((data) => conn.socket.send(data), frame);
          }
        }
      }

      if (envelope.target_room_id) {
        const members = roomIndex.get(envelope.target_room_id);
        if (!members) {
          return;
        }
        for (const connectionId of members) {
          const conn = connections.get(connectionId);
          if (conn && conn.socket.readyState === conn.socket.OPEN) {
            safeJsonSend((data) => conn.socket.send(data), frame);
          }
        }
        if (envelope.type === "room.subscription.revoked") {
          this.revokeRoom(envelope.target_room_id, String(envelope.payload.reason ?? "revoked"));
        }
      }
    },

    revokeRoom(roomId, reason) {
      const members = roomIndex.get(roomId);
      if (!members) {
        return;
      }
      for (const connectionId of [...members]) {
        const conn = connections.get(connectionId);
        if (!conn) {
          continue;
        }
        unsubscribeRoom(conn, roomId);
        if (conn.socket.readyState === conn.socket.OPEN) {
          safeJsonSend((data) => conn.socket.send(data), {
            v: 1,
            type: "room.subscription.revoked",
            event_id: randomUUID(),
            sent_at: new Date(now()).toISOString(),
            payload: { room_id: roomId, reason },
          });
        }
      }
      roomIndex.delete(roomId);
    },

    closeAll(code, reason) {
      for (const conn of [...connections.values()]) {
        closeSocket(conn, code, reason, ErrorCode.SHUTTING_DOWN);
      }
    },

    dispose() {
      deps.heartbeat.stopAll();
      for (const timer of lifetimeTimers.values()) {
        clearTimeout(timer);
      }
      lifetimeTimers.clear();
      connections.clear();
      roomIndex.clear();
    },
  };
}
