import type { Logger } from "pino";
import type { RedisClientType } from "redis";

export type OnlinePresenceStore = {
  trackConnect: (playerId: number) => Promise<void>;
  trackDisconnect: (playerId: number) => Promise<void>;
};

/**
 * Redis-backed WS presence: SET of online player IDs + HASH of connection counts.
 * Multi-tab safe via refcount; best-effort (failures are logged, never throw to callers).
 */
export function createOnlinePresenceStore(deps: {
  redis: RedisClientType;
  onlineSetKey: string;
  connHashKey: string;
  logger: Logger;
}): OnlinePresenceStore {
  const field = (playerId: number): string => String(playerId);

  return {
    async trackConnect(playerId) {
      if (!deps.redis.isReady) {
        return;
      }
      try {
        const count = await deps.redis.hIncrBy(deps.connHashKey, field(playerId), 1);
        if (count === 1) {
          await deps.redis.sAdd(deps.onlineSetKey, field(playerId));
        }
      } catch (error) {
        deps.logger.warn(
          { err: error instanceof Error ? error.message : String(error), playerId },
          "presence trackConnect failed",
        );
      }
    },

    async trackDisconnect(playerId) {
      if (!deps.redis.isReady) {
        return;
      }
      try {
        const count = await deps.redis.hIncrBy(deps.connHashKey, field(playerId), -1);
        if (count <= 0) {
          await deps.redis.hDel(deps.connHashKey, field(playerId));
          await deps.redis.sRem(deps.onlineSetKey, field(playerId));
        }
      } catch (error) {
        deps.logger.warn(
          { err: error instanceof Error ? error.message : String(error), playerId },
          "presence trackDisconnect failed",
        );
      }
    },
  };
}
