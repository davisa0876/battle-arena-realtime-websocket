import { describe, expect, it } from "vitest";

import {
  buildConnectionError,
  buildConnectionReady,
} from "../../src/websocket/protocol.js";
import { ErrorCode } from "../../src/protocol/schemas.js";

describe("protocol builders", () => {
  it("builds connection.ready with server-derived identity", () => {
    const message = buildConnectionReady({
      connectionId: "conn-1",
      playerId: 42,
      heartbeatIntervalMs: 30_000,
      now: () => new Date("2026-11-25T19:00:00.000Z"),
      eventId: "evt-1",
    });

    expect(message).toEqual({
      v: 1,
      type: "connection.ready",
      event_id: "evt-1",
      sent_at: "2026-11-25T19:00:00.000Z",
      payload: {
        connection_id: "conn-1",
        player_id: 42,
        heartbeat_interval_ms: 30_000,
      },
    });
  });

  it("builds safe connection.error codes", () => {
    const message = buildConnectionError({
      code: ErrorCode.PROTOCOL_UNSUPPORTED,
      now: () => new Date("2026-11-25T19:00:00.000Z"),
      eventId: "evt-2",
    });
    expect(message.payload.code).toBe("PROTOCOL_UNSUPPORTED");
    expect(message).not.toHaveProperty("payload.message");
  });
});
