# Historical: AIMTP 0.3.0-beta Operator Checklist

> Preserved as a release record for the 0.3.0 beta line. It is not the current
> setup, security, or release checklist. See [`README.md`](../README.md) and
> [`docs/operations.md`](operations.md).

## What’s default-off (opt-in only)

The following controls are opt-in and default to inert behavior unless explicitly configured:

- `INTENTOS_TRANSPARENCY_LOG_MODE`
- `INTENTOS_TRANSPARENCY_LOG_PATH`
- `INTENTOS_TRANSPARENCY_CHECKPOINT_MODE`
- `INTENTOS_TRANSPARENCY_CHECKPOINT_PUBLIC_KEY`
- `INTENTOS_TRUST_DISTRIBUTION`
- `INTENTOS_TRUST_HTTP_BUNDLE_URL`
- `INTENTOS_TRUST_HTTP_REVOCATIONS_URL`
- `INTENTOS_TRUST_HTTP_HEAD_URL`
- `INTENTOS_TRUST_HTTP_CHECKPOINT_URL`
- `INTENTOS_TRUST_HTTP_LOGTAIL_URL`
- `INTENTOS_TRUST_SNAPSHOT_POLICY`
- `INTENTOS_TRUST_SNAPSHOT_STATE_PATH`

## Minimal local validation

Run:

- `npm test`
- `npm run build`
- `npm run test:receipts`
- `npm run trust:report -- --pretty`

## RC Smoke Test

Run:

- `npm run smoke:rc`

## Verify-mode validation (optional)

Example environment snippet:

```bash
INTENTOS_TRUST_VERSION=v2
INTENTOS_RECEIPT_POLICY=enforce
INTENTOS_TRANSPARENCY_LOG_MODE=verify
INTENTOS_TRANSPARENCY_LOG_PATH=/var/lib/aimtp/trust-log.jsonl
INTENTOS_TRANSPARENCY_CHECKPOINT_MODE=verify
INTENTOS_TRANSPARENCY_CHECKPOINT_PUBLIC_KEY=/etc/aimtp/checkpoint-public.pem
INTENTOS_TRUST_DISTRIBUTION=fs
INTENTOS_TRUST_SNAPSHOT_POLICY=warn
INTENTOS_TRUST_SNAPSHOT_STATE_PATH=/var/lib/aimtp/trust-snapshot-state.json
```

Expected failure behavior summary:

- `INTENTOS_RECEIPT_POLICY=enforce`: trust/policy failures are rejected.
- `INTENTOS_RECEIPT_POLICY=warn`: failures are logged as warnings and processing continues.
- `INTENTOS_RECEIPT_POLICY=off`: trust-policy enforcement is inert.

## Known invariants (must remain true)

- IntentOS execution semantics are unchanged.
- Receipt format is unchanged.
- Receipt verification crypto semantics are unchanged.
- v1 trust semantics remain frozen.
- v2 trust semantics remain unchanged.
- v3 trust features remain opt-in.
