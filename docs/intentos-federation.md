# IntentOS Federation Trust Boundaries (Receipts)

This document defines federation security boundaries for IntentOS receipts. It is intentionally minimal: boundaries, verification, and compatibility constraints only.

## IntentOS v2 Reference Milestone

IntentOS v2 trust semantics are now the reference opt-in trust layer for receipts. This is the line in the sand for v2 behavior.

- v2 trust semantics are opt-in via `INTENTOS_TRUST_VERSION=v2`; v1 remains the default.
- Deterministic canonicalization and Ed25519 signatures remain the trust proof basis.
- Trusted acceptance requires issuer identity plus lookup in a trusted key map.
- Policy gating remains `off|warn|enforce`.
- Execution semantics are unchanged (`admit/deny/dispatch/complete/fail` behavior is not altered by trust policy).
- In this repository, `v0.1.39+` is the v2 reference line for operators and implementers.
- For downstream forks without aligned version tags, use the post-v2-merge baseline commit as the reference line.

## Alpha Timeline

| Version | Additions |
| --- | --- |
| `v0.4.0-alpha.0` | Foundation scaffold; handshake skeleton; identity anchors skeleton |
| `v0.4.0-alpha.1` | Handshake over HTTP; gated peer signature verification |
| `v0.4.0-alpha.2` | Gated handshake capability negotiation |
| `v0.4.0-alpha.3` | Negative-case coverage; policy matrix tests |
| `v0.4.0-alpha.4` | Revocation artifact skeleton; gated revocation checks in 0.4 handshake path |

## 0.4 Gate Matrix

Authoritative 0.4 gate/default audit: [`docs/0.4-gates.md`](./0.4-gates.md).

## 0.4.0 handshake (draft)

IntentOS 0.4.0 introduces an opt-in handshake skeleton for federation bootstrapping.

- Default behavior remains inert.
- The local demo handshake only runs when both `INTENTOS_PROTOCOL_VERSION=0.4` and `INTENTOS_FEDERATION=on` are set.
- Draft payload schema: [`spec/federation-handshake-v0.4.schema.json`](../spec/federation-handshake-v0.4.schema.json)

## 0.4.0 handshake over HTTP (draft)

IntentOS 0.4.0 includes an opt-in local HTTP handshake endpoint for federation draft testing.

- Endpoint: `POST /intentos/federation/handshake`
- Gate: active only when all of the following are set:
  - `INTENTOS_PROTOCOL_VERSION=0.4`
  - `INTENTOS_FEDERATION=on`
  - `INTENTOS_IDENTITY=on`
- Default behavior is inert: when not gated, the endpoint remains unavailable (`404`).
- Request/response payloads use the same draft schema: [`spec/federation-handshake-v0.4.schema.json`](../spec/federation-handshake-v0.4.schema.json)

## 0.4.0 handshake: identity anchor exchange (draft)

The v0.4 HTTP handshake draft can optionally carry identity anchor exchange hints and inline anchors.

- `HandshakeHello` optional fields:
  - `identityAnchorSetId` (string)
  - `identityAnchorsInline` (array of signed `IdentityAnchor`)
- `HandshakeAck` fields:
  - `acceptedIdentityAnchors` (boolean)
  - `resolvedAnchorSetId` (string or `null`)
- Inline mode:
  - Server validates each inline anchor schema and Ed25519 signature before acceptance.
- Set-id mode:
  - Server attempts to load the identity anchor set from configured trust distribution source (`fs`/`http`) and validates the set payload.
  - Current draft only validates/responds; it does not persist accepted anchors.
- Demo control:
  - `INTENTOS_HANDSHAKE_SEND_ANCHORS=off|inline|setid`

## 0.4.0 identity policy: peer verification (draft)

Handshake peer possession proof is an additional opt-in policy for anchor exchange.

- Gate: active only when all are set:
  - `INTENTOS_PROTOCOL_VERSION=0.4`
  - `INTENTOS_FEDERATION=on`
  - `INTENTOS_IDENTITY=on`
- Policy env:
  - `INTENTOS_HANDSHAKE_PEER_VERIFY=off|warn|enforce` (default `off`)
- `HandshakeHello` optional field:
  - `peerProof` with `{ keyId, nonce, signature }`
  - Signature is over canonical payload containing `nonce`, `timestamp`, and sender peer identity (`senderPeerId`, plus optional relay URL if provided).
  - `keyId` may be either presented `anchorId` or public-key fingerprint (`sha256:<hex>`).
- Behavior:
  - `off`: no peer proof requirement; handshake remains as-is.
  - `warn`: when anchors are presented and proof is missing/invalid, handshake is accepted, emits one structured warning, and responds with `acceptedIdentityAnchors=false`.
  - `enforce`: when anchors are presented and proof is missing/invalid, handshake is rejected with HTTP `400`.
- This policy is additive and does not change receipt/crypto runtime semantics outside the gated handshake path.

## 0.4.0 handshake capability negotiation (draft)

The v0.4 handshake can negotiate optional federation capabilities while remaining opt-in and inert by default.

- Negotiation gate:
  - `INTENTOS_PROTOCOL_VERSION=0.4`
  - `INTENTOS_FEDERATION=on`
  - `INTENTOS_HANDSHAKE_NEGOTIATION=off|on` (default `off`)
- `HandshakeHello` optional fields:
  - `capabilitiesOffered` (string[])
  - `capabilitiesRequired` (string[])
- `HandshakeAck` fields:
  - `capabilitiesAccepted` (string[])
  - `capabilitiesMissing` (string[])
