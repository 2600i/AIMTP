# Identity Conformance Vectors

Phase 8 identity vectors for canonicalization and proof verification.

## Placeholder vectors

- `identity-valid.json`: expected successful identity + proof verification.
- `identity-expired.json`: expected failure due to expired identity document.

Implementations SHOULD compare actual verifier output against each vector `expected` block.
