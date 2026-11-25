#!/usr/bin/env node
/**
 * End-to-end smoke: Laravel ticket -> Node connection.ready -> reuse rejected.
 * Usage: node scripts/e2e-ticket.mjs <sanctumBearerToken>
 */
import WebSocket from "ws";

const token = process.argv[2];
if (!token) {
  process.stderr.write("Usage: node scripts/e2e-ticket.mjs <bearer-token>\n");
  process.exit(1);
}

const apiBase = process.env.API_BASE_URL ?? "http://127.0.0.1:8000";

const ticketRes = await fetch(`${apiBase}/api/realtime/tickets`, {
  method: "POST",
  headers: {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
  },
});

if (!ticketRes.ok) {
  process.stderr.write(`ticket HTTP ${ticketRes.status}: ${await ticketRes.text()}\n`);
  process.exit(1);
}

const body = await ticketRes.json();
const ticket = body?.data?.ticket;
const wsUrl = body?.data?.ws_url;
if (!ticket || !wsUrl) {
  process.stderr.write("ticket response missing data\n");
  process.exit(1);
}

console.log("ticket issued; connecting once...");

const first = await new Promise((resolve, reject) => {
  const url = `${wsUrl}${wsUrl.includes("?") ? "&" : "?"}ticket=${encodeURIComponent(ticket)}`.replace(
    "?ticket=",
    wsUrl.endsWith("/ws") ? "?ticket=" : "/ws?ticket=",
  );
  // Prefer explicit /ws?ticket=
  const connectUrl = wsUrl.includes("?")
    ? `${wsUrl}&ticket=${encodeURIComponent(ticket)}`
    : `${wsUrl}?ticket=${encodeURIComponent(ticket)}`;

  const ws = new WebSocket(connectUrl, {
    headers: { Origin: "http://localhost:3000" },
  });
  const timer = setTimeout(() => reject(new Error("timeout")), 5_000);
  ws.once("message", (data) => {
    clearTimeout(timer);
    const msg = JSON.parse(data.toString("utf8"));
    ws.close();
    resolve(msg);
  });
  ws.once("unexpected-response", (_req, res) => {
    clearTimeout(timer);
    reject(new Error(`upgrade ${res.statusCode}`));
  });
  ws.once("error", (err) => {
    clearTimeout(timer);
    reject(err);
  });
  void url;
});

if (first?.type !== "connection.ready") {
  process.stderr.write(`unexpected first frame: ${JSON.stringify(first)}\n`);
  process.exit(1);
}
console.log("connection.ready ok, player_id=", first.payload.player_id);

const reuseRejected = await new Promise((resolve) => {
  const connectUrl = `${wsUrl}?ticket=${encodeURIComponent(ticket)}`;
  const ws = new WebSocket(connectUrl, {
    headers: { Origin: "http://localhost:3000" },
  });
  ws.once("open", () => {
    ws.close();
    resolve(false);
  });
  ws.once("unexpected-response", (_req, res) => {
    resolve(res.statusCode === 401 || res.statusCode === 400);
  });
  ws.once("error", () => resolve(true));
});

if (!reuseRejected) {
  process.stderr.write("ticket reuse was not rejected\n");
  process.exit(1);
}
console.log("ticket reuse rejected as expected");
console.log("E2E smoke passed.");
