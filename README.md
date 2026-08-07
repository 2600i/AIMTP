# AIMTP by 2600i

**Agentic Intelligent Message Transfer Protocol**

**Wire version:** `aimtp/0.1` (frozen) · **Reference implementation:** `1.0.0` · **Maturity:** developer preview

AIMTP is an interoperable protocol for communicating **intent, identity,
authority, constraints, context, and evidence** between independent intelligent
actors: AI agents, humans, organizations, and software services.

> SMTP moves messages. AIMTP moves intent + identity + authority + constraints + evidence.

That is an analogy, not a claim that AIMTP replaces SMTP or combines every
system named below. AIMTP is designed to own the trust and authorization
envelope at a boundary between independent principals. It does not try to own
identity providers, policy engines, payments, contracts, marketplaces, or
workflow execution.

## Agent Trust Gateway: the concrete product

The [AIMTP Agent Trust Gateway](docs/trust-gateway.md) is the first concrete
product in this direction: an experimental authorization boundary for
autonomous agents.

```text
External Agent
      |
      | signed AIMTP request
      v
AIMTP Agent Trust Gateway
      |  identity + principal + trust + action
      |  delegated authority + policy + constraints
      |  approval + audit
      v
Protected System
```

Credentials answer, “Can this identity access the system?” The Gateway asks,
“Is this agent authorized to perform this specific action, right now, on behalf
of this principal?” Its decisions are `ALLOW`, `DENY`, and
`REQUIRE_APPROVAL`.

The checked-in MVP verifies signed envelopes, binds configured keys to agent
and principal identities, evaluates ordered action policies and numeric
constraints, pauses selected requests for operator approval, rejects stale or
replayed requests, and writes audit events. Its protected purchase handler is a
simulation. It does not execute a payment or proxy to an external protected
system, relay, or remote recipient.

Run the self-contained demo:

```sh
npm ci
npm run demo:trust-gateway
```

The Gateway is architecturally separate from both the AIMTP base protocol and
the reference relay. A future topology may place a Gateway in front of a relay
or remote service; that topology is not implemented here.

## Why AIMTP exists

When an intelligent actor crosses an organizational or system boundary, a
valid credential is only one part of the decision. The recipient also needs to
determine:

- Who is communicating, and who does that actor represent?
- What outcome is being requested?
- What authority was delegated, and what constraints apply?
- What can the receiving actor do?
- Should this interaction be permitted or require human approval?
- What signatures, receipts, approvals, provenance, or other evidence should be recorded?
- What real-world action happens after agreement?

AIMTP provides an envelope in which implementations can express and evaluate
those concerns. The final real-world action—such as a payment, reservation, API
call, database update, contract, or robot action—is **settlement**. AIMTP may
coordinate or authorize settlement without performing it.

The security principle is external enforcement: safety behavior inside a model
is not the only control. If sensitive actions are routed through an independent
authorization boundary, infrastructure can deny an action even when an agent
attempts it. This can reduce blast radius; it does not guarantee protection
against compromise, prompt injection, credential theft, vulnerabilities, or
model failure. AIMTP is not an EDR, antivirus product, scanner, sandbox, or
model-alignment system.

## Protocol concerns

These layers guide the architecture without imposing a universal ontology on
every implementation:

| Concern | Question | Current repository surface |
| --- | --- | --- |
| Identity | Who is communicating? | Envelope sender, signatures, configured identities, experimental identity anchors |
| Authority | What may the actor do? | Capability documents and Gateway policy; broader delegation is not part of the frozen base schema |
| Intent | What outcome is requested? | Extensible `intent`, `task`, and `actions` fields |
| Capability | What can the receiver do? | Offered/required capability hints and an experimental capability profile |
| Conversation | What state connects exchanges? | Application metadata and the optional IntentOS projection; no universal conversation model is frozen |
| Trust | Why should another domain believe the claim? | Canonical signatures plus opt-in federation/trust experiments |
| Evidence | What supports the decision and outcome? | Signatures, receipts, approval records, and audit events on different implementation surfaces |
| Settlement | What real-world action follows? | Outside the base protocol; the Gateway demo uses only simulated handlers |

Intent names such as `REQUEST`, `QUERY`, `DELEGATE`, `PROPOSE`, `ACCEPT`,
`REJECT`, `COMMIT`, `CANCEL`, and `VERIFY` are useful domain vocabulary, not a
required global enum. The frozen schema accepts implementation-defined intent
strings.

## How AIMTP relates to other systems

AIMTP complements existing protocols and infrastructure.

| System | Rough focus | Relationship to AIMTP |
| --- | --- | --- |
| MCP | What tools and context can a model use? | AIMTP can add cross-principal identity, authority, intent, and trust around an interaction. It does not replace MCP. |
| A2A | Agent discovery, communication, and task collaboration | AIMTP can complement or bridge A2A at an authorization/trust boundary. It does not replace A2A. |
| HTTP and APIs | Transport and service invocation | AIMTP envelopes can travel over HTTP or accompany an API call. |
| OAuth and PKI | Delegated access and cryptographic trust building blocks | AIMTP may use or reference them; it does not replace identity or key infrastructure. |
| Email, queues, and relays | Asynchronous delivery, retry, and acknowledgement | The reference relay implements this delivery profile, but delivery is only one AIMTP layer. |
| Payment and workflow systems | Execute real-world settlement | AIMTP can request or authorize execution while leaving settlement to those systems. |

## What exists today

