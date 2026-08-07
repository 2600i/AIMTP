# AIMTP Agent Trust Gateway (MVP)

- **Status:** Developer Preview
- **Document authority:** Canonical for the implemented Gateway MVP
- **Last updated:** 2026-08-07

**Positioning:** experimental authorization infrastructure for autonomous
agents.

The Agent Trust Gateway is an external policy-enforcement point between an
agent and a protected system. Credentials answer, “Can this identity access the
system?” The Gateway asks, “Is this agent authorized to perform this specific
action, right now, on behalf of this principal?”

It is not part of the AIMTP wire protocol and it is not the reference relay.
The base protocol defines the interoperable envelope; the Gateway is an
optional product that evaluates a signed action request before a protected
handler runs.

```
External Agent (signed AIMTP request)
                 |
                 v
      +--------------------------------+
      | AIMTP Agent Trust Gateway      |
      | - authenticate identity        |
      | - bind agent to principal      |
      | - evaluate trust + action      |
      | - apply policy + constraints   |
      | - hold required approvals      |
      | - append audit evidence        |
      +--------------------------------+
                 |
                 v
       Protected system
       (in-process simulated handlers)
```

The evaluation covers identity/authentication, principal representation, local
trust, requested action, locally configured authority/policy, constraints,
human-approval requirements, and audit evidence. The resulting decision is
`ALLOW`, `DENY`, or `REQUIRE_APPROVAL`.

These decision tokens and the related runtime statuses are distinguished in
the canonical [`GLOSSARY.md`](GLOSSARY.md).

Authority should not exist only as an instruction inside a model. For actions
routed through this Gateway, infrastructure can refuse execution even if an
agent attempts an unauthorized action. This boundary can reduce blast radius;
it cannot guarantee that every action uses the boundary or prevent every
compromise, exploit, prompt injection, credential theft, or model failure.

## MVP behavior

The Gateway receives `POST /gateway/requests` with a signed, valid AIMTP
envelope. It deliberately uses existing protocol fields:

- `sender` is the claimed agent ID, which must match the configured identity for
  the verified signing key.
- `task.type` is the namespaced action (`purchase.create` or `demo.echo`).
- `task.input` is the action payload.
- `metadata.principal_id`, if supplied, must match the configured principal for
  that verified key.

The existing Ed25519/secp256k1 verifier authenticates the envelope. The Gateway
then maps its verified `kid` to configured `agent_id`, `principal_id`, and trust
state. A known-but-untrusted identity is denied after successful signature
verification; an unknown key or invalid signature is rejected before policy
evaluation. There is no global identity registry in this MVP.

Each envelope is single-use. `envelope.id` is registered as a nonce on first
acceptance and any resubmission is denied, and `envelope.timestamp` must fall
within a freshness window (`AIMTP_GATEWAY_MAX_REQUEST_AGE_SEC`, default 300s,
plus 60s of clock skew). A captured signed envelope therefore cannot be replayed
into a second purchase. Both checks run after the identity is established — so
unauthenticated callers cannot fill the nonce store — and before any policy
evaluation.

Policies are checked in configuration order. The checked-in
[`config/trust-gateway.demo.json`](../config/trust-gateway.demo.json) grants the
demo procurement agent `purchase.create` up to 50, and requires approval above
50. Amount must be a finite, non-negative JSON number; strings, `NaN`, infinity,
and negative values are denied.

### Operator routes

`REQUIRE_APPROVAL` creates a persistent pending record. The approval and audit
routes are the human control point, so they require an operator token supplied as
`Authorization: Bearer <token>` or `X-AIMTP-KEY`. Configure them with
`AIMTP_GATEWAY_OPERATOR_TOKENS` in `operator-id=token,operator-id=token` form.
**If no tokens are configured these routes return 503** rather than serving
anonymously, and the gateway binds to `127.0.0.1` unless `AIMTP_BIND_HOST` says
otherwise.

```sh
export TOKEN=<operator token>
curl -H "authorization: Bearer $TOKEN" http://127.0.0.1:8788/gateway/approvals
curl -X POST -H "authorization: Bearer $TOKEN" \
  http://127.0.0.1:8788/gateway/approvals/<approval-id>/approve
curl -X POST -H "authorization: Bearer $TOKEN" \
  http://127.0.0.1:8788/gateway/approvals/<approval-id>/reject
curl -H "authorization: Bearer $TOKEN" http://127.0.0.1:8788/gateway/audit
```

