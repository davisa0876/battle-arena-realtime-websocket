import { randomUUID } from "node:crypto";

import type { Logger } from "pino";
import type { WebSocket } from "ws";

import { ClientDiagnosticSchema, ErrorCode } from "../protocol/schemas.js";
import type { HeartbeatController } from "./heartbeat.js";
import { buildConnectionError, buildConnectionReady, safeJsonSend } from "./protocol.js";

export type AuthenticatedConnection = {
  id: string;
  playerId: number;
  remoteIp: string;
  socket: WebSocket;
  connectedAt: number;
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
  closeAll: (code: number, reason: string) => void;
  dispose: () => void;
};

export function createConnectionRegistry(deps: {
  logger: Logger;
  heartbeat: HeartbeatController;
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
  const now = deps.now ?? (() => Date.now());
  const createId = deps.createId ?? (() => randomUUID());

  const remove = (connectionId: string): void => {
    const existing = connections.get(connectionId);
    if (!existing) {
      return;
    }
    deps.heartbeat.stop(existing.socket);
    const timer = lifetimeTimers.get(connectionId);
    if (timer) {
      clearTimeout(timer);
      lifetimeTimers.delete(connectionId);
    }
    connections.delete(connectionId);
  };

  const closeSocket = (
    connection: AuthenticatedConnection,
    code: number,
    reason: string,
    errorCode?: (typeof ErrorCode)[keyof typeof ErrorCode],
  ): void => {
    try {
      if (errorCode && connection.socket.readyState === connection.socket.OPEN) {
        safeJsonSend(
          (data) => connection.socket.send(data),
          buildConnectionError({ code: errorCode }),
        );
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
      };

      connections.set(connection.id, connection);

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
        const diagnostic = ClientDiagnosticSchema.safeParse(parsed);
        if (!diagnostic.success) {
          closeSocket(connection, 1003, "unsupported", ErrorCode.PROTOCOL_UNSUPPORTED);
          return;
        }
        // Application ping/pong is accepted as a no-op; transport ping/pong is authoritative.
        void diagnostic.data.type;
      });

      input.socket.on("close", () => {
        remove(connection.id);
        deps.logger.info({ connectionId: connection.id, playerId: connection.playerId }, "socket closed");
      });

      input.socket.on("error", (error) => {
        deps.logger.warn(
          { connectionId: connection.id, err: error.message },
          "socket error",
        );
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
    },
  };
}
