import { randomUUID } from "node:crypto";

import {
  ConnectionErrorSchema,
  ConnectionReadySchema,
  PROTOCOL_VERSION,
  RoomSubscribedSchema,
  type ConnectionErrorMessage,
  type ConnectionReadyMessage,
  type ErrorCodeName,
  type RoomSubscribedMessage,
} from "../protocol/schemas.js";

export function buildConnectionReady(input: {
  connectionId: string;
  playerId: number;
  heartbeatIntervalMs: number;
  now?: () => Date;
  eventId?: string;
}): ConnectionReadyMessage {
  const now = input.now ?? (() => new Date());
  return ConnectionReadySchema.parse({
    v: PROTOCOL_VERSION,
    type: "connection.ready",
    event_id: input.eventId ?? randomUUID(),
    sent_at: now().toISOString(),
    payload: {
      connection_id: input.connectionId,
      player_id: input.playerId,
      heartbeat_interval_ms: input.heartbeatIntervalMs,
    },
  });
}

export function buildConnectionError(input: {
  code: ErrorCodeName;
  now?: () => Date;
  eventId?: string;
}): ConnectionErrorMessage {
  const now = input.now ?? (() => new Date());
  return ConnectionErrorSchema.parse({
    v: PROTOCOL_VERSION,
    type: "connection.error",
    event_id: input.eventId ?? randomUUID(),
    sent_at: now().toISOString(),
    payload: { code: input.code },
  });
}

export function buildRoomSubscribed(input: {
  roomId: string;
  version?: number;
  now?: () => Date;
  eventId?: string;
}): RoomSubscribedMessage {
  const now = input.now ?? (() => new Date());
  return RoomSubscribedSchema.parse({
    v: PROTOCOL_VERSION,
    type: "room.subscribed",
    event_id: input.eventId ?? randomUUID(),
    sent_at: now().toISOString(),
    payload: {
      room_id: input.roomId,
      ...(input.version !== undefined ? { version: input.version } : {}),
    },
  });
}

export function safeJsonSend(
  send: (data: string) => void,
  message: Record<string, unknown>,
): void {
  send(JSON.stringify(message));
}
