# AIMTP v0.2 Federation and Trust (Phase 7)

## 1. Overview

This document defines Phase 7 federation for AIMTP relays. Federation enables operator-controlled single-hop message forwarding between trusted relays.

### 1.1 Goals

- Relays MUST have stable identities (`relay_id` + public key material).
- Relays MUST publish a signed Relay Descriptor with explicit expiry.
- Relays MUST enforce an explicit local trust policy (allowlist).
- Relays MUST support single-hop federated forwarding for non-local recipients when destination relay is trusted.
- Relays MUST emit structured audit logs for descriptor serving, verification, trust decisions, and forwarding outcomes.

### 1.2 Non-goals

- Global discovery
- Gossip/mesh routing
- Multi-hop routing
- Reputation scoring
- Automatic trust establishment
- Blockchain dependencies
- P2P transport
- Retry mesh logic or complex route tables

## 2. Terminology

- `Relay`: AIMTP HTTP relay implementation.
- `relay_id`: Stable relay identity string chosen by operator.
- `Relay Descriptor`: Signed metadata document describing relay identity and endpoint.
- `Trust Policy`: Local operator-managed policy describing trusted peer relays.
- `Trusted Relay Entry`: One allowlisted relay in trust policy.
- `Federated Envelope`: Inbound federation wrapper containing a descriptor plus AIMTP envelope payload.
- `Local recipient`: Recipient address/domain owned by the receiving relay.
- `Non-local recipient`: Recipient not owned by the receiving relay.

## 3. Relay Identity

A relay identity MUST include:

- `relay_id` (string, non-empty)
- `alg` (currently `ed25519`)
- `public_key` (public key bytes encoded as base64 DER SPKI or PEM)

When federation is enabled (`AIMTP_FEDERATION=on`), `AIMTP_RELAY_ID` and `AIMTP_RELAY_ENDPOINT` MUST be configured and non-empty. `AIMTP_RELAY_ENDPOINT` MUST be an `https://` URL.

## 4. Canonicalization for Signing

Relay descriptors and federation-signature payloads MUST use stable JSON canonicalization:

- Objects: keys sorted lexicographically.
- Arrays: preserve element order.
- `undefined` keys: omitted.
- Scalars: encoded using JSON primitives.
- Output: UTF-8 bytes of canonical JSON.

Equivalent data structures MUST produce identical canonical byte sequences.

## 5. Relay Descriptor

### 5.1 Descriptor shape

```json
{
  "relay_id": "relay.example",
  "endpoint": "https://relay.example",
  "alg": "ed25519",
  "public_key": "BASE64_OR_PEM",
  "issued_at": "2026-02-06T00:00:00Z",
  "expires_at": "2026-02-06T01:00:00Z",
  "signature": {
    "alg": "ed25519",
    "kid": "relay.example",
    "sig": "BASE64_SIGNATURE"
  }
}
```

### 5.2 Descriptor rules

- Descriptor `signature` MUST cover descriptor fields excluding `signature`.
- `issued_at` and `expires_at` MUST be RFC3339 timestamps.
- `expires_at` MUST be greater than `issued_at`.
- Relays SHOULD publish descriptors with short TTLs (for example 1 hour).
- Receivers MUST reject expired descriptors.
- Receivers MAY apply bounded clock-skew tolerance.

## 6. Trust Policy Model

Trust policy is explicit and local. Discovery is out of scope.

### 6.1 Configuration

- `AIMTP_TRUSTED_RELAYS_PATH` default: `./config/trusted_relays.json`
- `AIMTP_TRUST_POLICY_MODE` values:
  - `explicit` (default when federation on): enforce allowlist
  - `off`: disable federation trust handling (equivalent to federation-disabled behavior)

### 6.2 JSON shape

