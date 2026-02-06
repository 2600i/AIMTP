# Operations

## Startup

### Local Node
```sh
npm run build
node dist/runtime/relay.js
```

### Docker Compose (Relay + Redis)
```sh
docker compose up --build
```

Defaults:
- Relay listens on `http://localhost:8787/aimtp`.
- Redis is reachable at `redis://localhost:6379`.

## Environment Configuration
Use `.env.example` as the complete list of supported variables. Common options:
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

The defaults in `docs/runtime.md` are safe for most deployments.

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
