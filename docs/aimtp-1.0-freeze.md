# AIMTP 1.0 Freeze and Stability Contract

**Status:** stable
**Wire version:** `aimtp/0.1` (frozen)
**Implementation version:** `1.0.0`

## The two version numbers, and why they differ

AIMTP has two independently versioned things, and conflating them is the most
common way to misread this project:

| | Value | Meaning |
|---|---|---|
| **Wire version** | `aimtp/0.1` | The value of the envelope `spec` field. This is the interoperability contract. |
| **Implementation version** | `1.0.0` | The version of this repository: reference relay, SDK, tooling, docs. |

The wire version stays at `aimtp/0.1`. It has been frozen since the v0.1.0
release, every deployed implementation emits and expects that exact string, and
the schemas pin it with `"const": "aimtp/0.1"`. Bumping it to `aimtp/1.0` would
be a breaking protocol change requiring new schemas and coordinated upgrades
across every peer, in exchange for nothing but a nicer-looking number. We are
not doing that.

`1.0.0` is a statement about the *implementation*: the reference runtime, its
error codes, and its operational surface are now stable and covered by the
compatibility promise below. Reaching 1.0 does not change a single byte on the
wire.

## What is frozen

Changing any of these requires a new wire version (`aimtp/0.2` or later), not a
minor or patch release.

### Envelope and message model
- Required envelope fields: `spec`, `id`, `timestamp`, `message`.
- Required message fields: `id`, `role`, `content`.
- `role` enum: `system`, `user`, `assistant`, `tool`.
- Optional envelope fields and their shapes: `sender`, `recipient`, `intent`,
  `actions`, `capabilities`, `negotiation`, `task`, `signature`, `metadata`.
- Attachment shape: `name`, `content_type`, `size` required; `sha256`, `url`
  optional.
- Unknown fields MUST be ignored unless an implementation profile requires them.

### Canonical signing payload
The rules in [`spec/aimtp-v0.1.md`](../spec/aimtp-v0.1.md#canonical-signing-payload):
strip the top-level `signature`, sort object keys lexicographically at every
level, preserve array order, emit no insignificant whitespace, encode UTF-8.

This is the most load-bearing frozen surface in the protocol. It is pinned
byte-for-byte by the vectors in
[`tests/conformance/vectors/canonicalization/`](../tests/conformance/vectors/canonicalization/)
and verified by `npm run conformance`. An implementation that disagrees here
will reject valid signatures from every peer, and the symptom looks like a key
problem rather than an encoding problem.

### Task semantics
- `status` enum: `running`, `succeeded`, `failed`.
- `succeeded` MUST NOT carry `error`; `failed` MUST carry `error` and MUST NOT
  carry `output`.
- A Task Response `in_response_to` MUST reference the originating request `id`.

### Schema namespace
All schema `$id`s are rooted at `https://aimtp.net`. This is asserted by the
`integrity` suite of the conformance kit, because a split namespace makes
`$ref` resolution ambiguous for outside implementers.

## What is stable but may extend

These follow semantic versioning on the implementation version. Additive
changes land in minor releases; behavioral changes that could break an operator
land only in a major.

- **Relay HTTP surface:** `POST /aimtp`, `POST /aimtp/mailbox`,
  `GET /aimtp/peek`, `GET /aimtp/poll`, `POST /aimtp/ack`, `POST /aimtp/fail`,
  `GET /aimtp/dead`, `GET /healthz`.
- **Error codes:** existing codes keep their meaning and HTTP status. New codes
  may be added. Covered by `tests/error-code-stability.test.mjs`.
- **Environment variables:** existing names keep their meaning. See
  [`docs/runtime.md`](runtime.md).
- **Delivery profile:** at-least-once with leasing, ack/fail, retry counting,
  and dead-lettering.

## What is explicitly not frozen

The federation trust surface (`v2`/`v3` trust semantics, handshake, identity
anchors, trust bundles, revocations, transparency log, bridge proofs) remains
**opt-in and default-inert**. These are additive and may change shape in minor
releases. `v1` trust semantics are the frozen baseline; anything gated behind
`INTENTOS_TRUST_VERSION=v2` or later is explicitly evolving.

Enabling any of it requires deliberate configuration. A default relay has all
of it switched off, which is asserted by
`tests/0.4-defaults-inert.test.mjs`.

## Claiming conformance

An implementation may claim AIMTP `aimtp/0.1` conformance when it:

1. Emits envelopes that validate against `schemas/envelope.schema.json`.
2. Rejects envelopes that fail validation.
3. Ignores unknown fields.
4. Produces canonical signing bytes identical to every vector in
   `tests/conformance/vectors/canonicalization/`.
5. Accepts and rejects each vector in `tests/conformance/vectors/signing/` as
   that vector specifies.

Verify with:

```sh
npm run conformance
```

The kit is transport-agnostic and has no Node dependency in its vector data, so
non-Node implementations can consume the JSON fixtures directly. See
[`tests/conformance/README.md`](../tests/conformance/README.md).

## Deprecation policy

Nothing in the frozen set is removed without a wire version bump. Anything in
the stable set is deprecated for at least one minor release, with a documented
replacement, before removal in a major. Opt-in trust features may change in a
minor release; they are labeled experimental for exactly this reason.
