# AIMTP v0.4 Capabilities & Delegation (Phase 9)

## 1. Overview

This document defines a chain-agnostic capability authorization model for AIMTP using signed JSON capability documents and explicit delegation chains.

### 1.1 Goals

- AIMTP relays, agents, and services MUST support explicit scoped authorization grants.
- Capability authorization MUST be deterministic, auditable, and locally verifiable.
- Capability proofs MUST reuse AIMTP canonicalization and proof semantics from prior phases.
- Implementations MUST preserve compatibility with Phase 7 federation and Phase 8 identity behavior.

### 1.2 Non-goals

- Blockchain anchoring
- Global registries or resolvers
- Reputation systems
- Discovery networks
- Multi-hop federation changes
- Wallet UX
- Complex policy engines beyond explicit allow/deny evaluation

## 2. Terminology

- `CapDoc`: A signed capability document describing permissions from an issuer to a subject.
- `Scope`: An action/resource permission tuple.
- `Capability Chain` (`CapChain`): Ordered CapDocs linking delegation from issuer to final subject.
- `Issuer`: Principal granting permissions.
- `Subject`: Principal receiving permissions.
- `Authorization Request`: Action/resource request evaluated against a CapChain.
- `Capability Presentation`: Envelope-attached capability data used for runtime authorization.

## 3. Capability Document Format

A CapDoc MUST be a JSON object with the following minimum shape:

```json
{
  "id": "cap:uuid-or-hash",
  "type": "aimtp.capability",
  "issuer": "did:aimtp:relay.example",
  "subject": "did:aimtp:agent.alice",
  "scopes": [
    { "action": "mailbox.poll", "resource": "mailbox:user123" },
    { "action": "mailbox.enqueue", "resource": "mailbox:user123" }
  ],
  "constraints": {
    "max_hops": 1,
    "rate_limit": { "per_minute": 60 },
    "audience": ["did:aimtp:relay.example"]
  },
  "delegation": { "allowed": true, "max_depth": 1 },
  "issued_at": "2026-02-09T00:00:00Z",
  "expires_at": "2026-03-09T00:00:00Z",
  "proof": {
    "type": "aimtp.ed25519",
    "alg": "ed25519",
    "kid": "did:aimtp:relay.example#k1",
    "sig": "BASE64_SIGNATURE",
    "created_at": "2026-02-09T00:00:00Z",
    "expires_at": "2026-02-10T00:00:00Z"
  }
}
```

Rules:

- `id` MUST be a non-empty string.
- `type` MUST be `aimtp.capability`.
- `issuer` and `subject` MUST be non-empty principal identifiers.
- `scopes` MUST contain at least one scope.
- Each scope MUST include `action` and `resource` as non-empty strings.
- `issued_at` and `expires_at` MUST be RFC3339 when present.
- `proof` MUST be present and MUST be valid for the CapDoc payload.

## 4. Capability Grant Semantics

A CapDoc grants permissions from `issuer` to `subject`.

- `scopes` define allowed operations.
- `constraints` MAY narrow execution conditions.
- `expires_at` SHOULD be used to bound authorization lifetime.
- Missing required fields MUST cause verification failure.

## 5. Delegation Rules

Capability delegation is explicit and bounded.

- Delegation MUST be denied unless `delegation.allowed` is `true`.
- `delegation.max_depth` MUST limit downstream delegation depth from that CapDoc.
- In a CapChain, each link MUST be contiguous:
  `chain[i].subject == chain[i+1].issuer`.
- Depth violations MUST produce deterministic deny results.

## 6. Proof Binding and Canonicalization

Capability proofs MUST reuse Phase 7 canonicalization rules:

- Objects MUST be serialized with lexicographically sorted keys.
- Arrays MUST preserve order.
- `undefined` values MUST be omitted.
- Canonical bytes MUST be UTF-8 JSON.

Proof signatures MUST be computed over the canonicalized CapDoc with the `proof` field removed.
Verifiers MUST NOT include nested or sibling `proof` fields in signed bytes for any signed object.

## 7. Verification Procedure

A verifier MUST perform the following steps in order:

1. Validate CapDoc shape and required fields.
2. Validate CapDoc time bounds (`issued_at`, `expires_at`) under local skew policy.
3. Resolve issuer identity from local context only.
   Verifiers MUST NOT perform external discovery or global resolution in Phase 9.
4. Verify CapDoc proof signature against issuer identity keys.
5. Validate CapChain continuity (`subject -> issuer` linking).
6. Enforce delegation rules (`allowed`, `max_depth`).
7. Enforce constraints (at minimum `audience` and `max_hops` when present).
8. Evaluate scope match for requested action/resource.
9. Return an explicit allow/deny decision with stable reason code.

## 8. Runtime Integration

Envelopes MAY include a capability presentation:

```json
{
  "capabilities": {
    "chain": [ { "..." : "CapDoc" } ],
    "purpose": "authorize",
    "requested": { "action": "mailbox.enqueue", "resource": "mailbox:user123" }
  }
}
```

Runtime configuration:

- `AIMTP_CAPABILITIES=on|off` (default `off`)
- `AIMTP_CAP_MODE=log|enforce` (default `log` when capabilities are enabled)

Mode semantics:

- `log`:
  - Relays MAY verify/evaluate capabilities when present.
  - Relays MUST log outcome and reason.
  - Capability failures MUST NOT reject by default.
- `enforce`:
  - Envelope-accepting endpoints MUST require successful capability authorization.
  - Identity MUST be present and verifiable for the acting principal.
  - On failure, relays MUST return `401` or `403` with:
    `{ "code": "unauthorized", "reason_code": "...", "message": "..." }`.

Capabilities are additive to existing trust controls and MUST NOT bypass Phase 7 trust allowlists.

## 9. Security Considerations

- Replay remains possible inside validity windows without nonce registries.
- Implementations MUST prevent confused-deputy behavior by checking `audience` when supplied.
- Scope evaluation MUST default to deny for unknown or mismatched scopes.
- Delegation chains MUST be contiguous; broken chains MUST be denied.
- Revocation lists are out of scope for Phase 9; short expiry windows SHOULD be used.
- Logging MUST exclude full message bodies and private key material.

## 10. Conformance Vectors

Capability vectors are defined under `spec/vectors/capabilities/`.

Minimum vector classes:

- Valid single grant authorizes request
- Invalid signature
- Expired CapDoc
- Delegation not allowed
- Delegation depth exceeded
- Scope mismatch
- Audience mismatch
- Chain discontinuity