- Rules when negotiation is enabled:
  - Capability arrays are canonicalized deterministically (sorted, unique).
  - If any `capabilitiesRequired` entry is not offered by the peer, handshake fails with HTTP `400` and returns `capabilitiesMissing`.
  - Otherwise, `capabilitiesAccepted` is the intersection of the sender-offered capabilities and peer-supported capabilities.
- Negotiation is additive and does not alter receipt, crypto, or non-gated runtime semantics.

## 0.4.0 identity anchors (draft)

IntentOS 0.4.0 also introduces an opt-in identity anchor skeleton for stable peer identity bootstrapping.

- Default behavior remains inert.
- The local anchor demo only runs when both `INTENTOS_PROTOCOL_VERSION=0.4` and `INTENTOS_IDENTITY=on` are set.
- Draft payload schema: [`spec/identity-anchor-v0.4.schema.json`](../spec/identity-anchor-v0.4.schema.json)

## 0.4.0 anchor distribution (draft)

IntentOS 0.4.0 adds an opt-in draft trust artifact for distributing identity anchors through existing trust distribution adapters (`fs`/`http`).

- Default behavior remains inert.
- Distribution loading only runs when:
  - `INTENTOS_PROTOCOL_VERSION=0.4`
  - `INTENTOS_IDENTITY=on`
  - `INTENTOS_TRUST_DISTRIBUTION=fs|http`
- Draft anchor-set schema (`type=identity-anchors`): [`spec/identity-anchor-set-v0.4.schema.json`](../spec/identity-anchor-set-v0.4.schema.json)
- Adapter source envs for this artifact:
  - `INTENTOS_TRUST_IDENTITY_ANCHORS_PATH` (fs mode)
  - `INTENTOS_TRUST_HTTP_IDENTITY_ANCHORS_URL` (http mode)

## 0.4.0 trust bundle (draft)

IntentOS 0.4.0 adds a read-only composite trust artifact to package anchor, revocation, and transparency metadata into one payload.

- Why trust bundles:
  - operators can distribute one signed snapshot-like document instead of coordinating multiple files.
  - each artifact block remains optional; runtime defaults stay inert.
- Draft schema: [`spec/trust-bundle-v0.4.schema.json`](../spec/trust-bundle-v0.4.schema.json)
- Gates:
  - `INTENTOS_PROTOCOL_VERSION=0.4`
  - `INTENTOS_TRUST_BUNDLE=on` (default `off`)
  - `INTENTOS_TRUST_DISTRIBUTION=fs|http`
- Distribution source envs:
  - `INTENTOS_TRUST_BUNDLE_PATH` (fs mode)
  - `INTENTOS_TRUST_HTTP_BUNDLE_URL` (http mode)
- Policy:
  - `INTENTOS_TRUST_BUNDLE_POLICY=off|warn|enforce` (default `off`)
  - `off`: fully inert (no load/verify work).
  - `warn`: validate and emit deterministic warning diagnostics on invalid bundle input.
  - `enforce`: reject invalid bundle input with deterministic code (`trust_bundle_invalid`).
- Proof interaction:
  - if `INTENTOS_REVOCATION_PROOF=on` and bundle includes `revocations`, missing/unknown/invalid revocation proof yields `revocation_proof_missing|revocation_proof_key_unknown|revocation_proof_invalid`.
  - no additional identity-anchor proof gate is introduced in 0.4.
- Tooling:
  - `node tools/trust-bundle-pack.mjs --out <bundle.json> --issuer <issuer> [--identity-anchors-set ... --revocations-set ...]`
  - `node tools/trust-bundle-verify.mjs --in <bundle.json> [--trusted-keys-json @trusted-keys.json]`
  - `node tools/trust-bundle-apply.mjs --in <bundle.json> --store <snapshot-state.json|store-dir> --policy warn|enforce`
- CI apply health output:
  - `node tools/trust-bundle-apply.mjs --in <bundle.json> --store <path> --policy enforce --ci`
  - emits one-line JSON: `{ health, exitCode, issues, applied }`
  - deterministic exit codes: `0` healthy, `2` misconfigured, `3` invariant_failed, `1` unexpected
- Runtime boundary:
  - runtime execution remains inert by default.
  - trust bundle application occurs only through explicit operator invocation of the apply tool (or direct helper call), not automatically.

## 0.4.0 revocations distribution (skeleton)

IntentOS 0.4.0 adds a draft `revocations` trust artifact as an opt-in distribution skeleton.

- Purpose:
  - carry revocation entries (`peer`, `key`, `anchor`) as distributed trust metadata.
  - validate artifact shape and report policy outcomes without changing runtime admission flow.
- Draft schema: [`spec/revocation-set-v0.4.schema.json`](../spec/revocation-set-v0.4.schema.json)
- Gates:
  - `INTENTOS_PROTOCOL_VERSION=0.4`
  - `INTENTOS_REVOCATIONS=on` (default `off`)
  - `INTENTOS_TRUST_DISTRIBUTION=fs|http`
- Optional proof gate (additive, default inert):
  - `INTENTOS_REVOCATION_PROOF=off|on` (default `off`)
  - when `on`, missing/unknown/invalid proofs return deterministic codes:
    - `revocation_proof_missing`
    - `revocation_proof_key_unknown`
    - `revocation_proof_invalid`
  - trusted verifier keys are supplied via `INTENTOS_TRUSTED_REVOCATION_KEYS_JSON` (`{"<keyId>":"<publicKeyPem>"}`)
