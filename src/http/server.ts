import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { Logger } from "pino";
import { WebSocketServer } from "ws";

import type { TicketStore } from "../auth/ticketStore.js";
import type { AppConfig } from "../config/env.js";
import type { ConnectionRegistry } from "../websocket/connections.js";
import { attachUpgradeHandler } from "../websocket/upgrade.js";
import { handleHealthRequest } from "./health.js";

export type HttpGateway = {
  server: Server;
  wss: WebSocketServer;
  listen: () => Promise<void>;
  close: () => Promise<void>;
};

export function createHttpGateway(deps: {
  config: AppConfig;
  logger: Logger;
  ticketStore: TicketStore;
  registry: ConnectionRegistry;
  isShuttingDown: () => boolean;
  isReady: () => Promise<boolean>;
}): HttpGateway {
  const server = createServer((req, res) => {
    void onRequest(req, res, deps);
  });

  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: deps.config.WS_MAX_PAYLOAD_BYTES,
  });

  server.on(
    "upgrade",
    attachUpgradeHandler({
      wss,
      config: deps.config,
      ticketStore: deps.ticketStore,
      registry: deps.registry,
      logger: deps.logger,
      isShuttingDown: deps.isShuttingDown,
      trustProxy: false,
    }),
  );

  return {
    server,
    wss,
    async listen() {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(deps.config.PORT, deps.config.HOST, () => {
          server.off("error", reject);
          deps.logger.info(
            { host: deps.config.HOST, port: deps.config.PORT },
            "http server listening",
          );
          resolve();
        });
      });
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        wss.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          server.close((serverError) => {
            if (serverError) {
              reject(serverError);
              return;
            }
            resolve();
          });
        });
      });
    },
  };
}

async function onRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: {
    logger: Logger;
    isShuttingDown: () => boolean;
    isReady: () => Promise<boolean>;
  },
): Promise<void> {
  try {
    const handled = await handleHealthRequest(req, res, {
      isLive: () => !deps.isShuttingDown(),
      isReady: async () => {
        if (deps.isShuttingDown()) {
          return false;
        }
        return deps.isReady();
      },
    });

    if (handled) {
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "NOT_FOUND" }));
  } catch (error) {
    deps.logger.error(
      { err: error instanceof Error ? error.message : "unknown" },
      "http request failure",
    );
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "INTERNAL" }));
    }
  }
}
