import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { hashTicket } from "../../src/auth/ticketHash.js";
import { createRoomGrantStore } from "../../src/auth/roomGrantStore.js";
import { TicketRejectedError, type RedisTicketClient } from "../../src/auth/ticketStore.js";

function grantToken(): string {
  return randomBytes(32).toString("base64url");
}

describe("roomGrantStore", () => {
  it("redeems a grant once and binds room metadata", async () => {
    const grant = grantToken();
    const key = `battle-arena:ws-room-grant:${hashTicket(grant)}`;
    const map = new Map<string, string>([
      [
        key,
        JSON.stringify({
          user_id: 7,
          room_id: "11111111-1111-1111-1111-111111111111",
          room_version: 2,
          issued_at: "2026-11-25T22:00:00Z",
        }),
      ],
    ]);
    const redis: RedisTicketClient = {
      isReady: () => true,
      async getDel(k) {
        const value = map.get(k) ?? null;
        map.delete(k);
        return value;
      },
    };
    const store = createRoomGrantStore({ redis, keyPrefix: "battle-arena:ws-room-grant:" });
    const meta = await store.consume(grant);
    expect(meta.user_id).toBe(7);
    expect(meta.room_id).toBe("11111111-1111-1111-1111-111111111111");
    await expect(store.consume(grant)).rejects.toBeInstanceOf(TicketRejectedError);
  });
});
