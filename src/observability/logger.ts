import pino, { type Logger, type LoggerOptions } from "pino";

const REDACT_PATHS = [
  "ticket",
  "rawTicket",
  "authorization",
  "Authorization",
  "cookie",
  "Cookie",
  "email",
  "password",
  "token",
  "req.headers.authorization",
  "req.headers.cookie",
  "req.url",
  "req.query.ticket",
  "headers.authorization",
  "headers.cookie",
] as const;

export function createLogger(options?: {
  level?: string;
  pretty?: boolean;
}): Logger {
  const level = options?.level ?? "info";
  const base: LoggerOptions = {
    level,
    base: { service: "battle-arena-realtime" },
    redact: {
      paths: [...REDACT_PATHS],
      censor: "[Redacted]",
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  if (options?.pretty) {
    return pino({
      ...base,
      transport: {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:standard" },
      },
    });
  }

  return pino(base);
}

/** Strip query strings that may contain one-time tickets before any log sink. */
export function sanitizeUrlForLogs(rawUrl: string | undefined): string {
  if (!rawUrl) {
    return "";
  }
  const q = rawUrl.indexOf("?");
  if (q === -1) {
    return rawUrl;
  }
  return `${rawUrl.slice(0, q)}?[redacted]`;
}

export function redactTicket(value: string | undefined): string {
  if (!value) {
    return "";
  }
  if (value.length <= 8) {
    return "[Redacted]";
  }
  return `${value.slice(0, 4)}…[Redacted]`;
}
