import type { IncomingMessage, ServerResponse } from "node:http";

export type HealthDeps = {
  isLive: () => boolean;
  isReady: () => Promise<boolean>;
};

export async function handleHealthRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HealthDeps,
): Promise<boolean> {
  const url = req.url ?? "/";
  const path = url.split("?")[0] ?? "/";

  if (req.method === "GET" && path === "/health/live") {
    const live = deps.isLive();
    writeJson(res, live ? 200 : 503, { status: live ? "live" : "down" });
    return true;
  }

  if (req.method === "GET" && path === "/health/ready") {
    const ready = await deps.isReady();
    writeJson(res, ready ? 200 : 503, { status: ready ? "ready" : "not_ready" });
    return true;
  }

  return false;
}

function writeJson(res: ServerResponse, status: number, body: Record<string, string>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}
