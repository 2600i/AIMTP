# Interoperability

AIMTP interoperability begins with a shared envelope, canonical signing bytes,
and predictable extension behavior. It is intended for interactions across
independent principals and implementation boundaries, not only for agents
inside one application.

## Adjacent protocols

These are divisions of responsibility, not competitive claims:

- **MCP roughly asks:** What tools and context can this model use?
- **AIMTP asks:** Who does this actor represent, what outcome is requested,
  what authority and constraints apply, and should the receiver trust and
  permit the interaction?
- **A2A focuses on:** agent discovery, communication, and task collaboration.
  AIMTP can complement or bridge that exchange with a trust/authorization
  envelope; it is not an A2A replacement.
- **HTTP and APIs provide:** transport and invocation. They can carry AIMTP or
  perform settlement after an AIMTP decision.
- **OAuth and PKI provide:** delegated-access and cryptographic building blocks.
  AIMTP may use or reference them rather than defining a replacement.

The reference HTTP relay is one transport profile. Conformance to the base
protocol does not require that relay or its mailbox endpoints.

## Boundary patterns

```mermaid
flowchart LR
  M[MCP or local tool/context environment] -. local integration .-> A
  A[Actor A<br/>domain A] --> E[AIMTP envelope<br/>identity + intent + authority claims<br/>constraints + context + evidence]
  E --> T[HTTP/API, A2A exchange,<br/>relay, or other transport]
  T --> B[Actor B<br/>domain B]
  T -. optional protected-action path .-> G[AIMTP Agent Trust Gateway]
  G --> P[Protected system]
```

MCP generally remains inside an actor's local model/tool environment. HTTP,
APIs, A2A exchanges, messaging infrastructure, or the reference relay can carry
or accompany an AIMTP envelope. A receiving actor or optional Gateway then
makes its own trust and authorization decision. The Gateway is not required for
base protocol conformance.

The repository's federation handshake and trust artifacts are experimental
profiles for interactions across independently operated relay domains. They do
not establish a deployed AIMTP network or make federation part of the base
interoperability contract.

## Interoperability contract

An `aimtp/0.1` implementation should:

1. Validate envelopes and messages against the normative schemas.
2. Preserve extension fields it does not interpret.
3. Produce canonical signing bytes identical to the committed vectors.
4. Separate schema validity, signature verification, trust, and authorization
   rather than treating them as one decision.
5. Make transport-specific delivery and settlement behavior explicit.

Run `npm run conformance` and see
[`tests/conformance/README.md`](../tests/conformance/README.md).

## Historical diagrams

Earlier interoperability diagrams have been moved to the
[historical-artifact archive](history/README.md). They are retained for project
history but are not part of the current interoperability guidance or normative
architecture.
