import { createHash, randomBytes, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createRoomGrantStore } from "../../src/auth/roomGrantStore.js";
import { createTicketStore, type RedisTicketClient } from "../../src/auth/ticketStore.js";
import {
  createRealtimeLambdaCore,
  READY_EVENT_KIND,
  type ApiGatewayWebSocketEvent,
  type ConnectionReadyEvent,
} from "../../src/lambda/core.js";
import type {
  ConnectionRecord,
  ConnectionRegistryStore,
  CountScope,
} from "../../src/lambda/registry.js";
import type { ConnectionPoster, PostOutcome } from "../../src/lambda/transport.js";
import { createLogger } from "../../src/observability/logger.js";
import type { OnlinePresenceStore } from "../../src/presence/onlineStore.js";

const TICKET_PREFIX = "t:";
const GRANT_PREFIX = "g:";

function opaque(): string {
  return randomBytes(32).toString("base64url");
}

function sha(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function memoryRegistry(): ConnectionRegistryStore & { records: Map<string, ConnectionRecord> } {
  const records = new Map<string, ConnectionRecord>();
  const rooms = new Map<string, Set<string>>();
  const roomsOf = (id: string): Set<string> => {
    const set = rooms.get(id) ?? new Set<string>();
    rooms.set(id, set);
    return set;
  };
  const matches = (scope: CountScope, r: ConnectionRecord): boolean =>
    scope.kind === "all" ||
    (scope.kind === "user" && r.playerId === scope.playerId) ||
    (scope.kind === "ip" && r.sourceIp === scope.ip);

  return {
    records,
    isReady: () => true,
    async countActive(scope) {
      return [...records.values()].filter((r) => matches(scope, r)).length;
    },
    async register(record) {
      records.set(record.connectionId, record);
    },
    async get(id) {
      return records.get(id) ?? null;
    },
    async unregister(id) {
      const record = records.get(id) ?? null;
      records.delete(id);
      rooms.delete(id);
      return record;
    },
    async roomCount(id) {
      return roomsOf(id).size;
    },
    async addRoom(id, roomId) {
      roomsOf(id).add(roomId);
    },
    async removeRoom(id, roomId) {
      return roomsOf(id).delete(roomId);
    },
    async connectionsForUser(playerId) {
      return [...records.values()].filter((r) => r.playerId === playerId).map((r) => r.connectionId);
    },
    async connectionsForRoom(roomId) {
      return [...records.keys()].filter((id) => roomsOf(id).has(roomId));
    },
    async dropRoom(roomId) {
      const members = [...records.keys()].filter((id) => roomsOf(id).has(roomId));
      for (const id of members) {
        roomsOf(id).delete(roomId);
      }
      return members;
    },
  };
}

function setup(overrides: { goneUntilAttempt?: number } = {}) {
  const kv = new Map<string, string>();
  const redis: RedisTicketClient = {
    isReady: () => true,
    async getDel(key) {
      const value = kv.get(key) ?? null;
      kv.delete(key);
      return value;
    },
  };
  const registry = memoryRegistry();
  const sent: Array<{ connectionId: string; frame: Record<string, unknown> }> = [];
  const closed: string[] = [];
  const goneIds = new Set<string>();
  let readyAttempts = 0;
  const poster: ConnectionPoster = {
    async post(connectionId, data): Promise<PostOutcome> {
      const frame = JSON.parse(data) as Record<string, unknown>;
      if (frame.type === "connection.ready") {
        readyAttempts += 1;
        if (readyAttempts <= (overrides.goneUntilAttempt ?? 0)) {
          return "gone";
        }
      }
      if (goneIds.has(connectionId)) {
        return "gone";
      }
      sent.push({ connectionId, frame });
      return "ok";
    },
    async close(connectionId) {
      closed.push(connectionId);
    },
  };
  const presenceCounts = new Map<number, number>();
  const presence: OnlinePresenceStore = {
    async trackConnect(playerId) {
      presenceCounts.set(playerId, (presenceCounts.get(playerId) ?? 0) + 1);
    },
    async trackDisconnect(playerId) {
      presenceCounts.set(playerId, (presenceCounts.get(playerId) ?? 0) - 1);
    },
  };
  const readyEvents: ConnectionReadyEvent[] = [];

  const core = createRealtimeLambdaCore({
    settings: {
      allowedOrigins: ["http://localhost:3000"],
      allowMissingOrigin: true,
      heartbeatIntervalMs: 30_000,
      maxPayloadBytes: 8_192,
      maxRoomsPerConnection: 2,
      maxConnections: 100,
      maxConnectionsPerUser: 2,
      maxConnectionsPerIp: 10,
      readyDeliveryAttempts: 4,
      readyDeliveryBaseDelayMs: 1,
    },
    logger: createLogger({ level: "silent" }),
    registry,
    tickets: createTicketStore({ redis, keyPrefix: TICKET_PREFIX }),
    grants: createRoomGrantStore({ redis, keyPrefix: GRANT_PREFIX }),
    presence,
    poster,
    invokeReady: async (event) => {
      readyEvents.push(event);
    },
    sleep: async () => undefined,
  });

  const issueTicket = (userId: number): string => {
    const ticket = opaque();
    kv.set(`${TICKET_PREFIX}${sha(ticket)}`, JSON.stringify({ user_id: userId, issued_at: "now" }));
    return ticket;
  };
  const issueGrant = (userId: number, roomId: string): string => {
    const grant = opaque();
    kv.set(
      `${GRANT_PREFIX}${sha(grant)}`,
      JSON.stringify({ user_id: userId, room_id: roomId, room_version: 3, issued_at: "now" }),
    );
    return grant;
  };

  const connectEvent = (
    connectionId: string,
    query: Record<string, string> | null,
    origin?: string,
  ): ApiGatewayWebSocketEvent => ({
    requestContext: {
      routeKey: "$connect",
      eventType: "CONNECT",
      connectionId,
      identity: { sourceIp: "10.0.0.1" },
    },
    headers: origin ? { Origin: origin } : {},
    queryStringParameters: query,
  });

  const messageEvent = (connectionId: string, body: unknown, raw = false): ApiGatewayWebSocketEvent => ({
    requestContext: { routeKey: "$default", eventType: "MESSAGE", connectionId },
    body: raw ? String(body) : JSON.stringify(body),
    isBase64Encoded: false,
  });

  const connect = async (connectionId: string, userId: number) => {
    const result = await core.dispatch(
      connectEvent(connectionId, { ticket: issueTicket(userId) }, "http://localhost:3000"),
    );
    await core.dispatch({ kind: READY_EVENT_KIND, connection_id: connectionId });
    return result;
  };

  return {
    core,
    registry,
    sent,
    closed,
    goneIds,
    presenceCounts,
    readyEvents,
    issueTicket,
    issueGrant,
    connectEvent,
    messageEvent,
    connect,
    readyAttempts: () => readyAttempts,
  };
}

describe("realtime Lambda core ($connect)", () => {
  it("accepts a valid ticket, registers presence and defers connection.ready", async () => {
    const t = setup();
    const result = await t.core.dispatch(
      t.connectEvent("c1", { ticket: t.issueTicket(7) }, "http://localhost:3000"),
    );
    expect(result).toEqual({ statusCode: 200 });
    expect(t.sent).toHaveLength(0);
    expect(t.readyEvents).toEqual([{ kind: READY_EVENT_KIND, connection_id: "c1" }]);
    expect(t.presenceCounts.get(7)).toBe(1);

    await t.core.dispatch(t.readyEvents[0]);
    expect(t.sent[0]?.frame).toMatchObject({
      v: 1,
      type: "connection.ready",
      payload: { connection_id: "c1", player_id: 7, heartbeat_interval_ms: 30_000 },
    });
  });

  it("retries connection.ready while API Gateway still reports the connection as gone", async () => {
    const t = setup({ goneUntilAttempt: 2 });
    await t.connect("c1", 7);
    expect(t.readyAttempts()).toBe(3);
    expect(t.sent.map((s) => s.frame.type)).toEqual(["connection.ready"]);
  });

  it("drops the registration when connection.ready can never be delivered", async () => {
    const t = setup({ goneUntilAttempt: 99 });
    await t.connect("c1", 7);
    expect(t.registry.records.has("c1")).toBe(false);
    expect(t.presenceCounts.get(7)).toBe(0);
  });

  it("rejects disallowed browser origins before touching the ticket", async () => {
    const t = setup();
    const ticket = t.issueTicket(7);
    const result = await t.core.dispatch(t.connectEvent("c1", { ticket }, "https://evil.example"));
    expect(result).toMatchObject({ statusCode: 403, body: JSON.stringify({ error: "ORIGIN_REJECTED" }) });
    // Ticket was not consumed, so a legitimate retry still works.
    expect(await t.core.dispatch(t.connectEvent("c2", { ticket }))).toEqual({ statusCode: 200 });
  });

  it("rejects missing, duplicate and reused tickets", async () => {
    const t = setup();
    expect(await t.core.dispatch(t.connectEvent("c1", null))).toMatchObject({ statusCode: 401 });

    const dup = t.connectEvent("c2", { ticket: t.issueTicket(7) });
    dup.multiValueQueryStringParameters = { ticket: ["a", "b"] };
    expect(await t.core.dispatch(dup)).toMatchObject({ statusCode: 400 });

    const ticket = t.issueTicket(7);
    expect(await t.core.dispatch(t.connectEvent("c3", { ticket }))).toEqual({ statusCode: 200 });
    expect(await t.core.dispatch(t.connectEvent("c4", { ticket }))).toMatchObject({
      statusCode: 401,
      body: JSON.stringify({ error: "TICKET_INVALID" }),
    });
  });

  it("enforces the per-user connection limit across invocations", async () => {
    const t = setup();
    await t.connect("c1", 7);
    await t.connect("c2", 7);
    const result = await t.core.dispatch(t.connectEvent("c3", { ticket: t.issueTicket(7) }));
    expect(result).toMatchObject({ statusCode: 429 });
  });
});

describe("realtime Lambda core ($default / $disconnect)", () => {
  it("subscribes with a matching grant and rejects grants for another user", async () => {
    const t = setup();
    const room = randomUUID();
    await t.connect("c1", 7);

    await t.core.dispatch(
      t.messageEvent("c1", { v: 1, type: "room.subscribe", payload: { grant: t.issueGrant(8, room) } }),
    );
    expect(t.sent.at(-1)?.frame).toMatchObject({ type: "connection.error", payload: { code: "GRANT_MISMATCH" } });

    await t.core.dispatch(
      t.messageEvent("c1", { v: 1, type: "room.subscribe", payload: { grant: t.issueGrant(7, room) } }),
    );
    expect(t.sent.at(-1)?.frame).toMatchObject({
      type: "room.subscribed",
      payload: { room_id: room, version: 3 },
    });
    expect(await t.registry.connectionsForRoom(room)).toEqual(["c1"]);
  });

  it("ignores diagnostics, unsubscribes, and closes on unsupported frames", async () => {
    const t = setup();
    await t.connect("c1", 7);
    const before = t.sent.length;
    await t.core.dispatch(t.messageEvent("c1", { v: 1, type: "ping" }));
    expect(t.sent.length).toBe(before);

    await t.core.dispatch(
      t.messageEvent("c1", { v: 1, type: "room.unsubscribe", payload: { room_id: randomUUID() } }),
    );
    expect(t.sent.at(-1)?.frame).toMatchObject({ payload: { code: "ROOM_NOT_SUBSCRIBED" } });

    await t.core.dispatch(t.messageEvent("c1", { v: 1, type: "battle.attack" }));
    expect(t.sent.at(-1)?.frame).toMatchObject({ payload: { code: "PROTOCOL_UNSUPPORTED" } });
    expect(t.closed).toEqual(["c1"]);
    expect(t.registry.records.has("c1")).toBe(false);
    expect(t.presenceCounts.get(7)).toBe(0);
  });

  it("closes oversized and non-JSON frames", async () => {
    const t = setup();
    await t.connect("c1", 7);
    await t.core.dispatch(t.messageEvent("c1", "x".repeat(9_000), true));
    expect(t.sent.at(-1)?.frame).toMatchObject({ payload: { code: "PAYLOAD_TOO_LARGE" } });

    await t.connect("c2", 7);
    await t.core.dispatch(t.messageEvent("c2", "{not json", true));
    expect(t.closed).toEqual(["c1", "c2"]);
  });

  it("releases presence exactly once even if $disconnect repeats", async () => {
    const t = setup();
    await t.connect("c1", 7);
    const disconnect: ApiGatewayWebSocketEvent = {
      requestContext: { routeKey: "$disconnect", eventType: "DISCONNECT", connectionId: "c1" },
    };
    await t.core.dispatch(disconnect);
    await t.core.dispatch(disconnect);
    expect(t.presenceCounts.get(7)).toBe(0);
  });
});

describe("realtime Lambda core (notification fan-out)", () => {
  it("delivers user- and room-targeted hints with the persistent gateway frame shape", async () => {
    const t = setup();
    const room = randomUUID();
    await t.connect("c1", 7);
    await t.connect("c2", 8);
    await t.core.dispatch(
      t.messageEvent("c2", { v: 1, type: "room.subscribe", payload: { grant: t.issueGrant(8, room) } }),
    );
    t.sent.length = 0;

    const invitation = randomUUID();
    const result = await t.core.dispatch({
      v: 1,
      type: "pvp.invitation.changed",
      event_id: "e1",
      sent_at: new Date().toISOString(),
      target_user_id: 7,
      target_room_id: null,
      payload: { invitation_id: invitation },
    });
    expect(result).toEqual({ accepted: true, delivered: 1, gone: 0 });
    expect(t.sent).toEqual([
      {
        connectionId: "c1",
        frame: {
          v: 1,
          type: "pvp.invitation.changed",
          event_id: "e1",
          sent_at: expect.any(String) as string,
          payload: { invitation_id: invitation },
        },
      },
    ]);

    const battle = randomUUID();
    await t.core.dispatch({
      v: 1,
      type: "pvp.battle.changed",
      event_id: "e2",
      sent_at: new Date().toISOString(),
      target_room_id: room,
      payload: { room_id: room, battle_id: battle, version: 4, last_event_sequence: 9 },
    });
    expect(t.sent.at(-1)).toMatchObject({ connectionId: "c2", frame: { type: "pvp.battle.changed" } });
  });

  it("fails closed on combat secrets in hint payloads", async () => {
    const t = setup();
    const room = randomUUID();
    const result = await t.core.dispatch({
      v: 1,
      type: "pvp.battle.changed",
      event_id: "e3",
      sent_at: new Date().toISOString(),
      target_room_id: room,
      payload: { room_id: room, battle_id: randomUUID(), version: 1, last_event_sequence: 0, damage: 99 },
    });
    expect(result).toEqual({ accepted: false, delivered: 0, gone: 0 });
  });

  it("cleans up stale connections when the Management API returns 410", async () => {
    const t = setup();
    await t.connect("c1", 7);
    t.goneIds.add("c1");
    const result = await t.core.dispatch({
      v: 1,
      type: "pvp.invitation.changed",
      event_id: "e4",
      sent_at: new Date().toISOString(),
      target_user_id: 7,
      payload: { invitation_id: randomUUID() },
    });
    expect(result).toEqual({ accepted: true, delivered: 0, gone: 1 });
    expect(t.registry.records.has("c1")).toBe(false);
    expect(t.presenceCounts.get(7)).toBe(0);
  });

  it("revokes room subscriptions like the persistent gateway", async () => {
    const t = setup();
    const room = randomUUID();
    await t.connect("c1", 7);
    await t.core.dispatch(
      t.messageEvent("c1", { v: 1, type: "room.subscribe", payload: { grant: t.issueGrant(7, room) } }),
    );
    t.sent.length = 0;
    await t.core.dispatch({
      v: 1,
      type: "room.subscription.revoked",
      event_id: "e5",
      sent_at: new Date().toISOString(),
      target_room_id: room,
      payload: { room_id: room, reason: "room_closed" },
    });
    expect(t.sent.map((s) => s.frame.type)).toEqual([
      "room.subscription.revoked",
      "room.subscription.revoked",
    ]);
    expect(await t.registry.connectionsForRoom(room)).toEqual([]);
  });
});
