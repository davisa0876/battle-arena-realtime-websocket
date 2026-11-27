import {
  ApiGatewayManagementApiClient,
  DeleteConnectionCommand,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";

export type PostOutcome = "ok" | "gone";

/** Outbound side of API Gateway WebSocket: the Management API (@connections). */
export interface ConnectionPoster {
  post(connectionId: string, data: string): Promise<PostOutcome>;
  close(connectionId: string): Promise<void>;
}

function isGone(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return candidate.name === "GoneException" || candidate.$metadata?.httpStatusCode === 410;
}

export function createManagementApiPoster(options: {
  endpoint: string;
  region: string;
}): ConnectionPoster {
  const client = new ApiGatewayManagementApiClient({
    endpoint: options.endpoint,
    region: options.region,
  });
  const encoder = new TextEncoder();

  return {
    async post(connectionId, data) {
      try {
        await client.send(
          new PostToConnectionCommand({ ConnectionId: connectionId, Data: encoder.encode(data) }),
        );
        return "ok";
      } catch (error) {
        if (isGone(error)) {
          return "gone";
        }
        throw error;
      }
    },

    async close(connectionId) {
      try {
        await client.send(new DeleteConnectionCommand({ ConnectionId: connectionId }));
      } catch (error) {
        if (!isGone(error)) {
          throw error;
        }
      }
    },
  };
}

/** Async (InvocationType=Event) Lambda invoke used for deferred connection.ready delivery. */
export function createAsyncInvoker(options: {
  functionName: string;
  region: string;
  endpoint?: string | undefined;
}): (payload: unknown) => Promise<void> {
  const client = new LambdaClient({
    region: options.region,
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
  });
  const encoder = new TextEncoder();

  return async (payload) => {
    const result = await client.send(
      new InvokeCommand({
        FunctionName: options.functionName,
        InvocationType: "Event",
        Payload: encoder.encode(JSON.stringify(payload)),
      }),
    );
    if (result.StatusCode !== 202) {
      throw new Error(`async invoke returned status ${String(result.StatusCode)}`);
    }
  };
}
