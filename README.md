# Battle Arena Realtime (Phase 5A)

Authenticated **WebSocket transport gateway** for Battle Arena. Laravel remains the authority for identity, authorization, game rules, and persistent battle state. This service only manages ticket-authenticated realtime sockets.

**Phase 5A scope:** connection bootstrap, heartbeat, health, limits, graceful shutdown.  
**Phase 5B.1–5B.2 transport:** private room grants, targeted Redis fanout (`pvp.room.changed`, `pvp.invitation.changed`, `pvp.battle.changed`).  
**Presence:** authenticated sockets are tracked in Redis (`PRESENCE_ONLINE_SET_KEY`) so Laravel can serve `GET /api/pvp/online`. Clients keep a WS open while logged in and PvP-eligible on **any** screen — not only the lobby.  
**Not in scope:** matchmaking, combat calculation, gameplay command frames (Laravel REST only).

## Running the project locally

The [`battle-arena-infra`](https://github.com/davisa0876/battle-arena-infra) repository is responsible for creating the local environment. Use it to run the whole project (database, Redis, storage, email, API, realtime and web) with Docker.

Clone it next to this repository and the other `battle-arena-*` repositories, then:

```bash
cd battle-arena-infra
docker compose up -d --build
```

First-time setup, environment files, URLs and troubleshooting are in the [infra README](https://github.com/davisa0876/battle-arena-infra#readme).

## Stack

| Piece | Choice |
| --- | --- |
| Runtime | Node.js **26.x Active LTS** (Docker pin); local engines `>=20.18` |
| Language | TypeScript strict (ESM) |
| WebSockets | `ws` (native RFC 6455, no Socket.IO) |
| Tickets | Laravel issues → Redis 7 `GETDEL` redemption |
| Validation | Zod |
| Logs | Pino (ticket/URL redaction) |
| Tests | Vitest |

## Quick start (Compose)

From `battle-arena-infra`:

```bash
docker compose up -d --build
docker compose logs -f gateway realtime
```

The Compose environment runs the **Lambda adapter** (see below): the `gateway` service publishes `ws://localhost:3001/ws` and invokes the `realtime` function. Port 3001 is WebSocket-only there, so the HTTP health endpoints listed further down apply to the persistent server only. Default bind: `127.0.0.1:3001` (`REALTIME_BIND_ADDRESS`). After code changes: `docker compose up -d --build realtime`.

## Local development

These commands run the repository checks and the persistent server outside Compose. Stop the Compose `gateway` first if you need port 3001.

```bash
cp .env.example .env
# Point REDIS_URL at local Redis (Compose redis on 127.0.0.1:6379)
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm run dev
```

## Auth handshake

1. Client authenticates to Laravel (Sanctum cookie or bearer).
2. `POST /api/realtime/tickets` → `{ ticket, expires_in, ws_url }` (`Cache-Control: no-store`).
3. Client connects `GET /ws?ticket=...` (never put Sanctum credentials in the WS URL).
4. Gateway validates Origin (browsers), redeems `SHA-256(ticket)` with Redis `GETDEL`, emits:

```json
{
  "v": 1,
  "type": "connection.ready",
  "event_id": "...",
  "sent_at": "...",
  "payload": {
    "connection_id": "...",
    "player_id": 42,
    "heartbeat_interval_ms": 30000
  }
}
```

Ticket reuse / expiry / Redis outage → upgrade rejected (fail closed).

### Redis key contract

- Prefix: `battle-arena:ws-ticket:` (`WS_TICKET_REDIS_PREFIX`)
- Key: `{prefix}{sha256_hex(ticket)}`
- Value: `{"user_id":n,"issued_at":"..."}` (+ optional session/token ids)
- TTL: ~30s (`WS_TICKET_TTL_SECONDS`)
- Laravel writes via dedicated `ws_tickets` Redis connection with **empty** prefix so keys match Node exactly.

## HTTP endpoints (persistent server)

| Path | Meaning |
| --- | --- |
| `GET /health/live` | Process up |
| `GET /health/ready` | Redis reachable for ticket redemption |
| `GET /ws` | WebSocket upgrade only (ticket required) |

## Security notes

- Origin allowlist: `WS_ALLOWED_ORIGINS`. Missing Origin allowed for native clients when `WS_ALLOW_MISSING_ORIGIN=true`, still requires a valid ticket.
- Max payload 8 KiB; permessage-deflate off; connection/user/IP limits; max socket lifetime.
- Logs never include raw tickets or full query strings.
- **Logout limitation (5A):** disconnecting Sanctum does not yet forcibly close live sockets; max lifetime bounds exposure. Phase 5B should add revocation/revalidation.

## Physical phone testing

Temporarily set in infra `.env`:

```dotenv
API_BIND_ADDRESS=0.0.0.0
REALTIME_BIND_ADDRESS=0.0.0.0
PUBLIC_WS_URL=ws://<LAN-IP>:3001/ws
```

Keep Postgres/Redis/RustFS on `127.0.0.1`. Restrict firewall to the private LAN. Revert afterwards. Never use plain `ws://` on the public Internet.

## Cursor rules

Project rules live in `.cursor/rules/` (`00`–`70`) and encode architecture, TypeScript, protocol, auth, Redis, testing, Docker, and observability standards.

## AWS Lambda adapter (API Gateway WebSocket)

`src/lambda/` is an event-driven variant of the same gateway for API Gateway WebSocket + Lambda. The persistent server above is unchanged and remains the local-development transport.

| Persistent server | Lambda adapter |
| --- | --- |
| Upgrade handler validates Origin + redeems ticket | `$connect` does the same, returns 4xx/503 to reject |
| `connection.ready` sent on accept | Sent by an async self-invoke (API Gateway rejects posts until `$connect` returns) with 410 retries |
| In-memory `Map`s for sockets/rooms/limits | Redis sorted sets under `WS_REGISTRY_PREFIX` with TTL safety net |
| Redis Pub/Sub subscriber | Laravel async-invokes the function with the identical envelope (`PVP_REALTIME_DRIVER=lambda`) |
| `socket.send` | API Gateway Management API `PostToConnection`; 410 cleans up the registry and presence |
| Server pings, 1 h lifetime | Client app pings (`$default`), API Gateway 10 min idle / 2 h max |

Handler: `dist/lambda/handler.handler`. Extra env: `WS_MANAGEMENT_ENDPOINT` (required), `WS_REGISTRY_PREFIX`, `WS_REGISTRY_TTL_SECONDS`, `WS_READY_FUNCTION_NAME` (defaults to `AWS_LAMBDA_FUNCTION_NAME`), `LAMBDA_ENDPOINT` (local only). The Lambda container image is defined in `battle-arena-infra/docker/realtime` and is the `realtime` service of the local Compose environment; the persistent server (`src/index.ts`, `Dockerfile`) is no longer used by that environment. Unit tests: `tests/unit/lambdaCore.test.ts`.

## Phase 5B private rooms + battle hints

Laravel-verified membership, one-use room subscription grants, and Redis Pub/Sub fanout to authorized room subscribers. Clients must rehydrate authoritative state via REST after any hint.

### `pvp.battle.changed` (hint-only)

After a committed PvP combat mutation, Laravel publishes a **hint-only** notification. Node fans it out to sockets with an active grant-backed subscription for `target_room_id`. Payload is strictly:

| Field | Meaning |
| --- | --- |
| `room_id` | Private lobby UUID |
| `battle_id` | PvP battle UUID |
| `version` | Monotonic battle version |
| `last_event_sequence` | Last persisted event sequence |

No damage, HP, moves, RNG, or other combat secrets are allowed on the wire. Missing a hint is fine — `GET /api/pvp/battles/{battle}` remains authoritative.