- Policy:
  - `INTENTOS_REVOCATION_POLICY=off|warn|enforce` (default `off`)
  - `off`: inert/no-op.
  - `warn`: validate and return warnings on invalid artifacts.
  - `enforce`: validate and return errors with reject status for tool execution.
- Distribution source envs:
  - `INTENTOS_TRUST_BUNDLE_REVOCATIONS_PATH` (fs mode)
  - `INTENTOS_TRUST_BUNDLE_REVOCATIONS_PROOF_PATH` (fs mode, optional, used when proof gate is `on`)
  - `INTENTOS_TRUST_HTTP_REVOCATIONS_URL` (http mode)
  - `INTENTOS_TRUST_HTTP_REVOCATIONS_PROOF_URL` (http mode, optional, used when proof gate is `on`)
- Signing/verification tools:
  - `node tools/revocation-sign.mjs --in <set.json> --key <private.pem> --key-id <id> --out <proof.json>`
  - `node tools/revocation-verify.mjs --set <set.json> --proof <proof.json> --trusted-keys-json @trusted-keys.json`
- Enforcement (gated handshake path only):
  - defaults remain inert (`INTENTOS_REVOCATIONS=off`, `INTENTOS_REVOCATION_POLICY=off`).
  - when enabled for 0.4 handshake:
    - `peer` subject match (`senderPeerId`) -> `handshake_peer_revoked`
    - `key` subject match (`peerProof.keyId` or anchor `kid`) -> `handshake_key_revoked`
    - `anchor` subject match (anchor id or anchor fingerprint) -> `anchor_revoked`
  - `warn`: handshake continues and emits deterministic structured warning logs with `code` + `subject`.
  - `enforce`: handshake rejects with HTTP `400` and stable code.
- Runtime boundary:
  - this does **not** change receipt or crypto semantics, and does not alter non-gated runtime admission defaults.

## 0.4.0 error code stability (RC)

The following codes are the stable, structured failure/success signals used by 0.4 federation tools and HTTP handshake paths.

### Handshake codes

| Code | Meaning |
| --- | --- |
| `handshake_capability_required_missing` | Required capability is missing during negotiation. |
| `handshake_identity_anchor_signature_invalid` | Inline identity anchor signature verification failed. |
| `handshake_peer_proof_missing` | Anchors were presented but `peerProof` was omitted in enforce mode. |
| `handshake_peer_proof_invalid` | `peerProof` payload/signature validation failed. |
| `handshake_peer_proof_key_unknown` | `peerProof.keyId` did not match a presented anchor id/fingerprint. |
| `handshake_peer_revoked` | Sender peer id matched an active revocation entry. |
| `handshake_key_revoked` | Presented key id (`peerProof`/anchor `kid`) matched an active revocation entry. |
| `anchor_revoked` | Presented anchor id/fingerprint matched an active revocation entry. |

### Identity anchor fetch codes

| Code | Meaning |
| --- | --- |
| `identity_anchor_fetch_invalid_json` | Anchor payload could not be parsed as JSON. |
| `identity_anchor_fetch_schema_invalid` | Anchor payload failed schema validation. |

### Revocation distribution and proof codes

| Code | Meaning |
| --- | --- |
| `revocation_fetch_invalid_json` | Revocation payload could not be parsed as JSON. |
| `revocation_fetch_schema_invalid` | Revocation payload failed schema validation. |
| `revocation_proof_missing` | Required proof fields are missing (or proof absent when required). |
| `revocation_proof_key_unknown` | Proof `keyId` is not present in trusted revocation keys. |
| `revocation_proof_invalid` | Proof canonical binding or signature verification failed. |
| `revocation_proof_verified` | Revocation proof verification succeeded. |

### Trust bundle verify/apply codes

| Code | Meaning |
| --- | --- |
| `trust_bundle_invalid` | Trust bundle JSON/schema validation failed. |
| `input_unreadable` | Apply CLI could not read the input bundle path. |
| `revocation_proof_missing` | Bundle proof gate is on and revocation proof is missing/invalidly incomplete. |
| `revocation_proof_key_unknown` | Bundle proof gate is on and proof key is not trusted. |

## 0.4.0 env defaults (compact)

See the full audited matrix at [`docs/0.4-gates.md`](./0.4-gates.md).

## Policy Modes

- `off`: checks behind the mode gate remain inert; requests continue on the baseline path without policy-driven rejection, and no policy warning event is emitted.
- `warn`: policy checks evaluate and surface deterministic warning diagnostics, but request flow continues (no hard reject from that policy gate).
- `enforce`: policy checks evaluate and reject invalid input deterministically (for example, HTTP `400` or non-zero tool exit) when a gated violation occurs.

| Check | `off` | `warn` | `enforce` |
| --- | --- | --- | --- |
| Handshake hello missing required field (gated `0.4` + federation on) | HTTP `400` | HTTP `400` | HTTP `400` |
| Negotiation required capability missing (`INTENTOS_HANDSHAKE_NEGOTIATION=on`) | HTTP `400` | HTTP `400` | HTTP `400` |
| Peer proof invalid/missing key reference (`INTENTOS_HANDSHAKE_PEER_VERIFY`) | Accept baseline | Accept + warning + deterministic flag | Reject (`400`) |
| Identity anchor set schema invalid (`INTENTOS_IDENTITY_POLICY`) | Inert accept | Accept + warning | Reject |

