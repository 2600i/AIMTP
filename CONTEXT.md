# AIMTP Working Context

## Current architecture

AIMTP is an interoperable protocol for communicating intent, identity,
authority, constraints, context, and evidence between independent intelligent
actors. It owns the envelope at a principal boundary, not the identity system,
policy engine, transport, workflow engine, or settlement mechanism behind it.

The principal repository surfaces are:

- Frozen `aimtp/0.1` specification, schemas, canonical signatures, and
  conformance vectors.
- JavaScript SDK and TypeScript protocol/runtime components.
- Reference HTTP relay with mailbox delivery and memory/SQLite/Redis stores.
- Experimental Agent Trust Gateway MVP with signed-agent identity binding,
  action policy, constraints, approval, replay protection, and audit events.
- Opt-in IntentOS, capabilities, federation, and trust experiments.

The Gateway, relay, and base protocol are distinct architecture layers. The
Gateway currently invokes only in-process handlers; its purchase action is a
simulation and does not perform settlement.

## Design principles

- Own the envelope, not the world.
- Keep protocol semantics separate from transport and settlement.
- Treat authentication, trust, and authorization as separate decisions.
- Keep delegated authority explicit, narrow, inspectable, and receiver-evaluated.
- Preserve evidence without claiming that signatures prove content truth.
- Prefer optional, versioned profiles over a rigid universal ontology.
- Keep experimental features opt-in and default-inert.
- Do not frame AIMTP as a replacement for MCP, A2A, HTTP, APIs, OAuth, PKI,
  email, payments, policy engines, or workflow systems.

## Claims and maturity

- Package version `1.0.0` is a compatibility line, not a blanket maturity claim.
- Describe the repository as a reference implementation or developer preview.
- Describe the Gateway as an MVP and federation/trust extensions as experimental.
- Do not claim customers, deployments, scale, certifications, compliance,
  production readiness, or security guarantees without independent evidence.

## Contributor guardrails

- The `aimtp/0.1` wire contract is frozen. Breaking changes require a new wire
  version plus coordinated spec, schema, and vector updates.
- Use a feature branch, keep changes reviewable, and preserve unrelated work.
- Run `npm test` before completion.
- Consult [`README.md`](README.md) and
  [`docs/architecture.md`](docs/architecture.md) for current positioning.
