import { randomUUID } from "node:crypto";

import {
  ConnectionErrorSchema,
  ConnectionReadySchema,
  PROTOCOL_VERSION,
  type ConnectionErrorMessage,
  type ConnectionReadyMessage,
  type ErrorCodeName,
} from "../protocol/schemas.js";

export function buildConnectionReady(input: {
  connectionId: string;
  playerId: number;
  heartbeatIntervalMs: number;
  now?: () => Date;
  eventId?: string;
}): ConnectionReadyMessage {
  const now = input.now ?? (() => new Date());
  const message = {
    v: PROTOCOL_VERSION,
    type: "connection.ready" as const,
    event_id: input.eventId ?? randomUUID(),
    sent_at: now().toISOString(),
    payload: {
      connection_id: input.connectionId,
      player_id: input.playerId,
      heartbeat_interval_ms: input.heartbeatIntervalMs,
    },
  };
  return ConnectionReadySchema.parse(message);
}

export function buildConnectionError(input: {
  code: ErrorCodeName;
  now?: () => Date;
  eventId?: string;
}): ConnectionErrorMessage {
  const now = input.now ?? (() => new Date());
  const message = {
    v: PROTOCOL_VERSION,
    type: "connection.error" as const,
    event_id: input.eventId ?? randomUUID(),
    sent_at: now().toISOString(),
    payload: {
      code: input.code,
    },
  };
  return ConnectionErrorSchema.parse(message);
}

export function safeJsonSend(
  send: (data: string) => void,
  message: ConnectionReadyMessage | ConnectionErrorMessage,
): void {
  send(JSON.stringify(message));
}
