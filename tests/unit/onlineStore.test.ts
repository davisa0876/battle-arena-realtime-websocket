import { describe, expect, it, vi } from "vitest";

import { createOnlinePresenceStore } from "../../src/presence/onlineStore.js";

function fakeRedis() {
  const set = new Set<string>();
  const hash = new Map<string, number>();
  return {
    isReady: true,
    async hIncrBy(_key: string, field: string, by: number) {
      const next = (hash.get(field) ?? 0) + by;
      hash.set(field, next);
      return next;
    },
    async hDel(_key: string, field: string) {
      hash.delete(field);
      return 1;
    },
    async sAdd(_key: string, member: string) {
      set.add(member);
      return 1;
    },
    async sRem(_key: string, member: string) {
      set.delete(member);
      return 1;
    },
    snapshot() {
      return { set: [...set], hash: Object.fromEntries(hash) };
    },
  };
}

describe("online presence store", () => {
  it("adds on first connect and removes after last disconnect", async () => {
    const redis = fakeRedis();
    const store = createOnlinePresenceStore({
      redis: redis as never,
      onlineSetKey: "online",
      connHashKey: "conns",
      logger: { warn: vi.fn() } as never,
    });

    await store.trackConnect(7);
    await store.trackConnect(7);
    expect(redis.snapshot()).toEqual({ set: ["7"], hash: { "7": 2 } });

    await store.trackDisconnect(7);
    expect(redis.snapshot()).toEqual({ set: ["7"], hash: { "7": 1 } });

    await store.trackDisconnect(7);
    expect(redis.snapshot()).toEqual({ set: [], hash: {} });
  });
});
