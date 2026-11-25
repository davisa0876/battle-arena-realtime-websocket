import { createClient, type RedisClientType } from "redis";

import type { RedisTicketClient } from "../auth/ticketStore.js";

export type RedisHandle = {
  client: RedisClientType;
  ticketClient: RedisTicketClient;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  ping: () => Promise<boolean>;
};

export function createRedisHandle(options: {
  url: string;
  onError?: (error: Error) => void;
}): RedisHandle {
  const client: RedisClientType = createClient({
    url: options.url,
    socket: {
      reconnectStrategy(retries) {
        if (retries > 20) {
          return new Error("Redis reconnect limit exceeded");
        }
        return Math.min(retries * 100, 2_000);
      },
    },
  });

  client.on("error", (error: Error) => {
    options.onError?.(error);
  });

  const ticketClient: RedisTicketClient = {
    async getDel(key: string): Promise<string | null> {
      const value = await client.getDel(key);
      if (value === null || value === undefined) {
        return null;
      }
      return typeof value === "string" ? value : String(value);
    },
    isReady(): boolean {
      return client.isReady;
    },
  };

  return {
    client,
    ticketClient,
    async connect() {
      if (!client.isOpen) {
        await client.connect();
      }
    },
    async disconnect() {
      if (client.isOpen) {
        await client.quit();
      }
    },
    async ping() {
      if (!client.isReady) {
        return false;
      }
      try {
        const result = await client.ping();
        return result === "PONG";
      } catch {
        return false;
      }
    },
  };
}
