# AIMTP v0.4 Capabilities

> **Status: NEEDS_UPDATE / Draft experimental profile.** The implemented
> capability field names and verification behavior remain technically
> meaningful, but this document is not part of the frozen `aimtp/0.1` base
> protocol and needs a consolidated versioned profile before broader use.

This document captures operational guidance for capability minting and use with
IntentOS enforcement mode.

## Minting & Operational Use

### Audience (`aud`) Matching

- `aud` MUST be an exact string match with the relay base URL used by clients.
- Include the relay base path when present.
- Example valid value for local relay: `http://localhost:8787/aimtp`.
- A capability minted for `http://localhost:8787` MUST NOT be accepted for
  `http://localhost:8787/aimtp`.

### Scope Matching

- Scopes are exact `(action, resource)` tuples.
- Wildcards are NOT allowed in either `action` or `resource`.
- Least privilege is required: mint only the exact actions/resources needed.

### TTL and Lifetime Guidance

- Use short-lived capabilities by default.
- Recommended development TTL: 15 to 60 minutes (`900` to `3600` seconds).
- Delegated capabilities SHOULD NOT outlive their parent capability.
- Rotate and re-mint rather than issuing long-lived broad scopes.

### Delegation Guidance

- Root and delegated capabilities are represented as a chain.
- Each delegated document MUST:
  - keep the same `aud` as its parent
  - be issued by the parent `subject`
  - carry a subset of parent scopes
- Verification validates chain structure, exact audience, and expiry.

### Operational Notes

- CLI minting is local/offline.
- Relay-side verification and enforcement happens at request time.
- The minting CLI can emit a header helper line (`--as-header`) and JSON output
  for embedding into request envelopes or transport headers.
