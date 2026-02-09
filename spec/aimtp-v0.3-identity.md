# AIMTP v0.3 Identity (Phase 8)

## 1. Overview

This document defines Phase 8 identity for AIMTP using chain-agnostic signed JSON documents and reusable proof objects.

### 1.1 Goals

- AIMTP relays and agents MUST support verifiable identities without blockchain dependency.
- Identity data MUST be expressible as canonical JSON documents.
- Proof objects MUST be reusable across supported AIMTP payloads.
- Implementations MUST preserve Phase 7 federation behavior and compatibility.

### 1.2 Non-goals

- Global registries
- Blockchain anchoring
- Reputation systems
- Discovery or resolution networks
- Wallet UX
- Breaking changes to Phase 7 federation

## 2. Terminology

- `Identity Document` (ID Doc): Canonical JSON identity record for an AIMTP principal.
- `Proof`: Signature object binding a payload to an identity key.
- `Principal`: Entity represented by identity (`relay`, `agent`, or `service`).
- `Identity Key`: Public key entry declared in an ID Doc.
- `Verifier`: Component that evaluates proofs against keys and policy.

## 3. Identity Roles

Identity roles are:

- `relay`
- `agent`
- `service`

Implementations MUST reject unknown role values when verifying.

## 4. Identity Document Format

An Identity Document MUST be a JSON object:

```json
{
  "id": "did:aimtp:relay.example",
  "role": "relay",
  "keys": [
    {
      "kid": "relay.example#ed25519-1",
      "alg": "ed25519",
      "public_key": "BASE64_OR_PEM",
      "purposes": ["assertion"]
    }
  ],
  "issued_at": "2026-02-09T00:00:00Z",
  "expires_at": "2026-03-09T00:00:00Z",
  "metadata": {
    "name": "Example Relay"
  }
}
```

Rules:

- `id` MUST be a non-empty string.
- `role` MUST be one of `relay`, `agent`, `service`.
- `keys` MUST contain at least one key.
- Each key `kid` MUST be unique within the document.
- Each key `alg` MUST currently be `ed25519`.
- `issued_at` and `expires_at` MUST be RFC3339 when present.
- `expires_at` SHOULD be used to bound replay window.

## 5. Proof Object Format

A Proof object MUST be JSON:

```json
{
  "type": "aimtp.ed25519",
  "alg": "ed25519",
  "kid": "relay.example#ed25519-1",
  "created_at": "2026-02-09T00:00:00Z",
  "expires_at": "2026-02-09T01:00:00Z",
  "sig": "BASE64_SIGNATURE"
}
```

Rules:

- `alg` MUST be `ed25519`.
- `kid` MUST identify a key in the referenced Identity Document.
- `sig` MUST be base64 signature bytes.
- `created_at` and `expires_at` SHOULD be provided for replay bounds.
- Verifiers MAY reject proofs missing temporal fields by local policy.

## 6. Canonicalization

Identity signing and verification MUST reuse Phase 7 canonicalization:

- Objects MUST be serialized with lexicographically sorted keys.
- Arrays MUST preserve order.
- `undefined` values MUST be omitted.
- Canonical bytes MUST be UTF-8 JSON.

For proof verification, verifiers MUST canonicalize payloads without the attached proof field.
The proof signature MUST be computed over the canonicalized payload with the `proof` field removed.

## 7. Verification Rules

### 7.1 Identity Document Validation

A verifier MUST:

1. Confirm the document is well-formed JSON object.
2. Confirm required fields (`id`, `role`, `keys`) are valid.
3. Confirm key algorithms are supported (`ed25519` in Phase 8).
4. Reject expired documents when `expires_at` is in the past (subject to local skew policy).

### 7.2 Proof Validation

A verifier MUST:

1. Confirm the proof object is well-formed.
2. Resolve `kid` to a key in the associated ID Doc.
   Verifiers MUST NOT resolve `kid` outside the provided Identity Document (no external resolution) in Phase 8.
3. Canonicalize payload bytes (excluding `proof`).
4. Verify Ed25519 signature using resolved public key.
5. Reject proofs outside validity windows (`created_at`, `expires_at`) when present.

## 8. Runtime Envelope Integration

AIMTP envelopes MAY include:

- `identity` (Identity Document)
- `proof` (Proof object over envelope payload)

When `AIMTP_IDENTITY=on`, relays MAY verify identity proofs if present.

- Verification failures MUST be logged.
- Verification failures MUST NOT break federation forwarding/acceptance by default.
- Implementations MAY provide explicit enforcement policy, but enforcement is out of scope for Phase 8 baseline behavior.
- Implementations MAY expose `AIMTP_IDENTITY_MODE=log|enforce`; `log` SHOULD be the default.
- When `AIMTP_IDENTITY_MODE=enforce` is selected, envelope-accepting endpoints MUST require `identity` and `proof`, and MUST reject verification failures.

## 9. Expiry and Replay Considerations

- Identity Documents SHOULD include `expires_at`.
- Proofs SHOULD include `created_at` and `expires_at`.
- Verifiers SHOULD apply bounded clock skew.
- Note: A default skew tolerance of approximately +/-5 minutes is generally sufficient for distributed deployments.
- Replayed valid proofs within validity windows are possible without nonce/state tracking; nonce registries are out of scope for Phase 8.

## 10. Security Considerations

- Key compromise requires key rotation and document re-issuance.
- Verifiers MUST treat unsupported algorithms as invalid.
- Canonicalization mismatches can invalidate signatures; implementations MUST use stable serialization.
- Logs MUST NOT include private keys or full sensitive payload bodies.
- Identity verification MUST remain additive and MUST NOT silently weaken Phase 7 trust checks.
- Future phases MAY define signed Identity Documents or anchored proofs; Phase 8 does not require global resolution or anchoring.

## 11. Conformance Vectors

Identity conformance vectors are defined under `spec/vectors/identity/`.

Minimum vector classes:

- Valid identity document + valid proof
- Identity document expired
- Proof expired
- Unknown `kid`
- Signature verification failure
