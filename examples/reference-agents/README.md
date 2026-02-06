# Reference Agents Demo (Phase 5)

This demo provides optional AI behavior on top of AIMTP data model fields
(`intent`, `actions`, `capabilities`, `negotiation`) without protocol changes.

Included reference components:
- `ReferenceRouterAgent`: deterministic routing and negotiation counter-offers.
- `ReferenceExecutorAgent`: action execution through a provider-agnostic adapter.
- `LocalStubLLMAdapter`: local/no-network implementation for deterministic tests.

## Run
- `node examples/reference-agents/demo.js`

## Flow
1. Enqueue request to `agent-router`.
2. Router polls and emits negotiation when capability mismatch.
3. Client accepts counter-offer and re-enqueues request.
4. Router routes to `agent-executor-1`.
5. Executor runs action(s), emits response, acknowledges lease.
6. Client polls response and acknowledges lease.

## Constraints
- No external providers or API keys required.
- No blockchain/provider coupling.
- No protocol schema/spec changes required for runtime behavior.
