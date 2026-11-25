import { z } from "zod";

const boolFromEnv = z
  .union([z.boolean(), z.string()])
  .transform((value) => {
    if (typeof value === "boolean") {
      return value;
    }
    const normalized = value.trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes";
  });

const csvOrigins = z
  .string()
  .min(1)
  .transform((raw) =>
    raw
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  )
  .refine((origins) => origins.length > 0, {
    message: "WS_ALLOWED_ORIGINS must include at least one origin",
  });

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  REDIS_URL: z.string().url().default("redis://127.0.0.1:6379"),
  WS_TICKET_REDIS_PREFIX: z.string().min(1).default("battle-arena:ws-ticket:"),
  WS_TICKET_TTL_SECONDS: z.coerce.number().int().min(5).max(300).default(30),
  WS_ALLOWED_ORIGINS: csvOrigins,
  WS_ALLOW_MISSING_ORIGIN: boolFromEnv.default(true),
  WS_PATH: z.string().default("/ws"),
  WS_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(5_000).max(120_000).default(30_000),
  WS_HEARTBEAT_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(180_000).default(60_000),
  WS_MAX_PAYLOAD_BYTES: z.coerce.number().int().min(1_024).max(64_1024).default(8_192),
  WS_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(100_000).default(1_000),
  WS_MAX_CONNECTIONS_PER_USER: z.coerce.number().int().min(1).max(50).default(5),
  WS_MAX_CONNECTIONS_PER_IP: z.coerce.number().int().min(1).max(200).default(20),
  WS_MAX_CONNECTION_LIFETIME_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(86_400_000)
    .default(3_600_000),
  WS_MAX_BUFFERED_BYTES: z.coerce.number().int().min(1_024).max(1_048_576).default(65_536),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
});

export type AppConfig = z.infer<typeof EnvSchema> & {
  WS_ALLOWED_ORIGINS: readonly string[];
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = EnvSchema.safeParse({
    NODE_ENV: env.NODE_ENV,
    HOST: env.HOST,
    PORT: env.PORT,
    REDIS_URL: env.REDIS_URL,
    WS_TICKET_REDIS_PREFIX: env.WS_TICKET_REDIS_PREFIX,
    WS_TICKET_TTL_SECONDS: env.WS_TICKET_TTL_SECONDS,
    WS_ALLOWED_ORIGINS: env.WS_ALLOWED_ORIGINS,
    WS_ALLOW_MISSING_ORIGIN: env.WS_ALLOW_MISSING_ORIGIN,
    WS_PATH: env.WS_PATH,
    WS_HEARTBEAT_INTERVAL_MS: env.WS_HEARTBEAT_INTERVAL_MS,
    WS_HEARTBEAT_TIMEOUT_MS: env.WS_HEARTBEAT_TIMEOUT_MS,
    WS_MAX_PAYLOAD_BYTES: env.WS_MAX_PAYLOAD_BYTES,
    WS_MAX_CONNECTIONS: env.WS_MAX_CONNECTIONS,
    WS_MAX_CONNECTIONS_PER_USER: env.WS_MAX_CONNECTIONS_PER_USER,
    WS_MAX_CONNECTIONS_PER_IP: env.WS_MAX_CONNECTIONS_PER_IP,
    WS_MAX_CONNECTION_LIFETIME_MS: env.WS_MAX_CONNECTION_LIFETIME_MS,
    WS_MAX_BUFFERED_BYTES: env.WS_MAX_BUFFERED_BYTES,
    SHUTDOWN_TIMEOUT_MS: env.SHUTDOWN_TIMEOUT_MS,
    LOG_LEVEL: env.LOG_LEVEL,
  });

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(`Invalid environment configuration: ${details}`);
  }

  if (result.data.WS_HEARTBEAT_TIMEOUT_MS <= result.data.WS_HEARTBEAT_INTERVAL_MS) {
    throw new ConfigError(
      "WS_HEARTBEAT_TIMEOUT_MS must be greater than WS_HEARTBEAT_INTERVAL_MS",
    );
  }

  return result.data;
}
