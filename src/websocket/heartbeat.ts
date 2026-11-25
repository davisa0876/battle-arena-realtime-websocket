import type { WebSocket } from "ws";

export type HeartbeatController = {
  start: (socket: WebSocket, onTimeout: () => void) => void;
  stop: (socket: WebSocket) => void;
  notePong: (socket: WebSocket) => void;
  stopAll: () => void;
};

type TimerPair = {
  interval: NodeJS.Timeout;
  timeout: NodeJS.Timeout | null;
};

export function createHeartbeatController(options: {
  intervalMs: number;
  timeoutMs: number;
}): HeartbeatController {
  const timers = new WeakMap<WebSocket, TimerPair>();
  const active = new Set<WebSocket>();

  const clearTimeoutOnly = (pair: TimerPair): void => {
    if (pair.timeout) {
      clearTimeout(pair.timeout);
      pair.timeout = null;
    }
  };

  const armTimeout = (socket: WebSocket, pair: TimerPair, onTimeout: () => void): void => {
    clearTimeoutOnly(pair);
    pair.timeout = setTimeout(() => {
      onTimeout();
    }, options.timeoutMs);
    pair.timeout.unref?.();
  };

  return {
    start(socket, onTimeout) {
      this.stop(socket);

      const pair: TimerPair = {
        interval: setInterval(() => {
          if (socket.readyState !== socket.OPEN) {
            return;
          }
          try {
            socket.ping();
          } catch {
            onTimeout();
            return;
          }
          armTimeout(socket, pair, onTimeout);
        }, options.intervalMs),
        timeout: null,
      };
      pair.interval.unref?.();
      timers.set(socket, pair);
      active.add(socket);
    },

    stop(socket) {
      const pair = timers.get(socket);
      if (!pair) {
        return;
      }
      clearInterval(pair.interval);
      clearTimeoutOnly(pair);
      timers.delete(socket);
      active.delete(socket);
    },

    notePong(socket) {
      const pair = timers.get(socket);
      if (!pair) {
        return;
      }
      clearTimeoutOnly(pair);
    },

    stopAll() {
      for (const socket of [...active]) {
        this.stop(socket);
      }
    },
  };
}
