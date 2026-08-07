# Operations

This runbook describes the reference relay and local Compose surfaces. The
repository is a developer preview; these instructions are not a production
hardening or compliance guide.

## Startup

### Local Node
```sh
npm run build
AIMTP_API_KEY=dev-key AIMTP_BIND_HOST=127.0.0.1 node dist/runtime/relay.js
```

### Docker Compose (Relay + Redis + Gateway MVP)
```sh
docker compose up --build
```

Defaults:
- Relay listens on `http://localhost:8787/aimtp`.
- Redis is reachable at `redis://localhost:6379`.
- Gateway listens on `http://127.0.0.1:8788` but denies agent requests until
  trusted public keys are configured and refuses operator routes until operator
  tokens are configured.

## Environment Configuration
Use [`docs/runtime.md`](runtime.md) as the complete relay variable reference.
Start with the checked-in [`.env.example`](../.env.example). Common options:
- `AIMTP_STORE=redis` to share mailbox state across relay instances.
- `AIMTP_ALLOWED_RECIPIENTS` to allow `/aimtp` to accept envelopes without an in-process registry.
- `AIMTP_API_KEY` or per-recipient keys (`AIMTP_RECIPIENT_KEYS`, `AIMTP_KEY_RECIPIENTS`) to enforce auth.
- `AIMTP_RELAY_INSTANCE_ID` for stable log attribution across restarts.

For Docker Compose, you can supply overrides with:
```sh
docker compose --env-file .env up --build
```

## Redis Lock Tuning
Redis-backed mailboxes serialize mailbox operations per recipient using locks.
Tune these if you see lock contention or timeouts:
- `AIMTP_REDIS_LOCK_TTL_MS`: lock lease duration. Keep above worst-case mailbox
  operation latency and below expected poll cadence.
- `AIMTP_REDIS_LOCK_ACQUIRE_TIMEOUT_MS`: how long to wait for a lock before
  returning an error. Increase for heavy contention.
- `AIMTP_REDIS_LOCK_RETRY_DELAY_MS`: delay between lock retries. Increase to
  reduce Redis load during bursts.
- `AIMTP_REDIS_LEASE_RESULT_TTL_MS`: TTL for cached ack/fail results to keep
  idempotency stable across retries.

The documented values are implementation defaults, not a security or capacity
recommendation. Tune and test them for the target environment.

## Agent Trust Gateway

The Gateway is a separate process and authorization boundary, not a relay mode.
For the self-contained in-memory demonstration, run:

```sh
npm run demo:trust-gateway
```

The Compose service uses SQLite persistence, publishes port `8788` on loopback,
and requires two separate configuration inputs:

- `AIMTP_TRUSTED_KEYS` or `AIMTP_TRUSTED_KEYS_FILE` for agent envelope verification.
- `AIMTP_GATEWAY_OPERATOR_TOKENS` for approval and audit routes.

Without trusted keys, agent requests are denied. Without operator tokens,
approval and audit routes return `503`. See
[`docs/trust-gateway.md`](trust-gateway.md) for configuration, behavior, and
MVP limitations.

## Failure Recovery

### Relay Crash
- Leases are time-bound; after `AIMTP_MAILBOX_LEASE_MS` they expire and messages
  return to the queue for retry.
- Restarting the relay is safe; expect at-least-once delivery during recovery.

### Redis Restart
- With persistence (AOF/RDB), mailboxes recover when Redis returns.
- Without persistence, mailbox state is lost; producers should re-send work.
- Relays reconnect automatically once Redis is healthy.

### Dead Letters
Messages exhaust retries and move to the dead-letter queue.
Inspect them with:
```sh
curl "http://localhost:8787/aimtp/dead?recipient=demo-agent"
```
Recovery pattern:
- Fix the underlying handler or payload issue.
- Re-enqueue by POSTing the original envelope to `/aimtp` or message to
  `/aimtp/mailbox`.

## Observability
The relay logs structured counters for key actions:
- `enqueue`, `poll`, `ack`, `fail`, `dead_letter`

Example log record:
```json
{"event":"counter","name":"poll","value":3,"relay_instance_id":"relay-1","recipient":"demo-agent"}
```

Optional summary logging:
- Set `AIMTP_LOG_SUMMARY_INTERVAL_MS` to emit periodic rollups.
- Example:
```json
{"event":"summary","relay_instance_id":"relay-1","uptime_sec":120,"counters":{"enqueue":10,"poll":8,"ack":7,"fail":1,"dead_letter":1}}
```
