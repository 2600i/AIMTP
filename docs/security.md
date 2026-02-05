# Security

AIMTP is transport-agnostic and does not mandate a specific security model.
Implementations should provide confidentiality, integrity, and authentication
appropriate to their environment.

## Signatures (Chain-Agnostic)
AIMTP envelopes may include an optional `signature` object with:
- `key_id`: identifier for the signing key
- `signature`: signature bytes (encoding defined by your implementation)
- `alg`: optional algorithm identifier

The protocol does not prescribe a blockchain or key format. If you choose to
use blockchain keys, AIMTP remains compatible because the signature fields are
intentionally generic. Any cryptographic verification or key ownership checks
are handled by your runtime or gateway.

## Diagrams (Conceptual)
These diagrams are conceptual and optional. They illustrate one possible
identity and anchoring approach but are not required by the protocol.

Identity
![Blockchain Identity Diagram](whitepaper-images/blockchain-identity-diagram.png)

Anchoring
![AIMTP Blockchain Anchoring Diagram](whitepaper-images/aimtp-blockchain-anchoring-diagram.png)

Revocation and Trust
![Revocation and Trust Model Diagram](whitepaper-images/revocation-and-trust-model-diagram.png)
