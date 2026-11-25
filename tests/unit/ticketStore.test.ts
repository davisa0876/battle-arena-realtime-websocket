import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { hashTicket } from "../../src/auth/ticketHash.js";
import {
  createTicketStore,
  TicketRejectedError,
  type RedisTicketClient,
} from "../../src/auth/ticketStore.js";

function makeTicket(): string {
  return randomBytes(32).toString("base64url");
}

describe("ticketStore.consume", () => {
  it("redeems a valid ticket once via GETDEL semantics", async () => {
    const ticket = makeTicket();
    const key = `battle-arena:ws-ticket:${hashTicket(ticket)}`;
    const storeMap = new Map<string, string>([
      [
        key,
        JSON.stringify({ user_id: 42, issued_at: "2026-11-25T19:00:00Z" }),
      ],
    ]);

    const redis: RedisTicketClient = {
      isReady: () => true,
      async getDel(k) {
        const value = storeMap.get(k) ?? null;
        storeMap.delete(k);
        return value;
      },
    };

    const store = createTicketStore({ redis, keyPrefix: "battle-arena:ws-ticket:" });
    const meta = await store.consume(ticket);
    expect(meta.user_id).toBe(42);

    await expect(store.consume(ticket)).rejects.toBeInstanceOf(TicketRejectedError);
  });

  it("rejects malformed tickets without touching redis", async () => {
    let called = false;
    const redis: RedisTicketClient = {
      isReady: () => true,
      async getDel() {
        called = true;
        return null;
      },
    };
    const store = createTicketStore({ redis, keyPrefix: "battle-arena:ws-ticket:" });
    await expect(store.consume("bad")).rejects.toMatchObject({ reason: "malformed" });
    expect(called).toBe(false);
  });

  it("fails closed when redis is unavailable", async () => {
    const redis: RedisTicketClient = {
      isReady: () => false,
      async getDel() {
        return null;
      },
    };
    const store = createTicketStore({ redis, keyPrefix: "battle-arena:ws-ticket:" });
    await expect(store.consume(makeTicket())).rejects.toMatchObject({
      reason: "redis_unavailable",
    });
  });

  it("rejects invalid payloads", async () => {
    const ticket = makeTicket();
    const redis: RedisTicketClient = {
      isReady: () => true,
      async getDel() {
        return JSON.stringify({ user_id: "nope" });
      },
    };
    const store = createTicketStore({ redis, keyPrefix: "battle-arena:ws-ticket:" });
    await expect(store.consume(ticket)).rejects.toMatchObject({ reason: "invalid_payload" });
  });
});
