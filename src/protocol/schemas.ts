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

/** Optional diagnostic frames only — no gameplay commands in Phase 5A. */
export const ClientDiagnosticSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.enum(["ping", "pong"]),
});

export type ClientDiagnosticMessage = z.infer<typeof ClientDiagnosticSchema>;

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
} as const;

export type ErrorCodeName = (typeof ErrorCode)[keyof typeof ErrorCode];
