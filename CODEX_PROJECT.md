# AIMTP Project Context

- Product identity: **AIMTP by 2600i**.
- Core: interoperable trust/authorization envelope for intent, identity,
  authority, constraints, context, and evidence between independent actors.
- Concrete product: experimental AIMTP Agent Trust Gateway MVP.
- Base wire contract: `aimtp/0.1`, frozen and covered by conformance vectors.
- Reference surfaces: schemas, SDK, HTTP relay/mailbox profile, Gateway, tools,
  examples, and tests.
- Experimental/default-inert surfaces: capabilities, IntentOS, federation,
  identity anchors, revocations, trust bundles, transparency, and bridge proofs.
- Separate website/frontend repository: `2600i-aimtp-web`.
- Web identity: `aimtp.2600i.com`; vanity/schema namespace: `aimtp.net`.
- Maturity: developer preview. Do not infer production readiness from package
  version `1.0.0`.
- Hosted relay availability is not asserted by this file; prefer local examples
  unless a deployment is independently verified.

## Git and release rules

- Work on feature branches; do not edit directly on `main`.
- Keep changes small and update spec + schema together when wire behavior changes.
- Add tests or conformance vectors when applicable.
- Run `npm test` before marking work complete.
- Do not push, tag, publish, or create a release unless explicitly requested.
