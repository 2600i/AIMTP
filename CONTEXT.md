# AIMTP – Working Context

## What AIMTP Is
AIMTP (Agentic Intelligent Message Transfer Protocol) is a protocol and reference implementation
for structured, agent-to-agent message and task exchange.

It is:
- Spec-first
- Transport-agnostic
- Implementation-neutral
- Designed for interoperability between AI agents and systems

It is NOT:
- A UI
- A hosted platform
- A blockchain requirement
- An application framework

---

## Current Goals (v0.1)
1. Define a stable AIMTP message + envelope specification
2. Provide JSON Schemas for validation
3. Provide a minimal Node/TypeScript reference implementation
4. Provide examples and conformance test vectors

---

## Design Principles
- Clarity over cleverness
- Explicit versioning
- Forward compatibility
- Minimal mandatory fields
- Optional extensibility via metadata and policy blocks

---

## Current Architectural Notes
- `AIMTPMessage` represents semantic content
- `AIMTPEnvelope` represents transport, routing, and policy
- Envelope is generic over payload type
- Attachments are first-class
- Security and policy are optional but structured

---

## Known Design Decisions
- Envelope versioning is explicit (aimtp/0.1)
- Content is typed via content_type
- Protocol avoids LLM-specific assumptions
- Reference implementation is intentionally minimal

---

## Immediate Next Tasks
- Review and finalize `task.ts`
- Align JSON schemas with TypeScript interfaces
- Lock versioning and timestamp rules in spec
- Tighten role semantics (avoid LLM coupling)

---

## Guardrails for Contributors (Including Codex)
- Do not add networking, blockchain, or auth without discussion
- Do not introduce UI
- Do not over-engineer abstractions
- Ask before making breaking changes
