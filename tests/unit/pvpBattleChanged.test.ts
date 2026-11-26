import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

import {
  ClientNotificationSchema,
  NotificationEnvelopeSchema,
  PvpBattleChangedSchema,
} from "../../src/protocol/schemas.js";
import { createLogger } from "../../src/observability/logger.js";
import { createConnectionRegistry } from "../../src/websocket/connections.js";
import { createHeartbeatController } from "../../src/websocket/heartbeat.js";

const ROOM_ID = "11111111-1111-4111-8111-111111111111";
const BATTLE_ID = "22222222-2222-4222-8222-222222222222";

function validBattleChangedFrame() {
  return {
    v: 1 as const,
    type: "pvp.battle.changed" as const,
    event_id: "evt-battle-1",
    sent_at: "2026-11-25T22:00:00.000Z",
    payload: {
      room_id: ROOM_ID,
      battle_id: BATTLE_ID,
      version: 4,
      last_event_sequence: 12,
    },
  };
}

function mockSocket(sent: unknown[]): WebSocket {
  const emitter = new EventEmitter();
  const socket = Object.assign(emitter, {
    readyState: 1,
    OPEN: 1,
    bufferedAmount: 0,
    send(data: string) {
      sent.push(JSON.parse(data));
    },
    close() {},
    terminate() {},
  });
  return socket as unknown as WebSocket;
}

describe("pvp.battle.changed schema", () => {
  it("parses a valid hint-only envelope", () => {
    const frame = validBattleChangedFrame();
    expect(PvpBattleChangedSchema.parse(frame)).toEqual(frame);
    expect(ClientNotificationSchema.parse(frame).type).toBe("pvp.battle.changed");

    const wire = {
      ...frame,
      target_room_id: ROOM_ID,
      target_user_id: null,
    };
    expect(NotificationEnvelopeSchema.parse(wire).type).toBe("pvp.battle.changed");
  });

  it("rejects envelopes that include combat secrets (strict payload)", () => {
    const withSecrets = {
      ...validBattleChangedFrame(),
      payload: {
        ...validBattleChangedFrame().payload,
        damage: 42,
        hp_current: 10,
        move_id: 55,
        rng_seed: "secret",
      },
    };

    expect(PvpBattleChangedSchema.safeParse(withSecrets).success).toBe(false);
    expect(ClientNotificationSchema.safeParse(withSecrets).success).toBe(false);
    expect(
      NotificationEnvelopeSchema.safeParse({
        ...withSecrets,
        target_room_id: ROOM_ID,
      }).success,
    ).toBe(false);
  });
});

describe("pvp.battle.changed room fanout", () => {
  it("delivers to room subscribers only", async () => {
    const subscriberSent: unknown[] = [];
    const outsiderSent: unknown[] = [];
    const logger = createLogger({ level: "silent" });
    const heartbeat = createHeartbeatController({
      intervalMs: 60_000,
      timeoutMs: 120_000,
    });

    const roomGrantStore = {
      consume: vi.fn(async () => ({
        user_id: 1,
        room_id: ROOM_ID,
        room_version: 2,
        issued_at: "2026-11-25T22:00:00Z",
      })),
    };

    const registry = createConnectionRegistry({
      logger,
      heartbeat,
      roomGrantStore,
      limits: { maxConnections: 10, maxPerUser: 5, maxPerIp: 5 },
    });

    const subscriber = registry.accept({
      socket: mockSocket(subscriberSent),
      playerId: 1,
      remoteIp: "127.0.0.1",
      heartbeatIntervalMs: 30_000,
      maxLifetimeMs: 60_000,
      maxBufferedBytes: 64_000,
      maxPayloadBytes: 8192,
    });
    const outsider = registry.accept({
      socket: mockSocket(outsiderSent),
      playerId: 2,
      remoteIp: "127.0.0.1",
      heartbeatIntervalMs: 30_000,
      maxLifetimeMs: 60_000,
      maxBufferedBytes: 64_000,
      maxPayloadBytes: 8192,
    });

    expect(subscriber).not.toBeNull();
    expect(outsider).not.toBeNull();

    subscriberSent.length = 0;
    outsiderSent.length = 0;

    const grant = "a".repeat(32);
    (subscriber!.socket as unknown as EventEmitter).emit(
      "message",
      JSON.stringify({
        v: 1,
        type: "room.subscribe",
        payload: { grant },
      }),
      false,
    );

    await vi.waitFor(() => {
      expect(roomGrantStore.consume).toHaveBeenCalled();
      expect(subscriber!.roomIds.has(ROOM_ID)).toBe(true);
    });

    subscriberSent.length = 0;
    outsiderSent.length = 0;

    const envelope = NotificationEnvelopeSchema.parse({
      ...validBattleChangedFrame(),
      target_room_id: ROOM_ID,
      target_user_id: null,
    });

    registry.deliverNotification(envelope);

    expect(subscriberSent).toHaveLength(1);
    expect(subscriberSent[0]).toMatchObject({
      type: "pvp.battle.changed",
      payload: {
        room_id: ROOM_ID,
        battle_id: BATTLE_ID,
        version: 4,
        last_event_sequence: 12,
      },
    });
    expect(outsiderSent).toHaveLength(0);

    registry.dispose();
  });
});
