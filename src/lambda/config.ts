import { z } from "zod";

import { ConfigError, loadConfig, type AppConfig } from "../config/env.js";

/** Treat empty strings from Compose / Lambda console as "unset". */
const optionalNonEmpty = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

const LambdaEnvSchema = z.object({
  /** Redis namespace for the API Gateway connection registry (replaces in-process Maps). */
  WS_REGISTRY_PREFIX: z.string().min(1).default("battle-arena:ws-registry:"),
  /**
   * Registry safety-net TTL. API Gateway closes sockets after 2h max, but $disconnect is
   * best-effort, so every registry key expires on its own shortly after that.
   */
  WS_REGISTRY_TTL_SECONDS: z.coerce.number().int().min(60).max(172_800).default(7_260),
  /**
   * API Gateway Management API endpoint, e.g.
   * https://{api-id}.execute-api.{region}.amazonaws.com/{stage}. Required: notification
   * fan-out invocations (from Laravel) carry no requestContext to derive it from.
   */
  WS_MANAGEMENT_ENDPOINT: z.string().url(),
  /** connection.ready cannot be posted during $connect; it is delivered by an async self-invoke. */
  WS_READY_DELIVERY_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(6),
  WS_READY_DELIVERY_BASE_DELAY_MS: z.coerce.number().int().min(10).max(2_000).default(50),
  AWS_REGION: z.string().min(1).default("us-east-1"),
  /** Function used for the async connection.ready self-invoke (defaults to this function). */
  WS_READY_FUNCTION_NAME: optionalNonEmpty(z.string().min(1)),
  AWS_LAMBDA_FUNCTION_NAME: optionalNonEmpty(z.string().min(1)),
  /** Local-only override of the Lambda Invoke API endpoint (unset in AWS). */
  LAMBDA_ENDPOINT: optionalNonEmpty(z.string().url()),
});

export type LambdaOnlyConfig = z.infer<typeof LambdaEnvSchema>;

export type LambdaConfig = AppConfig &
  LambdaOnlyConfig & {
    readyFunctionName: string;
  };

export function loadLambdaConfig(env: NodeJS.ProcessEnv = process.env): LambdaConfig {
  const base = loadConfig(env);
  const result = LambdaEnvSchema.safeParse({
    WS_REGISTRY_PREFIX: env.WS_REGISTRY_PREFIX,
    WS_REGISTRY_TTL_SECONDS: env.WS_REGISTRY_TTL_SECONDS,
    WS_MANAGEMENT_ENDPOINT: env.WS_MANAGEMENT_ENDPOINT,
    WS_READY_DELIVERY_ATTEMPTS: env.WS_READY_DELIVERY_ATTEMPTS,
    WS_READY_DELIVERY_BASE_DELAY_MS: env.WS_READY_DELIVERY_BASE_DELAY_MS,
    AWS_REGION: env.AWS_REGION,
    WS_READY_FUNCTION_NAME: env.WS_READY_FUNCTION_NAME,
    AWS_LAMBDA_FUNCTION_NAME: env.AWS_LAMBDA_FUNCTION_NAME,
    LAMBDA_ENDPOINT: env.LAMBDA_ENDPOINT,
  });

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(`Invalid Lambda environment configuration: ${details}`);
  }

  const readyFunctionName =
    result.data.WS_READY_FUNCTION_NAME ?? result.data.AWS_LAMBDA_FUNCTION_NAME;
  if (!readyFunctionName) {
    throw new ConfigError(
      "WS_READY_FUNCTION_NAME or AWS_LAMBDA_FUNCTION_NAME must be set for connection.ready delivery",
    );
  }

  return { ...base, ...result.data, readyFunctionName };
}