Note: current distribution tooling maps identity policy behavior through the existing receipt policy gate while preserving inert defaults.

## Bridge Proofs

Bridge proofs are signed federation assertions used only for explicit multi-hop bridging in Trust v2. They do not enable transitive trust by default.

- Schema: [`schemas/bridge-proof-v1.schema.json`](../schemas/bridge-proof-v1.schema.json)
- Activation: bridge proof is evaluated only when supplied to receipt policy (`INTENTOS_TRUST_BRIDGE_PROOF_JSON` or `trustBridgeProofJson` option).
- Verification: malformed proof shape hard-fails as `TRUST_BUNDLE_INVALID`; bad signature hard-fails as `TRUST_SIGNATURE_INVALID`.

Example bridge proof JSON:

```json
{
  "version": "v1",
  "issuer": "relay://b",
  "subject": "relay://c",
  "subjectPublicKeyPem": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n",
  "subjectKeyFingerprint": "0123456789ab",
  "issuedAt": 1771491000,
  "expiresAt": 1771491120,
  "sigAlg": "ed25519",
  "signature": "MEUCIQ..."
}
```

Tool commands:

- Mint proof:
  - `node tools/bridge-proof.mjs mint --issuer relay://b --subject relay://c --subject-key ./relay-c-public.pem --ttl 120 --issuer-key ./relay-b-private.pem --out ./bridge-proof.json`
- Verify proof:
  - `node tools/bridge-proof.mjs verify --proof ./bridge-proof.json --trusted-keys ./trusted-keys.json`

3-hop demo integration:

- Default bridge case (runtime-minted): `FEDERATION_BRIDGE=1 INTENTOS_TRUST_VERSION=v2 npm run demo:federation:3hop:v2`
- Tool-minted bridge proof path: `FEDERATION_BRIDGE=1 FEDERATION_BRIDGE_PROOF_PATH=./bridge-proof.json INTENTOS_TRUST_VERSION=v2 npm run demo:federation:3hop:v2`
- Tool mint inside demo: `FEDERATION_BRIDGE=1 FEDERATION_BRIDGE_USE_TOOL=1 INTENTOS_TRUST_VERSION=v2 npm run demo:federation:3hop:v2`

## Threat Model (Brief)
- Forged receipts: an attacker fabricates `receipt.*` objects that look valid.
- Replay: old but valid receipts are replayed to mislead state consumers.
- Confused deputy across relays: Relay A accepts receipt authority that only Relay B should have, or mixes trust domains.

## What Must Be Verifiable
- Envelope trust (existing): the originating envelope must pass existing signature and capability validation policies.
- Receipt authenticity (federation): a receipt must be cryptographically attributable to a relay identity and bound to the referenced execution.

Minimum verifiable claims for a receipt:
- `envelopeId`
- `intentId`
- `type`
- `timestamp`
- `metadata`
- `issuer` (relay identity)
- `signature` (over canonicalized receipt fields)

## Minimal Receipt Signing Model
Receipt extension for federation:
- `issuer`: stable relay identity (for example, relay DID or key ID namespace).
- `signature`: detached or embedded signature generated by issuer relay.

Signing input:
- Canonicalized receipt fields, at minimum:
  - `envelopeId`, `intentId`, `type`, `timestamp`, `metadata`, `issuer`
- Canonicalization must be deterministic (for example RFC 8785 JSON Canonicalization Scheme, or an equivalent frozen profile).

Verification by consumers:
- Verify signature against issuer public key.
- Require issuer membership in local trusted-relay set.
- Reject unknown issuer or untrusted key.
- Key distribution must be explicit and pinned (allowlist, trust bundle, or out-of-band key registry). Trust-on-first-use is out of scope.

## Audience and Cross-Relay Routing Boundaries
Audience mapping:
- In federation, receipt audience should resolve to the requester trust domain and relay path, not only a local mailbox address.
- A relay must only forward receipts to routes authorized for that audience domain.

Spoofing prevention requirements:
- Treat `(envelopeId, intentId, issuer)` as a required binding tuple.
- Reject receipts where tuple conflicts with known envelope provenance.
- Apply replay window checks on `timestamp` and deduplicate by stable receipt identifier/signature hash.

## Versioning and Compatibility
- Current local-only receipts remain valid for single-relay operation.
- Federation signing fields (`issuer`, `signature`) should be additive for backward compatibility.
- Consumers must define policy:
  - local mode: unsigned receipts permitted
  - federation mode: unsigned receipts rejected
- Any canonicalization/signature profile must be versioned and frozen before broad federation rollout.

## Runtime Receipt Policy (Opt-In)
- `INTENTOS_RECEIPT_POLICY=off|warn|enforce` (default `off`)
- `INTENTOS_TRUST_VERSION=v1|v2` (default `v1`)
- `INTENTOS_TRUSTED_RECEIPT_KEYS_JSON` (existing): JSON object mapping `issuer -> PEM public key`
- `INTENTOS_TRUST_V2_MAX_TIMESTAMP_SKEW_SEC` (optional): max absolute clock skew for v2 timestamp sanity checks

Policy behavior when a receipt envelope is processed:
- `off`: receipt processing continues even if receipt verification fails or signature/issuer is missing.
- `warn`: processing continues, and runtime emits a structured warning event (`event=intentos_receipt_policy_warning`).
- `enforce`: unverified receipts are rejected from trusted receipt processing; runtime continues running and does not crash.

Verified receipts are marked trusted and accepted in all modes.

## Migration: v1 → v2 (Operators)

### Minimal Recommended Environment