The approver recorded in the audit trail is the identity behind the presented
token. A body-supplied `approver_id` is ignored, so the audit trail cannot be
attributed to someone who did not act.

Approving re-checks identity, trust state and policy against current
configuration before executing — revoking an agent between the request and the
approval stops the execution. The approval is then claimed with a
compare-and-swap out of `PENDING_APPROVAL`, so concurrent approvals (including
from separate gateway processes sharing one SQLite file) execute exactly once.
Invalid approval IDs, already-decided approvals, and approvals of rejected
requests are all refused.

`GET /gateway/approvals` returns summaries only; the stored envelope stays
server-side. Audit events are append-only and contain no envelope payloads or key
material. Every decision is audited, including a pre-execution `authorized` event
so that a protected handler which crashes or is missing still leaves a complete
record. Downstream error text is never returned to the caller — failures respond
with a generic `Protected action failed` and HTTP 502, with details on the server
log only.

Request bodies are capped at `AIMTP_GATEWAY_MAX_BODY_BYTES` (default 256 KB).

## Run the demo

```sh
npm ci
npm run demo:trust-gateway
# or: ./scripts/demo-trust-gateway.sh
```

The demo generates ephemeral Ed25519 keys locally; it does not write or commit a
private key, and needs no services running. It walks the full lifecycle in one
pass: an allowed request, an approval-required request, a human approval and its
exactly-once execution, a duplicate approval being refused, a rejection, a
known-but-untrusted agent denied, an unrecognised signing key denied, a tampered
payload denied, a replayed envelope denied, and the resulting audit table.

This demonstrates decision flow and enforcement behavior, not a production
deployment or real settlement.

To run the HTTP gateway, configure the trusted public key with the existing
`AIMTP_TRUSTED_KEYS` format (`kid=base64-SPKI-or-PEM`), using the matching key ID
from the sample configuration, plus at least one operator token:

```sh
AIMTP_TRUSTED_KEYS='demo-procurement-key=<base64-spki-public-key>' \
AIMTP_GATEWAY_OPERATOR_TOKENS="operator-1=$(openssl rand -hex 24)" \
  node dist/runtime/trust-gateway.js
```

With neither key variable set, every request is denied — the process warns about
this at startup rather than failing silently.

The default store is SQLite at `runtime/aimtp-trust-gateway.sqlite`
(`AIMTP_TRUST_GATEWAY_SQLITE_PATH` to relocate it); set
`AIMTP_TRUST_GATEWAY_STORE=memory` only for ephemeral development/tests. The
Compose service publishes port 8788 on loopback, keeps its database on the
`trust-gateway-data` volume so approvals survive restarts, and reads both
`AIMTP_TRUSTED_KEYS` and `AIMTP_GATEWAY_OPERATOR_TOKENS` from the environment.
Redis remains available for the existing relay/mailbox workflow.

## Deliberate non-goals

This MVP does not implement reputation scoring, billing, a marketplace, a global
identity registry, enterprise IAM, delegation chains, a generalized policy DSL,
a dashboard, or distributed approval workflows. Its protected purchase is a
deterministic simulation: it performs no payment.

It is also not an antivirus product, vulnerability scanner, EDR, sandbox,
model-alignment system, or guarantee against compromise. Endpoint security,
credential lifecycle, downstream authorization, and protected-system hardening
remain separate responsibilities.

Two limits are worth stating plainly, because they shape what this can grow into:

- The protected service is an **in-process handler**, not a downstream AIMTP
  recipient. `protected_recipient` is matched as a string; nothing is forwarded to
  a relay or mailbox yet. Turning this into a real policy-enforcement point in
  front of a federated relay is the next structural step, not a configuration
  change.
- Per-action input validation is currently hardcoded for `purchase.create`. Other
  actions are constrained only by the policy they match, so a new action should
  arrive with its own validation rather than relying on the numeric constraint
  alone.

## Direction, not current behavior

A possible longer-term topology is:

```text
External Agent -> AIMTP Gateway -> federated AIMTP relay -> remote recipient
```

Gateway-to-relay forwarding, arbitrary downstream connectors, external policy
engines, broader delegation, and product-family components such as AIMTP
Identity or AIMTP Trust Network are planned or conceptual unless separately
implemented and tested.
