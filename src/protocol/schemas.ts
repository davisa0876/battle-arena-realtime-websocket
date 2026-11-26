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
  payload: z
    .object({
      room_id: z.string().uuid(),
      version: z.number().int().positive(),
    })
    .strict(),
});

export const PvpInvitationChangedSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal("pvp.invitation.changed"),
  event_id: z.string().min(1),
  sent_at: z.string().datetime(),
  payload: z
    .object({
      invitation_id: z.string().uuid(),
    })
    .strict(),
});

/** Hint-only battle signal: IDs + monotonic version/sequence. No combat secrets. */
export const PvpBattleChangedSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal("pvp.battle.changed"),
  event_id: z.string().min(1),
  sent_at: z.string().datetime(),
  payload: z
    .object({
      room_id: z.string().uuid(),
      battle_id: z.string().uuid(),
      version: z.number().int().positive(),
      last_event_sequence: z.number().int().nonnegative(),
    })
    .strict(),
});

export const RoomSubscriptionRevokedSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal("room.subscription.revoked"),
  event_id: z.string().min(1),
  sent_at: z.string().datetime(),
  payload: z
    .object({
      room_id: z.string().uuid(),
      reason: z.string().min(1),
    })
    .strict(),
});

/** Client-facing typed notifications (discriminated by `type`). */
export const ClientNotificationSchema = z.discriminatedUnion("type", [
  PvpRoomChangedSchema,
  PvpInvitationChangedSchema,
  PvpBattleChangedSchema,
  RoomSubscriptionRevokedSchema,
]);

export type ClientNotification = z.infer<typeof ClientNotificationSchema>;

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

const notificationTargeting = {
  target_user_id: z.number().int().positive().nullable().optional(),
  target_room_id: z.string().uuid().nullable().optional(),
} as const;

const KNOWN_NOTIFICATION_TYPES = [
  "pvp.room.changed",
  "pvp.invitation.changed",
  "pvp.battle.changed",
  "room.subscription.revoked",
] as const;

/**
 * Redis Pub/Sub wire envelope. Known PvP / room types use strict hint-only payloads
 * (union includes `pvp.battle.changed`). Extra combat fields on known types fail closed.
 * Unknown future types remain loosely typed.
 */
export const NotificationEnvelopeSchema = z.union([
  PvpRoomChangedSchema.extend(notificationTargeting).extend({
    sent_at: z.string().min(1),
  }),
  PvpInvitationChangedSchema.extend(notificationTargeting).extend({
    sent_at: z.string().min(1),
  }),
  PvpBattleChangedSchema.extend(notificationTargeting).extend({
    sent_at: z.string().min(1),
  }),
  RoomSubscriptionRevokedSchema.extend(notificationTargeting).extend({
    sent_at: z.string().min(1),
  }),
  z.object({
    v: z.literal(1),
    type: z
      .string()
      .min(1)
      .refine((value) => !(KNOWN_NOTIFICATION_TYPES as readonly string[]).includes(value), {
        message: "known notification types must use the strict payload branch",
      }),
    event_id: z.string().min(1),
    sent_at: z.string().min(1),
    target_user_id: z.number().int().positive().nullable().optional(),
    target_room_id: z.string().uuid().nullable().optional(),
    payload: z.record(z.unknown()),
  }),
]);

export type NotificationEnvelope = z.infer<typeof NotificationEnvelopeSchema>;