```sh
INTENTOS_TRUST_VERSION=v2
INTENTOS_RECEIPT_POLICY=enforce
INTENTOS_TRUSTED_RECEIPT_KEYS_JSON='{"relay://X":"<PUBLIC_KEY_PEM>"}'
```

Optional hardening:

```sh
INTENTOS_TRUST_V2_MAX_TIMESTAMP_SKEW_SEC=300
```

### Behavior Changes in v2

- `v2 + enforce`:
  - unsigned terminal receipts are rejected
  - tampered signed receipts are rejected (invalid signature)
  - unknown issuer receipts are rejected even when signed
- `v2 + warn`:
  - acceptance behavior matches `enforce` for terminal receipt trust decisions
  - warning/diagnostic messaging may differ from `enforce`

### What Does NOT Change

- IntentOS execution semantics do not change (`admit/deny/dispatch/complete/fail`).
- Handler behavior and routing logic do not change.
- Transport/network/orchestration behavior does not change.
- v1 remains available and default unless `INTENTOS_TRUST_VERSION=v2` is explicitly set.

## IntentOS v2 Trust Semantics (Versioned Successor)
This section defines the versioned successor to frozen v1 semantics. v1 remains default unless `INTENTOS_TRUST_VERSION=v2` is set.

### 1) Version Selection and Compatibility (v2)
- Trust semantics are selected by policy context:
  - `INTENTOS_TRUST_VERSION=v1` -> frozen v1 behavior.
  - `INTENTOS_TRUST_VERSION=v2` -> v2 behavior.
- Receipt field compatibility:
  - `receipt.trustVersion` is optional and additive.
  - absent `receipt.trustVersion` MUST be interpreted as `v1` unless policy context explicitly selects `v2`.
- v1 receipts remain valid protocol artifacts and are not silently reinterpreted.

### 2) Verification Requirements (v2)
- For terminal receipts (`receipt.denied`, `receipt.completed`, `receipt.failed`), a trusted result requires:
  - signature present
  - known issuer in local trusted key map
  - valid signature over v2 canonical payload
- Unknown issuer MUST fail verification even when signature bytes are present.
- v2 trust checks are local policy checks only and MUST NOT change execution transitions.

### 3) Canonicalization Profile (v2)
- v2 signing/verification canonical payload MUST be deterministic and include:
  - `envelopeId`
  - `intentId`
  - `issuer`
  - `type`
  - `timestamp`
  - `metadata`
  - `sigAlg`
  - `trustVersion` (fixed `v2` in payload)
- Determinism requirements are unchanged:
  - object keys sorted lexicographically
  - `undefined` members omitted
  - equivalent content yields identical canonical bytes

### 4) Replay Linkage and Anti-Tamper Expectations (v2)
- A verifiable receipt MUST bind the tuple:
  - `envelopeId + intentId + issuer + type + timestamp + metadata`
- Timestamp checks:
  - optional sanity bounds MAY be enforced via `INTENTOS_TRUST_V2_MAX_TIMESTAMP_SKEW_SEC`
  - out-of-window timestamps SHOULD fail trust verification when bound is configured
- Anti-replay storage (dedup store, nonce DB, global sequence) is explicitly out of scope for this phase.

### 5) Authority Boundaries Across Relays (v2)
- Receipt authority is issuer-scoped per trust domain.
- A relay MUST trust only explicitly configured issuer keys.
- A relay MUST NOT infer cross-relay trust transitively from receipt forwarding alone.

### Trust v2 Strict Semantics
- v2 is active when `INTENTOS_TRUST_VERSION=v2`.
- In v2, terminal receipt trust is fail-closed:
  - runtime MUST NOT accept unsigned or untrusted terminal receipts in `off`, `warn`, or `enforce`.
  - `warn` vs `enforce` may differ in warning/diagnostic emission only.
- Terminal receipt acceptance outcomes in v2:
  - missing signature => `accepted=false`
  - invalid or tampered signature => `accepted=false`
  - revoked anchor or key => `accepted=false`
  - expired or out-of-skew anchor => `accepted=false`

### Error Codes
- `TRUST_BUNDLE_INVALID`: trust bundle or anchor validity failure (including malformed bundle and expired/out-of-skew anchor); surfaces in receipt policy and trust bundle apply.
- `TRUST_ANCHOR_REVOKED`: revoked anchor/key detected during trust evaluation; surfaces in receipt policy and trust bundle apply.
- `TRUST_SIGNATURE_INVALID`: required trust signature missing or invalid/tampered; surfaces in receipt policy and trust bundle apply.

#### Compatibility Contract
- These v2 acceptance outcomes and error codes are stable within the `0.4.x` line.
- Under v2, `warn` vs `enforce` may change warnings/diagnostics, but not acceptance.

#### Regression Tests
- `tests/federation-v2-policy-regression.test.mjs`
- `tests/trust-v2-strict-mode.test.mjs`

### Upgrade Guidance
- Keep existing behavior (default):
  - `INTENTOS_TRUST_VERSION=v1` (or unset)
  - `INTENTOS_RECEIPT_POLICY=off|warn|enforce` as currently configured
- Stage v2 rollout:
  1. Set `INTENTOS_TRUST_VERSION=v2` and populate `INTENTOS_TRUSTED_RECEIPT_KEYS_JSON`.
  2. Choose `warn` or `enforce` based on preferred diagnostics/alerting behavior.
  3. Note: under v2, acceptance outcomes are strict and identical across `warn` and `enforce`.

