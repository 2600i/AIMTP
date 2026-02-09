# AIMTP Capability Conformance Vectors (Phase 9)

This folder contains Phase 9 capability/delegation conformance vector stubs.

Each vector defines:

- `name`: stable vector name
- `capabilities`: capability presentation or chain input
- `request`: authorization request under evaluation
- `expected`: deterministic allow/deny result and reason code

Minimum classes covered:

- valid single grant authorizes request
- invalid signature
- expired capdoc
- delegation not allowed
- delegation depth exceeded
- scope mismatch
- audience mismatch
- chain discontinuity