```json
{
  "trusted_relays": [
    {
      "relay_id": "relay.example",
      "endpoint": "https://relay.example",
      "public_key": "BASE64_OR_PEM",
      "alg": "ed25519",
      "expires_at": "2026-12-31T23:59:59Z"
    }
  ],
  "domains": {
    "example.com": "relay.example"
  }
}
```

### 6.3 Trust enforcement

When federation is enabled and trust policy mode is `explicit`, inbound federation MUST be accepted only if all checks pass:

1. Descriptor signature verifies using trusted entry key material.
2. Descriptor `relay_id` is present in trusted allowlist.
3. Descriptor and trust entry are not expired.
4. Descriptor `endpoint` exactly matches trusted entry endpoint.

Any failed check MUST reject request with error (`401` or `403`) and an audit log reason.

## 7. Federated Forwarding

Forwarding is single-hop only.

### 7.1 Destination resolution

For non-local recipients:

1. If recipient domain exists in trust policy `domains`, use mapped `relay_id`.
2. Else use recipient domain string as `relay_id`.
3. Relay MUST look up resolved `relay_id` in trusted entries.
4. If not trusted, relay MUST reject and MUST NOT attempt discovery.

### 7.2 Hop control

- Forwarded requests MUST include `x-aimtp-hop: 1`.
- Inbound federation with hop value greater than `1` MUST be rejected.
- Multi-hop forwarding MUST NOT be attempted.

### 7.3 Failure behavior

- On forward transport or trust failure, relay MUST return structured error.
- Relay MUST NOT silently downgrade to discovery or alternate relays.
- Retry mesh logic is out of scope.

## 8. HTTP Endpoints

### 8.1 `GET /.well-known/aimtp-relay.json`

- Returns local Relay Descriptor JSON.
- Response `200 application/json`.
- `Cache-Control` MUST reflect descriptor TTL (`max-age=<seconds>`).

### 8.2 `POST /federation/envelope`

Request body:

```json
{
  "descriptor": { "...": "RelayDescriptor" },
  "envelope": { "...": "AIMTP envelope" }
}
```

Behavior:

- Relay MUST parse JSON with body size limits.
- Relay MUST verify hop limit.
- Relay MUST verify descriptor signature and trust policy before accepting envelope.
- On success, relay MUST enqueue/deliver through existing local pipeline and return success JSON.
- On failure, relay MUST return `401` or `403` JSON error without stack traces.

## 9. Security Considerations

- Replay: Receivers SHOULD enforce descriptor expiry and optional skew bounds.
- Expiry: Receivers MUST reject expired descriptors/trust entries.
- Downgrade: Federation-enabled relays MUST enforce trust policy in explicit mode and MUST NOT auto-discover peers.
- Impersonation: Receivers MUST verify descriptor signature with pinned trusted key and MUST pin endpoint equality.
- Hop abuse: Receivers MUST reject `x-aimtp-hop > 1`.
- Logging: Relays MUST NOT log private keys or full message bodies.

## 10. Audit Logging

Relays MUST emit structured JSON logs with these events:

- `federation_descriptor_served`
- `federation_inbound_verify`
- `federation_trust_decision`
- `federation_forward_attempt`

Each event MUST include, when applicable:

- `relay_instance_id`
- `src_relay_id` (inbound)
- `dest_relay_id` (outbound)
- `endpoint`
- `reason` (on failures)
- `outcome` (`ok`/`fail`, `trusted`/`untrusted`)

## 11. Conformance Vectors

Conformance vectors for federation are defined under `spec/vectors/federation/`.

Minimum vector classes:

- Valid descriptor signature + trust match
- Invalid descriptor signature
- Expired descriptor
- Endpoint mismatch for trusted relay
- Hop limit exceeded
- Domain map routing resolution


When federation is enabled, relay key material MUST be provided via environment variables:

- `AIMTP_RELAY_PUBLIC_KEY`
- `AIMTP_RELAY_PRIVATE_KEY`

Keys MUST correspond to the relay identity public key and be suitable for Ed25519 signing.