## IntentOS v1 Trust Semantics (Frozen)
**FROZEN v1:** This section is normative for IntentOS v1 trust behavior. Changes to these rules MUST be versioned explicitly in a future IntentOS trust-semantics revision.

### 1) Receipt Trust Model (v1)
- A receipt is **trusted** only when local verification succeeds (`verified=true`) against a locally configured trusted issuer key set.
- A trusted receipt MUST include:
  - `issuer` (issuer identity string)
  - `sigAlg` (signature algorithm)
  - `signature` (base64 signature bytes)
- In v1, `sigAlg` MUST be `ed25519` for a receipt to verify as trusted.
- The signing payload MUST be canonicalized from receipt fields:
  - `receiptId`, `envelopeId`, `intentId`, `type`, `timestamp`, `metadata`, `issuer`, `sigAlg`
- The `signature` field MUST be excluded from signing payload canonicalization.
- Canonicalization MUST be deterministic:
  - object keys are sorted lexicographically
  - `undefined` object members are omitted
  - equivalent receipt content yields byte-identical canonical payload
- Receipts without valid trust proof MAY still exist as protocol artifacts, but MUST NOT be treated as trusted.

### 2) Verification Semantics (v1)
- `verifyReceipt(receipt, trustedKeys)` MUST return a result object with:
  - `verified` (`true` or `false`)
  - `reason` (human-readable reason)
- `verified=true` means the signature is cryptographically valid for a trusted issuer key.
- `verified=false` means the receipt is not trusted in local verification context.
- `verified=false` covers both:
  - **unverified**: trust checks ran and failed (for example invalid signature)
  - **unverifiable**: required trust inputs are missing/unsupported (for example missing signature or unknown issuer)
- Trust keys are local and explicit:
  - `INTENTOS_TRUSTED_RECEIPT_KEYS_JSON` MUST be a JSON object mapping `issuer -> PEM public key`
  - invalid or missing entries MUST NOT produce trusted verification
- v1 failure modes include (non-exhaustive reason strings):
  - missing signature
  - missing issuer
  - missing sigAlg
  - unsupported sigAlg
  - untrusted issuer
  - invalid signature
  - verification error

### 3) Policy Semantics (v1)
- `INTENTOS_RECEIPT_POLICY` supports `off|warn|enforce`.
- Default mode MUST be `off` for backward compatibility and non-breaking behavior.
- `off`:
  - receipt processing MUST continue even when receipt trust verification fails
  - unverified receipts MAY be processed as artifacts, but are not trusted
- `warn`:
  - receipt processing MUST continue when verification fails
  - runtime SHOULD emit a structured warning event for unverified/unverifiable receipts
- `enforce`:
  - unverified/unverifiable receipts MUST be rejected from trusted receipt acceptance
  - runtime execution MUST continue; policy enforcement MUST NOT crash the relay/process
- Policy enforcement applies to receipt acceptance semantics only. It MUST NOT modify IntentOS execution semantics (`admit/deny/dispatch/complete/fail`).

### 4) Non-Goals / Explicit Exclusions (v1)
- v1 trust semantics do NOT grant cross-relay execution authority.
- v1 trust semantics do NOT define automatic trust propagation between relays/domains.
- v1 trust semantics do NOT define receipt-key revocation, expiry, or rotation semantics.
- v1 trust semantics do NOT guarantee global ordering or replay prevention beyond deterministic canonicalization and signature verification.

### 5) Compatibility Guarantees (v1)
- Unsigned receipts remain valid protocol artifacts in v1.
- Signed receipts are optional in v1.
- v1 receipt verification is local and best-effort, based on local trust configuration.
- Future versions that alter trust behavior MUST introduce explicit versioned trust semantics and MUST NOT silently reinterpret v1 behavior.

## IntentOS v3 Trust (Draft)

IntentOS v3 trust design is currently captured as a draft proposal for structured Trust Bundles, intended to support portable issuer trust configuration with multi-key rotation and optional validity windows. See `spec/intentos-v3-trust-draft.md` for the draft structure and resolution model. Core v3 trust semantics remain draft-only and non-normative.

## v3 Bundle Loader (Experimental)

An experimental, opt-in trust bundle loader is available for receipt-policy trust key configuration only.

- New optional env: `INTENTOS_TRUST_BUNDLE_PATH=/path/to/trust-bundle.json`
- New optional env: `INTENTOS_TRUST_BUNDLE_REQUIRE_SIGNATURE=on|off` (default `off`)
- New optional env: `INTENTOS_TRUST_BUNDLE_TRUSTED_SIGNERS_JSON='{"signer://name":"<PUBLIC_KEY_PEM>"}'`
- New optional env: `INTENTOS_TRUST_BUNDLE_SIGNER_ALLOWLIST='signer://a,signer://b'`
- New optional env: `INTENTOS_TRUST_BUNDLE_REVOCATIONS_JSON='{"signers":[],"issuerKeys":{}}'`
- Loader behavior:
  - Reads the JSON file from disk.
  - Performs structural validation (bundle object with `issuers`, issuer entries with `keys[]`, and key entries containing `publicKeyPem`).
  - Supports optional `revocations` with:
    - `revocations.signers: string[]` (bundle signer IDs)
    - `revocations.issuerKeys: { [issuer]: string[] }` (issuer key fingerprints)
  - Supports optional key validity fields `notBefore` and `notAfter` (unix seconds).
  - Validates key windows: when both fields are present, `notBefore` MUST be less than `notAfter`.
  - Evaluates keys in stable bundle order.
  - Resolves each issuer to active keys at evaluation time `T`, where a key is active when `(notBefore absent OR T >= notBefore) AND (notAfter absent OR T < notAfter)`.
  - Excludes revoked issuer keys before signature verification by matching computed key fingerprint.
  - Attempts signature verification against each active key in order until one succeeds.
