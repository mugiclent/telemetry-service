# telemetry-service

Live bus GPS telemetry for Katisha Online. Ingests position pings from buses on an
active trip, serves each bus's latest position, and streams live updates to map viewers
over SSE. **Redis-backed, no database** — only the latest fix per bus is kept.

---

## How it fits

```
bus device (Traccar client)
    │  POST /  (coords as JSON or OsmAnd query string)
    ▼
nginx  telemetry.katisha.online ──► telemetry-svc:8093   (direct, NO api-gw, unauthenticated)
    │
    ├── Redis  telemetry:bus:{busId}:latest   (latest fix, TTL'd)
    └── Redis pub/sub  telemetry:bus:{busId}  ──► SSE streams ──► map viewers

trips exchange (RabbitMQ)
    └── trip.activated / trip.completed / trip.cancelled
          maintains  telemetry:device:{deviceId} → { tripId, busId, orgId }
```

A ping is accepted **only** if its `device_id` currently maps to an active trip — the
mapping is created from `trip.activated` and torn down on `trip.completed`/`trip.cancelled`.

---

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/` | Bus device posts a position (Traccar JSON or OsmAnd query/form). Always 2xx. |
| `GET` | `/buses/:busId/location` | Latest fix `{ lat, lon, ts }`, or `204` if none yet. |
| `GET` | `/buses/:busId/stream` | SSE stream of `{ lat, lon, ts }` fixes; primed with the latest on connect. |
| `GET` | `/health` | `200`/`503` dependency health (redis, rabbitmq). |

Read/stream responses are intentionally minimal — just enough to plot a moving marker
and judge freshness:

```json
{ "lat": -1.9378123, "lon": 30.0863787, "ts": "2026-06-16T19:38:49.240Z" }
```

---

## Dependencies on trip-service

`trip.activated` must carry `bus_id` and the tracker's `device_id`, and a
`trip.completed` event must be emitted on trip end. Events missing the required fields
are dead-lettered to `trips.dlx`.

---

## Local development

```bash
cp .env.example .env   # fill REDIS_PASSWORD, RABBITMQ_USER, RABBITMQ_PASSWORD
npm install
npm run dev
```

Use a `docker-compose.override.yml` (gitignored) to bind a host port locally — e.g. for
pointing an ngrok tunnel at the ingest endpoint while testing with a real phone.
