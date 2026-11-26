import { z } from "zod";

import { hashTicket, isWellFormedTicket } from "./ticketHash.js";
import { TicketRejectedError, type RedisTicketClient } from "./ticketStore.js";

export const RoomGrantMetadataSchema = z.object({
  user_id: z.number().int().positive(),
  room_id: z.string().uuid(),
  room_version: z.number().int().positive().optional(),
  issued_at: z.string().min(1),
});

export type RoomGrantMetadata = z.infer<typeof RoomGrantMetadataSchema>;

export interface RoomGrantStore {
  consume(grant: string): Promise<RoomGrantMetadata>;
}

export function createRoomGrantStore(deps: {
  redis: RedisTicketClient;
  keyPrefix: string;
}): RoomGrantStore {
  return {
    async consume(grant: string): Promise<RoomGrantMetadata> {
      if (!isWellFormedTicket(grant)) {
        throw new TicketRejectedError("malformed");
      }
      if (!deps.redis.isReady()) {
        throw new TicketRejectedError("redis_unavailable");
      }

      const key = `${deps.keyPrefix}${hashTicket(grant)}`;
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

      const meta = RoomGrantMetadataSchema.safeParse(parsed);
      if (!meta.success) {
        throw new TicketRejectedError("invalid_payload");
      }

      return meta.data;
    },
  };
}