- Signed bundle behavior (bundle path only):
  - Signature verification is opt-in and disabled by default.
  - If `INTENTOS_TRUST_BUNDLE_REQUIRE_SIGNATURE=off`, unsigned bundles are accepted (backward compatible).
  - If `INTENTOS_TRUST_BUNDLE_REQUIRE_SIGNATURE=on`, the bundle must include:
    - `bundleVersion: "v3"`
    - `bundleId` (string)
    - `issuedAtSec` (number)
    - `signer` (string signer issuer ID)
    - `sigAlg: "ed25519"`
    - `signature` (base64)
  - Signature input is canonical JSON of the bundle with `signature` excluded, using deterministic stable key sorting.
  - Signer key resolution is local-only from `INTENTOS_TRUST_BUNDLE_TRUSTED_SIGNERS_JSON` (no network fetch).
  - When signer allowlist is set, only listed signer IDs are accepted.
  - If signer ID is listed in `revocations.signers`, bundle loading fails with `bundle signer revoked`.
- Precedence:
  - If both `INTENTOS_TRUST_BUNDLE_PATH` and `INTENTOS_TRUSTED_RECEIPT_KEYS_JSON` are set, the bundle path source takes precedence.
  - If `INTENTOS_TRUST_BUNDLE_REVOCATIONS_JSON` is set, it overrides `bundle.revocations`.
- Scope boundary:
  - This changes receipt-policy trust resolution for bundle path usage only.
  - Existing `INTENTOS_TRUSTED_RECEIPT_KEYS_JSON` behavior is unchanged (no validity-window semantics).
  - IntentOS execution semantics remain unchanged.

For bundle-path verification, evaluation time `T` uses `receipt.timestamp` when it is present and numeric; otherwise it uses current unix time (`Date.now()/1000`). Unknown issuers fail as `unknown issuer`, issuers with no active keys fail as `no active key for issuer`, and failures across all active keys fail as `signature invalid for all active keys`.

When bundle signatures are required, bundle configuration failures use specific reasons:

- `bundle signature required`
- `unknown bundle signer`
- `bundle signature invalid`
- `bundle signer not allowed`
- `bundle signer revoked`
- `bundle malformed`

Short signed bundle example:

```json
{
  "bundleVersion": "v3",
  "bundleId": "bundle-prod-2026-02-11",
  "issuedAtSec": 1767225600,
  "signer": "signer://relay-admin",
  "sigAlg": "ed25519",
  "signature": "BASE64_SIGNATURE",
  "revocations": {
    "signers": ["signer://compromised-admin"],
    "issuerKeys": {
      "relay://north-1": ["4f6f2f755f10"]
    }
  },
  "issuers": {
    "relay://north-1": {
      "keys": [{ "publicKeyPem": "-----BEGIN PUBLIC KEY-----\\n...\\n-----END PUBLIC KEY-----\\n" }]
    }
  }
}
```

Key fingerprint revocation note: use the fingerprint shown in bundle diagnostics (`attempts[].fingerprint`) for the target issuer key, then add it under `revocations.issuerKeys[issuer]`.

### v3 Rotation Guidance (Bundle Path)

- Add a new key with an overlapping validity window before retiring the old key.
- Keep the old key active during overlap so existing in-flight receipts can still verify.
- Retire the old key by setting `notAfter` once all expected receipts are signed by the new key.
- Preserve key ordering in the bundle to keep evaluation and diagnostics deterministic.

### v3 Warn-Mode Diagnostics Event

When `INTENTOS_RECEIPT_POLICY=warn` and bundle-path verification fails, runtime emits a single structured event:

- `event=intentos_trust_bundle_verify_attempts`
- Includes: `reason`, `issuer`, `trustVersion`, `keysTotal`, `keysActive`
- Includes truncated `attemptReasons` (first three reasons only)
- No extra diagnostics event is emitted in `off` or `enforce`

Example unsigned bundle file: `examples/trust-bundle.json`

Example signed bundle file: `examples/trust-bundle.signed.example.json`

Signing helper:

```bash
node tools/trust-bundle-sign.mjs --in examples/trust-bundle.json --out trust-bundle.signed.json --signer signer://relay-admin --private-key-pem /path/signer-private-key.pem
```

## v3 Trust Distribution Adapters (Experimental)

IntentOS v3 supports an opt-in trust distribution boundary for selecting where trust artifacts are sourced, without changing trust or receipt verification semantics.

- `INTENTOS_TRUST_DISTRIBUTION=off|fs|http` (default `off`)
  - `off`: existing trust loading path is unchanged.
  - `fs`: uses local filesystem paths via adapter snapshot.
  - `http`: fetches trust artifacts, writes local temp snapshots, then reuses the existing verification pipeline.
- `INTENTOS_TRUST_SNAPSHOT_POLICY=off|warn|enforce` (default `off`)
  - Applies only when trust distribution is enabled.
  - Uses transparency heads (when present) to evaluate monotonicity (`ahead/equal/behind/conflict`).
  - `warn` emits diagnostics for rollback/fork-like candidates and proceeds.
  - `enforce` rejects `behind/conflict` candidates before trust artifacts are applied.
