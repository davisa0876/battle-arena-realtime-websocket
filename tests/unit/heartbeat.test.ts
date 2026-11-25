import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createHeartbeatController } from "../../src/websocket/heartbeat.js";

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  ping = vi.fn();
}

describe("heartbeat controller", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("times out when no pong is observed", () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const onTimeout = vi.fn();
    const heartbeat = createHeartbeatController({
      intervalMs: 100,
      timeoutMs: 50,
    });

    heartbeat.start(socket as never, onTimeout);
    vi.advanceTimersByTime(100);
    expect(socket.ping).toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    heartbeat.stop(socket as never);
  });

  it("clears timeout after pong", () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const onTimeout = vi.fn();
    const heartbeat = createHeartbeatController({
      intervalMs: 100,
      timeoutMs: 50,
    });

    heartbeat.start(socket as never, onTimeout);
    vi.advanceTimersByTime(100);
    heartbeat.notePong(socket as never);
    vi.advanceTimersByTime(50);
    expect(onTimeout).not.toHaveBeenCalled();
    heartbeat.stop(socket as never);
  });
});
