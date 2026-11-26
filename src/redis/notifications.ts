import { createClient, type RedisClientType } from "redis";

import {
  NotificationEnvelopeSchema,
  type NotificationEnvelope,
} from "../protocol/schemas.js";
import type { Logger } from "pino";

export type NotificationHandler = (envelope: NotificationEnvelope) => void;

export type NotificationSubscriber = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

export function createNotificationSubscriber(deps: {
  url: string;
  channel: string;
  logger: Logger;
  onMessage: NotificationHandler;
  onError?: (error: Error) => void;
}): NotificationSubscriber {
  let client: RedisClientType | null = null;

  return {
    async start() {
      client = createClient({
        url: deps.url,
        socket: {
          reconnectStrategy(retries) {
            if (retries > 20) {
              return new Error("Redis subscriber reconnect limit exceeded");
            }
            return Math.min(retries * 100, 2_000);
          },
        },
      });
      client.on("error", (error: Error) => {
        deps.onError?.(error);
        deps.logger.warn({ err: error.message }, "redis subscriber error");
      });
      await client.connect();
      await client.subscribe(deps.channel, (message) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(message) as unknown;
        } catch {
          deps.logger.warn("ignored invalid notification json");
          return;
        }
        const envelope = NotificationEnvelopeSchema.safeParse(parsed);
        if (!envelope.success) {
          deps.logger.warn("ignored invalid notification envelope");
          return;
        }
        deps.onMessage(envelope.data);
      });
      deps.logger.info({ channel: deps.channel }, "subscribed to realtime notifications");
    },

    async stop() {
      if (!client) {
        return;
      }
      try {
        await client.unsubscribe(deps.channel);
        await client.quit();
      } catch {
        try {
          await client.disconnect();
        } catch {
          // ignore
        }
      } finally {
        client = null;
      }
    },
  };
}
