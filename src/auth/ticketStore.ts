import { z } from "zod";

import { hashTicket, isWellFormedTicket } from "./ticketHash.js";

export const TicketMetadataSchema = z.object({
  user_id: z.number().int().positive(),
  issued_at: z.string().min(1),
  session_id: z.string().optional(),
  token_id: z.string().optional(),
});

export type TicketMetadata = z.infer<typeof TicketMetadataSchema>;

export type TicketRejectReason =
  | "malformed"
  | "missing"
  | "invalid_payload"
  | "redis_unavailable";

export class TicketRejectedError extends Error {
  readonly reason: TicketRejectReason;

  constructor(reason: TicketRejectReason, message?: string) {
    super(message ?? reason);
    this.name = "TicketRejectedError";
    this.reason = reason;
  }
}

export interface RedisTicketClient {
  getDel(key: string): Promise<string | null>;
  isReady(): boolean;
}

export interface TicketStore {
  consume(ticket: string): Promise<TicketMetadata>;
}

export function createTicketStore(deps: {
  redis: RedisTicketClient;
  keyPrefix: string;
}): TicketStore {
  return {
    async consume(ticket: string): Promise<TicketMetadata> {
      if (!isWellFormedTicket(ticket)) {
        throw new TicketRejectedError("malformed");
      }

      if (!deps.redis.isReady()) {
        throw new TicketRejectedError("redis_unavailable");
      }

      const key = `${deps.keyPrefix}${hashTicket(ticket)}`;

      let raw: string | null;
      try {
        raw = await deps.redis.getDel(key);
      } catch {
        throw new TicketRejectedError("redis_unavailable");
      }

      if (raw === null) {
        throw new TicketRejectedError("missing");
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        throw new TicketRejectedError("invalid_payload");
      }

      const meta = TicketMetadataSchema.safeParse(parsed);
      if (!meta.success) {
        throw new TicketRejectedError("invalid_payload");
      }

      return meta.data;
    },
  };
}
