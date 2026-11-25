import type { IncomingMessage } from "node:http";
import { URL } from "node:url";

import type { Logger } from "pino";
import type { Duplex } from "node:stream";
import type { WebSocketServer } from "ws";

import {
  TicketRejectedError,
  type TicketStore,
} from "../auth/ticketStore.js";
import type { AppConfig } from "../config/env.js";
import { ErrorCode } from "../protocol/schemas.js";
import { sanitizeUrlForLogs } from "../observability/logger.js";
import type { ConnectionRegistry } from "./connections.js";

export type UpgradeOutcome =
  | { ok: true; playerId: number }
  | { ok: false; httpStatus: number; code: string };

export function extractClientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.length > 0) {
      const first = forwarded.split(",")[0]?.trim();
      if (first) {
        return first;
      }
    }
  }
  return req.socket.remoteAddress ?? "unknown";
}

export function validateOrigin(
  origin: string | undefined,
  allowed: readonly string[],
  allowMissing: boolean,
): boolean {
  if (origin === undefined || origin === "") {
    return allowMissing;
  }
  return allowed.includes(origin);
}

export function parseTicketFromUrl(
  req: IncomingMessage,
  wsPath: string,
): { ticket?: string; error?: string } {
  const host = req.headers.host ?? "localhost";
  let url: URL;
  try {
    url = new URL(req.url ?? "/", `http://${host}`);
  } catch {
    return { error: "malformed_url" };
  }

  if (url.pathname !== wsPath) {
    return { error: "wrong_path" };
  }

  const tickets = url.searchParams.getAll("ticket");
  if (tickets.length === 0) {
    return { error: "missing" };
  }
  if (tickets.length > 1) {
    return { error: "duplicate" };
  }
  const ticket = tickets[0];
  if (!ticket) {
    return { error: "missing" };
  }
  return { ticket };
}

export async function authorizeUpgrade(input: {
  req: IncomingMessage;
  config: AppConfig;
  ticketStore: TicketStore;
  registry: ConnectionRegistry;
  shuttingDown: boolean;
  remoteIp: string;
}): Promise<UpgradeOutcome> {
  if (input.shuttingDown) {
    return { ok: false, httpStatus: 503, code: ErrorCode.SHUTTING_DOWN };
  }

  if (!validateOrigin(
    typeof input.req.headers.origin === "string" ? input.req.headers.origin : undefined,
    input.config.WS_ALLOWED_ORIGINS,
    input.config.WS_ALLOW_MISSING_ORIGIN,
  )) {
    return { ok: false, httpStatus: 403, code: ErrorCode.ORIGIN_REJECTED };
  }

  const parsed = parseTicketFromUrl(input.req, input.config.WS_PATH);
  if (parsed.error === "wrong_path") {
    return { ok: false, httpStatus: 404, code: ErrorCode.PROTOCOL_UNSUPPORTED };
  }
  if (parsed.error === "duplicate" || parsed.error === "malformed_url") {
    return { ok: false, httpStatus: 400, code: ErrorCode.TICKET_MALFORMED };
  }
  if (parsed.error === "missing" || !parsed.ticket) {
    return { ok: false, httpStatus: 401, code: ErrorCode.TICKET_MISSING };
  }

  if (input.registry.count() >= input.config.WS_MAX_CONNECTIONS) {
    return { ok: false, httpStatus: 429, code: ErrorCode.CONNECTION_LIMIT };
  }
  if (input.registry.countForIp(input.remoteIp) >= input.config.WS_MAX_CONNECTIONS_PER_IP) {
    return { ok: false, httpStatus: 429, code: ErrorCode.CONNECTION_LIMIT };
  }

  try {
    const meta = await input.ticketStore.consume(parsed.ticket);
    if (input.registry.countForUser(meta.user_id) >= input.config.WS_MAX_CONNECTIONS_PER_USER) {
      return { ok: false, httpStatus: 429, code: ErrorCode.CONNECTION_LIMIT };
    }
    return { ok: true, playerId: meta.user_id };
  } catch (error) {
    if (error instanceof TicketRejectedError) {
      if (error.reason === "redis_unavailable") {
        return { ok: false, httpStatus: 503, code: ErrorCode.REDIS_UNAVAILABLE };
      }
      if (error.reason === "malformed") {
        return { ok: false, httpStatus: 400, code: ErrorCode.TICKET_MALFORMED };
      }
      return { ok: false, httpStatus: 401, code: ErrorCode.TICKET_INVALID };
    }
    return { ok: false, httpStatus: 503, code: ErrorCode.REDIS_UNAVAILABLE };
  }
}

export function attachUpgradeHandler(deps: {
  wss: WebSocketServer;
  config: AppConfig;
  ticketStore: TicketStore;
  registry: ConnectionRegistry;
  logger: Logger;
  isShuttingDown: () => boolean;
  trustProxy?: boolean;
}): (req: IncomingMessage, socket: Duplex, head: Buffer) => void {
  return (req, socket, head) => {
    void (async () => {
      const remoteIp = extractClientIp(req, deps.trustProxy === true);
      deps.logger.info(
        {
          path: deps.config.WS_PATH,
          origin: typeof req.headers.origin === "string" ? req.headers.origin : null,
          remoteIp,
          url: sanitizeUrlForLogs(req.url),
        },
        "upgrade attempt",
      );

      const outcome = await authorizeUpgrade({
        req,
        config: deps.config,
        ticketStore: deps.ticketStore,
        registry: deps.registry,
        shuttingDown: deps.isShuttingDown(),
        remoteIp,
      });

      if (!outcome.ok) {
        deps.logger.info(
          { outcome: "rejected", code: outcome.code, httpStatus: outcome.httpStatus, remoteIp },
          "upgrade rejected",
        );
        rejectUpgrade(socket, outcome.httpStatus, outcome.code);
        return;
      }

      deps.wss.handleUpgrade(req, socket, head, (ws) => {
        const accepted = deps.registry.accept({
          socket: ws,
          playerId: outcome.playerId,
          remoteIp,
          heartbeatIntervalMs: deps.config.WS_HEARTBEAT_INTERVAL_MS,
          maxLifetimeMs: deps.config.WS_MAX_CONNECTION_LIFETIME_MS,
          maxBufferedBytes: deps.config.WS_MAX_BUFFERED_BYTES,
          maxPayloadBytes: deps.config.WS_MAX_PAYLOAD_BYTES,
        });

        if (!accepted) {
          try {
            ws.close(1013, "limit");
          } catch {
            ws.terminate();
          }
          deps.logger.info({ outcome: "rejected", code: ErrorCode.CONNECTION_LIMIT }, "upgrade rejected");
          return;
        }

        deps.logger.info(
          { outcome: "accepted", connectionId: accepted.id, playerId: accepted.playerId },
          "upgrade accepted",
        );
      });
    })().catch((error: unknown) => {
      deps.logger.error(
        { err: error instanceof Error ? error.message : "unknown" },
        "upgrade handler failure",
      );
      rejectUpgrade(socket, 500, ErrorCode.REDIS_UNAVAILABLE);
    });
  };
}

function rejectUpgrade(socket: Duplex, status: number, code: string): void {
  const reason =
    status === 401
      ? "Unauthorized"
      : status === 403
        ? "Forbidden"
        : status === 404
          ? "Not Found"
          : status === 429
            ? "Too Many Requests"
            : status === 503
              ? "Service Unavailable"
              : status === 400
                ? "Bad Request"
                : "Error";

  const body = JSON.stringify({ error: code });
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
  socket.destroy();
}