| Status | Surface |
| --- | --- |
| **Implemented** | Frozen `aimtp/0.1` envelope/message/task schemas; TypeScript types and JavaScript SDK; canonical signing and conformance vectors; HTTP relay with at-least-once mailbox delivery; Agent Trust Gateway MVP and tests |
| **Experimental / opt-in** | Capability enforcement; IntentOS projection and receipts; federation handshake; identity anchors; revocations; trust bundles; transparency tooling; bridge proofs |
| **Planned direction** | Gateway integration with external protected systems or federated relays; broader principal/delegation models; additional SDKs and integrations |
| **Conceptual only here** | AIMTP Identity and an AIMTP Trust Network as possible future product-family components |

The `1.0.0` package version identifies a compatibility line for this reference
implementation. It is not a claim that every surface is production-ready,
hardened, scalable, or compliant. See the [freeze and stability
contract](docs/aimtp-1.0-freeze.md).

## Explore the protocol and relay

Prerequisites: Node.js 20+ and npm.

```sh
npm ci
npm run build
npm test
npm run conformance
```

Run the reference relay locally:

```sh
AIMTP_API_KEY=dev-key AIMTP_BIND_HOST=127.0.0.1 node dist/runtime/relay.js
```

Send a validated envelope:

```sh
curl -X POST "http://127.0.0.1:8787/aimtp" \
  -H "Content-Type: application/json" \
  -H "X-AIMTP-KEY: dev-key" \
  -d '{"spec":"aimtp/0.1","id":"env-1","timestamp":"2026-08-07T12:00:00Z","sender":"agent-a","recipient":"agent-b","intent":"task.request","message":{"id":"msg-1","role":"user","content":"ping"}}'
```

The relay validates and queues the envelope; recipients use the poll, lease,
acknowledge, fail, and dead-letter endpoints documented in the [runtime
reference](docs/runtime.md). This queue is an implemented transport profile, not
the definition of AIMTP itself.

Useful local demos:

```sh
npm run demo:trust-gateway       # signed request -> policy -> approval/audit
node examples/reference-agents/demo.js
node examples/webhook-relay/demo.js
```

## Repository map

| Path | Purpose |
| --- | --- |
| `spec/` | Normative base specification and experimental protocol profiles/schemas |
| `schemas/` | Normative JSON Schemas for the frozen AIMTP envelope and message |
| `src/` | TypeScript protocol types and reference runtime components |
| `sdk/` | JavaScript SDK implementation |
| `runtime/` | JavaScript runtime modules and experimental reference-relay schemas; generated local state is excluded from packages |
| `tests/conformance/` | Cross-implementation canonicalization and signing vectors |
| `tests/vectors/` | Base schema vectors |
| `tests/runtime-vectors/` | ELv2 reference-runtime profile vectors |
| `examples/` | Local relay, client, browser, and reference-agent demos |
| `docs/` | Architecture, implementation, operations, security, and historical phase notes |

Start with:

- [Documentation index](docs/README.md)
- [Current overview](docs/overview.md)
- [Canonical glossary](docs/GLOSSARY.md)
- [Architecture](docs/architecture.md)
- [AIMTP `aimtp/0.1` specification](spec/aimtp-v0.1.md)
- [Agent Trust Gateway MVP](docs/trust-gateway.md)
- [Implementation guide](docs/implementing-aimtp.md)
- [Runtime and relay reference](docs/runtime.md)
- [Security boundaries](docs/security.md)
- [Conformance kit](tests/conformance/README.md)
- [Documentation status map](docs/DOCUMENTATION_MAP.md)

## Brand and repositories

AIMTP is developed as **AIMTP by 2600i**. This repository is the protocol,
schemas, conformance material, SDK/reference runtime, Gateway MVP, and backend
implementation repository.

The separate `2600i-aimtp-web` repository is the website/frontend presence, and
`aimtp.2600i.com` is the canonical web identity.

`aimtp.net` is a **protocol namespace, not a vanity domain.** It is the `$id`
origin for the JSON Schemas in this repository — `https://aimtp.net/schemas/…`,
`https://aimtp.net/spec/…`, `https://aimtp.net/runtime/schemas/…` — with
absolute `$ref`s resolving between them. Redirecting the domain wholesale to the
marketing site would turn every schema identifier into a redirect. Known gap:
those identifiers do not currently resolve to anything. Serving the schemas at
their own `$id`s, while redirecting only the marketing paths, is the intended
fix and is not yet wired up.

Future names such as AIMTP Identity or AIMTP Trust Network describe product
direction only unless a repository explicitly implements them.

## Historical direction

Early AIMTP and IntentOS concepts emphasized email/Gmail workflows. Those ideas
remain useful examples of human-directed agent delegation and asynchronous
delivery, and mailbox/inbox names remain in implemented runtime surfaces. They
are no longer the primary definition of AIMTP: email is a possible client or
use case of the broader trust and authorization envelope.

## Contributing and license

Keep changes focused, update specifications and schemas together when wire
behavior changes, add tests or vectors where applicable, and run `npm test`.

AIMTP uses a split licensing model:

- Designated protocol specifications, interoperable schemas, conformance
  vectors, and general protocol documentation are available under CC BY 4.0.
  This supports AIMTP's open-protocol direction.
- The SDK, Agent Trust Gateway, relay, backend/server code, examples, and other
  implementation material are source available under the Elastic License 2.0
  (ELv2). ELv2-licensed software is not open source.
- Brand and trademark rights are separate from both licenses.

The exact path-by-path scope is defined in [LICENSING.md](LICENSING.md); see
[LICENSE](LICENSE) for the summary and [TRADEMARKS.md](TRADEMARKS.md) for the
interim brand policy. This structure is subject to final legal review.
