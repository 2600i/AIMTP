# IntentOS v2 Trust Rollout (Operators)

## Purpose
Safely enable IntentOS v2 trust semantics in production without changing execution behavior.

## Prerequisites
- Trusted issuer public keys are collected and distributed to each relay.
- Issuer naming convention is stable and explicit (for example `relay://region-name`).
- Receipt signing is enabled on issuers where trusted terminal receipts are expected.
- Teams agree on policy mode progression (`warn` first, then `enforce`).

## Minimal Recommended Environment (Enforce)
Use this baseline for trusted-only terminal receipt acceptance:

```sh
INTENTOS_TRUST_VERSION=v2
INTENTOS_RECEIPT_POLICY=enforce
INTENTOS_TRUSTED_RECEIPT_KEYS_JSON='{"relay://X":"<PUBLIC_KEY_PEM>"}'
```

Optional hardening:

```sh
INTENTOS_TRUST_V2_MAX_TIMESTAMP_SKEW_SEC=300
```

## Rollout Plan: Warn First, Then Enforce
1. Set `INTENTOS_TRUST_VERSION=v2` and start with `INTENTOS_RECEIPT_POLICY=warn`.
2. Confirm all expected issuers are present in `INTENTOS_TRUSTED_RECEIPT_KEYS_JSON`.
3. Watch warnings for unsigned, tampered, or unknown-issuer receipts.
4. Fix issuer mapping/signing gaps and re-run validation.
5. Move to `INTENTOS_RECEIPT_POLICY=enforce` only after warnings are understood and reduced.

## Common Failure Modes
- `untrusted issuer: <issuer>`:
  - The receipt issuer is missing from local trusted keys, misspelled, or mapped to the wrong public key.
- `missing signature for terminal receipt`:
  - A terminal receipt (`denied|completed|failed`) is unsigned in v2 trust context.
- `invalid signature`:
  - Signed bytes do not match canonical payload (tampering, mismatched key, or wrong issuer key mapping).
- `timestamp outside allowed skew: <Ns>` (when configured):
  - Receipt timestamp is outside the configured `INTENTOS_TRUST_V2_MAX_TIMESTAMP_SKEW_SEC` window.

## Local Validation Commands
```sh
npm run demo:federation
npm run demo:federation:v2
```

## Checklist: Ready to Enable v2?
- `INTENTOS_TRUST_VERSION=v2` is set in target environments.
- `INTENTOS_TRUSTED_RECEIPT_KEYS_JSON` contains all expected issuers and correct PEM keys.
- Receipt signing is enabled for relays expected to produce trusted terminal receipts.
- `warn` phase has been observed and reviewed.
- `enforce` cutover plan is approved and rollback settings are documented.
- Optional skew bound is configured where clock drift risk exists.
