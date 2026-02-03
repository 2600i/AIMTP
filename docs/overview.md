# Overview

AIMTP defines a minimal JSON envelope for transporting AI messages between systems. The protocol separates transport from message semantics so different environments can interoperate without custom adapters.

## Getting Started

- **Protocol specification:** `spec/aimtp-v0.1.md` (normative)
- **Implementer guide:** `docs/implementing-aimtp.md` (1-page, non-normative)
- **Schemas:** `schemas/` (normative validation)
- **Reference implementation:** `src/` (TypeScript, in-memory)

## Core Diagrams

Architecture  
![Minimalist AIMTP Architecture Diagram](whitepaper-images/minimalist-aimtp-architecture-diagram.png)

Protocol  
![AIMTP Protocol Diagram](whitepaper-images/aimtp-protocol-diagram.png)

Message Envelope  
![AIMTP Message Envelope Diagram](whitepaper-images/aimtp-message-envelope-diagram.png)

Routing  
![Minimalist AIMTP Routing Diagram](whitepaper-images/minimalist-aimtp-routing-diagram.png)

Transport Layer  
![AIMTP Transport Layer Diagram](whitepaper-images/aimtp-transport-layer-diagram.png)

Technical Sheet  
![Minimalist AIMTP Technical Diagrams Sheet](whitepaper-images/minimalist-aimtp-technical-diagrams-sheet.png)
