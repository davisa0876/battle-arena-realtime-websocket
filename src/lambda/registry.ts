import type { RedisClientType } from "redis";

/**
 * Durable connection registry for API Gateway WebSocket.
 *
 * The persistent server keeps sockets and room membership in process memory. Lambda
 * execution environments share no memory and may be frozen or recycled between
 * invocations, so every lookup goes through Redis (Upstash in AWS, Compose Redis locally).
 */
export type ConnectionRecord = {
  connectionId: string;
  playerId: number;
  sourceIp: string;
  connectedAt: number;
};

export type CountScope =
  | { kind: "all" }
  | { kind: "user"; playerId: number }
  | { kind: "ip"; ip: string };

export interface ConnectionRegistryStore {
  isReady(): boolean;
  countActive(scope: CountScope): Promise<number>;
  register(record: ConnectionRecord): Promise<void>;
  get(connectionId: string): Promise<ConnectionRecord | null>;
  /** Removes the connection exactly once. Returns the removed record, or null if already gone. */
  unregister(connectionId: string): Promise<ConnectionRecord | null>;
  roomCount(connectionId: string): Promise<number>;
  addRoom(connectionId: string, roomId: string): Promise<void>;
  removeRoom(connectionId: string, roomId: string): Promise<boolean>;
  connectionsForUser(playerId: number): Promise<string[]>;
  connectionsForRoom(roomId: string): Promise<string[]>;
  /** Drops every subscription to a room and returns the former subscriber connection IDs. */
  dropRoom(roomId: string): Promise<string[]>;
}

export function createRedisConnectionRegistry(deps: {
  redis: RedisClientType;
  prefix: string;
  ttlSeconds: number;
  now?: () => number;
}): ConnectionRegistryStore {
  const now = deps.now ?? (() => Date.now());
  const p = deps.prefix;
  const connKey = (id: string): string => `${p}conn:${id}`;
  const connRoomsKey = (id: string): string => `${p}conn:${id}:rooms`;
  const allKey = `${p}idx:all`;
  const userKey = (playerId: number): string => `${p}idx:user:${playerId}`;
  const ipKey = (ip: string): string => `${p}idx:ip:${ip}`;
  const roomKey = (roomId: string): string => `${p}idx:room:${roomId}`;

  const scopeKey = (scope: CountScope): string => {
    switch (scope.kind) {
      case "all":
        return allKey;
      case "user":
        return userKey(scope.playerId);
      case "ip":
        return ipKey(scope.ip);
    }
  };

  // Sorted-set scores are expiry timestamps so stale members (missed $disconnect) age out.
  const liveMembers = async (key: string): Promise<string[]> =>
    deps.redis.zRangeByScore(key, String(now()), "+inf");

  return {
    isReady() {
      return deps.redis.isReady;
    },

    async countActive(scope) {
      return deps.redis.zCount(scopeKey(scope), String(now()), "+inf");
    },

    async register(record) {
      const expiresAt = now() + deps.ttlSeconds * 1000;
      const ttl = deps.ttlSeconds;
      await deps.redis
        .multi()
        .hSet(connKey(record.connectionId), {
          player_id: String(record.playerId),
          source_ip: record.sourceIp,
          connected_at: String(record.connectedAt),
        })
        .expire(connKey(record.connectionId), ttl)
        .zAdd(allKey, { score: expiresAt, value: record.connectionId })
        .expire(allKey, ttl)
        .zAdd(userKey(record.playerId), { score: expiresAt, value: record.connectionId })
        .expire(userKey(record.playerId), ttl)
        .zAdd(ipKey(record.sourceIp), { score: expiresAt, value: record.connectionId })
        .expire(ipKey(record.sourceIp), ttl)
        .zRemRangeByScore(allKey, "-inf", String(now()))
        .exec();
    },

    async get(connectionId) {
      const raw = await deps.redis.hGetAll(connKey(connectionId));
      return parseRecord(connectionId, raw);
    },

    async unregister(connectionId) {
      const raw = await deps.redis.hGetAll(connKey(connectionId));
      const record = parseRecord(connectionId, raw);
      if (!record) {
        return null;
      }
      // DEL is the single-winner claim so $disconnect and a 410 cleanup never double-count.
      const deleted = await deps.redis.del(connKey(connectionId));
      if (deleted === 0) {
        return null;
      }
      const rooms = await deps.redis.sMembers(connRoomsKey(connectionId));
      const tx = deps.redis
        .multi()
        .del(connRoomsKey(connectionId))
        .zRem(allKey, connectionId)
        .zRem(userKey(record.playerId), connectionId)
        .zRem(ipKey(record.sourceIp), connectionId);
      for (const roomId of rooms) {
        tx.zRem(roomKey(roomId), connectionId);
      }
      await tx.exec();
      return record;
    },

    async roomCount(connectionId) {
      return deps.redis.sCard(connRoomsKey(connectionId));
    },

    async addRoom(connectionId, roomId) {
      const ttl = deps.ttlSeconds;
      await deps.redis
        .multi()
        .sAdd(connRoomsKey(connectionId), roomId)
        .expire(connRoomsKey(connectionId), ttl)
        .zAdd(roomKey(roomId), { score: now() + ttl * 1000, value: connectionId })
        .expire(roomKey(roomId), ttl)
        .exec();
    },

    async removeRoom(connectionId, roomId) {
      const removed = await deps.redis.sRem(connRoomsKey(connectionId), roomId);
      await deps.redis.zRem(roomKey(roomId), connectionId);
      return removed > 0;
    },

    async connectionsForUser(playerId) {
      return liveMembers(userKey(playerId));
    },

    async connectionsForRoom(roomId) {
      return liveMembers(roomKey(roomId));
    },

    async dropRoom(roomId) {
      const members = await liveMembers(roomKey(roomId));
      const tx = deps.redis.multi().del(roomKey(roomId));
      for (const connectionId of members) {
        tx.sRem(connRoomsKey(connectionId), roomId);
      }
      await tx.exec();
      return members;
    },
  };
}

function parseRecord(connectionId: string, raw: Record<string, string>): ConnectionRecord | null {
  const playerId = Number(raw.player_id);
  if (!Number.isInteger(playerId) || playerId <= 0) {
    return null;
  }
  return {
    connectionId,
    playerId,
    sourceIp: raw.source_ip ?? "unknown",
    connectedAt: Number(raw.connected_at ?? 0),
  };
}
