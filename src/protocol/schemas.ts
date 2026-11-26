import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;

export const ConnectionReadySchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal("connection.ready"),
  event_id: z.string().min(1),
  sent_at: z.string().datetime(),
  payload: z.object({
    connection_id: z.string().min(1),
    player_id: z.number().int().positive(),
    heartbeat_interval_ms: z.number().int().positive(),
  }),
});

export type ConnectionReadyMessage = z.infer<typeof ConnectionReadySchema>;

export const ConnectionErrorSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal("connection.error"),
  event_id: z.string().min(1),
  sent_at: z.string().datetime(),
  payload: z.object({
    code: z.string().min(1),
  }),
});

export type ConnectionErrorMessage = z.infer<typeof ConnectionErrorSchema>;

export const ClientDiagnosticSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.enum(["ping", "pong"]),
});

export type ClientDiagnosticMessage = z.infer<typeof ClientDiagnosticSchema>;

export const RoomSubscribeSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal("room.subscribe"),
  request_id: z.string().min(1).optional(),
  payload: z.object({
    grant: z.string().min(32).max(128),
  }),
});

export type RoomSubscribeMessage = z.infer<typeof RoomSubscribeSchema>;

export const RoomUnsubscribeSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal("room.unsubscribe"),
  request_id: z.string().min(1).optional(),
  payload: z.object({
    room_id: z.string().uuid(),
  }),
});

export type RoomUnsubscribeMessage = z.infer<typeof RoomUnsubscribeSchema>;

export const RoomSubscribedSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal("room.subscribed"),
  event_id: z.string().min(1),
  sent_at: z.string().datetime(),
  payload: z.object({
    room_id: z.string().uuid(),
    version: z.number().int().positive().optional(),
  }),
});

export type RoomSubscribedMessage = z.infer<typeof RoomSubscribedSchema>;

export const PvpRoomChangedSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal("pvp.room.changed"),
  event_id: z.string().min(1),
  sent_at: z.string().datetime(),
  payload: z.object({
    room_id: z.string().uuid(),
    version: z.number().int().positive(),
  }),
});

export const PvpInvitationChangedSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal("pvp.invitation.changed"),
  event_id: z.string().min(1),
  sent_at: z.string().datetime(),
  payload: z.object({
    invitation_id: z.string().uuid(),
  }),
});

export const RoomSubscriptionRevokedSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal("room.subscription.revoked"),
  event_id: z.string().min(1),
  sent_at: z.string().datetime(),
  payload: z.object({
    room_id: z.string().uuid(),
    reason: z.string().min(1),
  }),
});

export const ErrorCode = {
  TICKET_MISSING: "TICKET_MISSING",
  TICKET_INVALID: "TICKET_INVALID",
  TICKET_MALFORMED: "TICKET_MALFORMED",
  ORIGIN_REJECTED: "ORIGIN_REJECTED",
  REDIS_UNAVAILABLE: "REDIS_UNAVAILABLE",
  PROTOCOL_UNSUPPORTED: "PROTOCOL_UNSUPPORTED",
  RATE_LIMITED: "RATE_LIMITED",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  CONNECTION_LIMIT: "CONNECTION_LIMIT",
  SHUTTING_DOWN: "SHUTTING_DOWN",
  LIFETIME_EXCEEDED: "LIFETIME_EXCEEDED",
  HEARTBEAT_TIMEOUT: "HEARTBEAT_TIMEOUT",
  GRANT_INVALID: "GRANT_INVALID",
  GRANT_MISMATCH: "GRANT_MISMATCH",
  GRANT_MALFORMED: "GRANT_MALFORMED",
  ROOM_NOT_SUBSCRIBED: "ROOM_NOT_SUBSCRIBED",
} as const;

export type ErrorCodeName = (typeof ErrorCode)[keyof typeof ErrorCode];

export const NotificationEnvelopeSchema = z.object({
  v: z.literal(1),
  type: z.string().min(1),
  event_id: z.string().min(1),
  sent_at: z.string().min(1),
  target_user_id: z.number().int().positive().nullable().optional(),
  target_room_id: z.string().uuid().nullable().optional(),
  payload: z.record(z.unknown()),
});

export type NotificationEnvelope = z.infer<typeof NotificationEnvelopeSchema>;
