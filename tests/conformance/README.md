# AIMTP Conformance Kit

This is the portable contract for the frozen `aimtp/0.1` wire protocol. If your
implementation passes this kit, it interoperates with every other implementation
that does.

```sh
npm run conformance             # human-readable report
npm run conformance -- --json   # machine-readable, for CI
```

Exit code is `0` when every check passes, `1` otherwise.

## What it checks

| Suite | What must hold |
|---|---|
| `schema` | Envelope vectors validate (or fail) as specified, and every valid vector declares `spec: "aimtp/0.1"` |
| `canonical` | The canonical signing payload is **byte-identical** to the committed vectors |
| `signing` | Signature verification accepts and rejects exactly as specified, with stable error codes |
| `integrity` | All schema `$id`s share one origin, absolute `$ref`s resolve, and the embedded bridge-proof schema matches the shipped file |

Run one suite at a time with `--only`:

```sh
node tests/conformance/run.mjs --only canonical,signing
```

## Why canonicalization vectors matter most

AIMTP signatures are computed over a canonical serialization of the envelope,
not over the bytes as received. Two implementations that disagree about that
serialization by even one byte will reject each other's valid signatures, and
the failure looks like a key problem rather than an encoding problem. That class
of bug is expensive to find in production and trivial to catch here.

Each vector in `vectors/canonicalization/` pins:

- `envelope` — the input
- `canonical` — the exact expected canonical string
- `canonical_sha256` — SHA-256 of the canonical UTF-8 bytes
- `canonical_byte_length` — length in bytes

The rules being pinned (from
[`spec/aimtp-v0.1.md`](../../spec/aimtp-v0.1.md#canonical-signing-payload)):

1. Remove the top-level `signature` field.
2. Sort object keys lexicographically **at every level**.
3. Preserve array order.
4. Emit no insignificant whitespace.
5. Encode as UTF-8.

Three vectors deliberately collapse to identical canonical bytes
(`minimal-envelope`, `key-order-independence`, `signature-field-excluded`). The
runner asserts that invariant separately: it is the single easiest thing to get
wrong when an implementation re-serializes with its language's default JSON
encoder.

## Testing a non-Node implementation

The vectors are plain JSON with no Node dependency, so use them directly as
fixtures in your own test suite.

**Canonicalization** — for each file in `vectors/canonicalization/`, canonicalize
`envelope` and assert your output equals `canonical` byte-for-byte (or that its
SHA-256 equals `canonical_sha256`).

**Signing** — for each file in `vectors/signing/`, load `trusted_keys` into your
trust store and verify `envelope`:

- `expect: "verify"` — verification must succeed.
- `expect: "reject"` — verification must fail, with error code `expect_code` if
  your implementation exposes stable codes.
- `verify_at`, when present, is the RFC3339 instant to evaluate validity windows
  at. Without it, the expiry vectors are not reproducible.

The ed25519 keypair is derived from the fixed 32-byte seed in
`ed25519_seed_hex`, so you can reconstruct the private key and re-sign to test
your signer as well as your verifier. **These are test keys. Never use them for
anything real.**

**Schema** — point the runner at your own schema copies:

```sh
node tests/conformance/run.mjs --schemas ./my/schemas --vectors ./my/vectors
```

## Optional: cross-language schema check

`validate_schemas.py` validates the same envelope vectors through a Python
JSON Schema implementation. It is not part of `npm test` because it needs
`pip install jsonschema`, but it is worth running when you touch the schemas:
it catches rules that only hold because of an Ajv quirk.

```sh
pip install jsonschema
python3 tests/conformance/validate_schemas.py
```

## Regenerating vectors

```sh
node tests/conformance/generate-vectors.mjs
```

Do this **only** when deliberately changing the normative canonicalization or
signing rules in the spec. These vectors are the frozen cross-implementation
contract; regenerating them to make a failing build go green silently breaks
interoperability with every deployed implementation. If a vector fails, the
default assumption is that the code regressed, not that the vector is wrong.
