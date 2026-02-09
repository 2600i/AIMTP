# IntentOS Conformance Vectors (v0.1)

This folder defines initial IntentOS vectors for submission, task chaining, and authorization failures.

Files:

- `intent-valid.json`: Valid `intent.submit` authorization request and payload.
- `task-chain-valid.json`: Valid deterministic task chain (`task.create` -> `task.claim` -> `task.result`).
- `task-claim-unauthorized.json`: Unauthorized `task.claim` example (scope mismatch).
- `task-result-unauthorized.json`: Unauthorized `task.result` example (missing/invalid capability).

Notes:

- These vectors are placeholders for cross-runtime conformance expansion.
- Capability signatures are illustrative in these vectors and may use stub values in early implementations.
