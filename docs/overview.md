# AIMTP Overview

- **Document authority:** Canonical
- **Product maturity:** Developer Preview
- **Last updated:** 2026-08-07

The **Agentic Intelligent Message Transfer Protocol (AIMTP)** is an
interoperable protocol for communicating intent, identity, authority,
constraints, context, and evidence between independent intelligent actors. An
actor may be an AI agent, human, organization, or software service; a
**principal** is the person or organization the actor represents.

AIMTP focuses on the boundary between principals:

```text
Actor A
  |
  | AIMTP envelope
  | identity | authority | intent | constraints | context | evidence
  v
Transport or relay
  |
  v
Actor B -> local policy decision -> settlement outside AIMTP
```

The protocol does not replace HTTP, APIs, MCP, A2A, OAuth, PKI, email,
payments, policy engines, or workflow systems. It can travel over or complement
those systems while giving the receiver enough structured information to make
its own trust and authorization decision.

## Protocol and product

- **AIMTP Protocol:** the `aimtp/0.1` envelope, message/task semantics,
  signatures, schemas, and conformance contract.
- **AIMTP reference implementation:** the SDK, HTTP relay, mailbox delivery
  profile, tools, and examples in this repository.
- **AIMTP Agent Trust Gateway:** a separate experimental enforcement product
  that evaluates signed AIMTP action requests before invoking a protected
  in-process handler.
- **IntentOS and federation/trust surfaces:** opt-in implementation profiles and
  experiments; they are not all part of the frozen base protocol.

The base protocol owns the envelope, not the systems behind it. Identity
providers, policy engines, approval workflows, and settlement mechanisms remain
replaceable implementation choices.

Canonical definitions for these terms live in [`GLOSSARY.md`](GLOSSARY.md).

## Maturity

The `aimtp/0.1` wire contract is frozen and backed by conformance vectors. The
repository as a whole is a developer preview. The Gateway is an MVP, and the
federation/trust extensions are experimental and default-inert. These labels
describe different surfaces; implementation version `1.0.0` is not a blanket
production-readiness claim.

## Start here

- **Architecture:** [`docs/architecture.md`](architecture.md)
- **Base specification:** [`spec/aimtp-v0.1.md`](../spec/aimtp-v0.1.md)
- **Agent Trust Gateway:** [`docs/trust-gateway.md`](trust-gateway.md)
- **Implementation guide:** [`docs/implementing-aimtp.md`](implementing-aimtp.md)
- **Runtime/API reference:** [`docs/runtime.md`](runtime.md)
- **Security boundaries:** [`docs/security.md`](security.md)
- **Schemas:** [`schemas/`](../schemas/)
- **Conformance kit:** [`tests/conformance/`](../tests/conformance/)

## Historical diagrams

The images in [`docs/history/whitepaper-images/`](history/whitepaper-images/)
predate the current trust-envelope and Gateway framing. They are retained as
historical design artifacts, not as the current architecture source of truth.
See the [historical-artifact notice](history/README.md) and use the diagrams in
[`docs/architecture.md`](architecture.md) for current system boundaries.