- `INTENTOS_TRUST_SNAPSHOT_STATE_PATH=/path/to/trust-snapshot-state.json` (optional)
  - Enables persisted snapshot state across process restarts.
  - State file is used to seed last accepted transparency head for rollback/fork checks.
  - In `INTENTOS_TRUST_SNAPSHOT_POLICY=enforce`, snapshot state save failures reject trust loading.

Adapter-related env vars:

- Filesystem mode:
  - `INTENTOS_TRUST_BUNDLE_PATH=/path/to/trust-bundle.json`
  - `INTENTOS_TRUST_BUNDLE_REVOCATIONS_PATH=/path/to/revocations.json` (optional)
  - `INTENTOS_TRANSPARENCY_LOG_PATH=/path/to/trust-log.jsonl` (optional, existing transparency behavior)
- HTTP mode:
  - `INTENTOS_TRUST_HTTP_BUNDLE_URL=https://.../trust-bundle.json`
  - `INTENTOS_TRUST_HTTP_REVOCATIONS_URL=https://.../revocations.json` (optional)
  - `INTENTOS_TRUST_HTTP_HEAD_URL=https://.../trust-head.json` (optional)
  - `INTENTOS_TRUST_HTTP_CHECKPOINT_URL=https://.../trust-checkpoint.json` (optional)
  - `INTENTOS_TRUST_HTTP_LOGTAIL_URL=https://.../trust-log-tail.jsonl` (optional, non-checkpoint entries only)

Guarantees:

- Adapter selection changes source-of-truth location only.
- Bundle signature checks, revocation application, transparency verification, and receipt trust decisions are unchanged.
- Default behavior remains unchanged unless `INTENTOS_TRUST_DISTRIBUTION` is set to `fs` or `http`.
- Snapshot policy is opt-in and affects only distribution snapshot acceptance; receipt/trust crypto semantics are unchanged.
- In transparency verify mode with checkpoint verify enabled, a distribution snapshot MAY provide a transparency proof (`head + optional checkpoint + log tail`) so runtime can verify the head without downloading a full local JSONL log.

## v3 Transparency Log (Experimental)

IntentOS v3 includes an opt-in local transparency log for trust-bundle and receipt-policy events. This is integrity-focused telemetry for operators and does not change trust or execution semantics.

- `INTENTOS_TRANSPARENCY_LOG_PATH=/path/to/trust-log.jsonl`
- `INTENTOS_TRANSPARENCY_LOG_MODE=off|append|verify` (default `off`)
- `INTENTOS_TRANSPARENCY_CHECKPOINT_MODE=off|append|verify` (default `off`)
- `INTENTOS_TRANSPARENCY_CHECKPOINT_PUBLIC_KEY=<PEM>` (used in `verify` mode)
- `INTENTOS_TRANSPARENCY_CHECKPOINT_SIGNING_KEY=<PEM>` (used in checkpoint append tooling)

Behavior:

- `off`: no transparency log reads/writes.
- `append`: appends JSONL entries for:
  - `bundle_loaded`
  - `bundle_rejected`
  - `revocation_applied`
  - `policy_reject`
- `verify`: verifies the full hash chain on bundle load and rejects bundle trust loading when the chain is broken.

Optional distribution transparency proof:

- When trust distribution is enabled, snapshots can include an in-memory proof containing:
  - `head` (`size`, `chainHash`)
  - optional signed checkpoint
  - tail log entries (non-checkpoint entries only)
- If transparency verify mode and checkpoint verify mode are enabled with a checkpoint public key, runtime verifies this proof first.
- If the proof is missing or proof verification preconditions are not enabled, runtime behavior falls back to existing log-path verification.

Optional checkpoints:

- Checkpoints are signed integrity markers stored in the same JSONL log as `{"kind":"checkpoint",...}` records.
- A checkpoint binds `size` and `chainHash` to an operator signer key (Ed25519 over canonical JSON).
- In checkpoint verify mode, runtime can verify only entries after the latest valid checkpoint.
- If no valid checkpoint is found (or checkpoint verify mode/key is not enabled), behavior falls back to full-chain verification.
- Runtime does not sign checkpoints. Signing is performed only by operator tooling (for example, `tools/trust-log-checkpoint.mjs`).

Use cases:

- Audit trail for trust-bundle acceptance/rejection decisions.
- Forensic review of bundle revocation and policy-rejection events after incidents.
- Faster repeated integrity checks on long logs via incremental verification checkpoints.

Scope note:

- This is not a blockchain and does not provide global consensus.
- It is a local append-only integrity chain (`prevHash -> entryHash -> chainHash`) intended for operator-controlled environments.
- Checkpoint signer keys are operator keys and are separate from trust-bundle signer keys.

Operational guidance (checkpoint key rotation):

- Rotate checkpoint signing keys by publishing a new checkpoint signed by the new key.
- During rotation windows, verify with the currently active public key configured in `INTENTOS_TRANSPARENCY_CHECKPOINT_PUBLIC_KEY`.
- Preserve old checkpoints for audit history; they remain historical artifacts even after key rotation.

## Trust Roadmap (v3, Non-binding)

The following items are directional only. They are not commitments and have no guaranteed delivery order.

- Key rotation and explicit key validity windows.
- Delegated issuance and chain-of-trust models for multi-relay environments.
- Trust bundles for portable multi-issuer trust distribution.

Any future trust changes MUST be versioned and opt-in. v1/v2 behavior MUST NOT be silently reinterpreted.
