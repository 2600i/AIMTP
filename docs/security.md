# Security

AIMTP is transport-agnostic and does not mandate a specific security model.
Implementations should provide confidentiality, integrity, and authentication
appropriate to their environment.

## Authorization boundary

Authentication and authorization are different decisions. A valid credential
or envelope signature can establish access or possession of configured key
material; it does not by itself prove that an agent may perform a particular
action for a principal under current constraints.

The experimental Agent Trust Gateway provides an external enforcement point for
requests routed through it. It binds a verified key to a configured agent and
principal, evaluates local trust and action policy, applies constraints, and may
require operator approval. This is defense in depth outside the model: an
unauthorized request can be denied before its protected handler runs.

The boundary is not comprehensive. It does not protect actions that bypass it,
prove that message content is true, or prevent every exploit, compromise,
prompt injection, credential theft, or model failure. AIMTP is not antivirus,
EDR, a vulnerability scanner, a sandbox replacement, or a model-alignment
system. See [`docs/trust-gateway.md`](trust-gateway.md) for the implemented MVP
and its limitations.

## Signatures (Chain-Agnostic)
AIMTP envelopes may include an optional `signature` object with:
- `alg`: algorithm identifier (for example `ed25519` or `secp256k1`)
- `kid`: key identifier
- `sig`: signature bytes (base64)
- `created_at`: optional RFC3339 signing timestamp
- `expires_at`: optional RFC3339 expiration timestamp

Backward-compatible aliases are supported:
- `key_id` alias for `kid`
- `signature` alias for `sig`

The protocol does not prescribe a blockchain or key format. Any cryptographic
verification or key ownership checks are handled by your runtime policy.

## Canonical Signing Payload
Signatures should be created over canonical envelope bytes:
- Remove top-level `signature` from the envelope.
- Serialize JSON with stable lexicographic key ordering at every object level.
- Preserve array ordering.
- Encode as UTF-8 with no extra whitespace.

## Key material in this repository

No private key is present at `HEAD`. Three throwaway demo keys remain reachable
in git history and are dispositioned in
[Keys that remain in git history](#keys-that-remain-in-git-history) below; the
statement here is about the current tree. The local federation demos need
Ed25519 keypairs so three throwaway relays can sign receipts to each other, and
those are minted on demand:

```sh
npm run federation:keys          # mint or reuse; writes ignored files only
npm run federation:keys -- --force   # rotate
```

The generator writes `runtime/federation-keys.json` and renders
`docker-compose.federation.local.yml` and
`docker-compose.federation-3hop.local.yml` from the committed
`*.template.yml` files. All four are ignored. The templates carry placeholders,
never keys.

### Keys that remain in git history

Earlier revisions of `docker-compose.federation.yml`,
`docker-compose.federation-3hop.yml` and `tools/federation-demo-3hop.mjs`
carried three hardcoded Ed25519 private keys, and those commits are still
reachable. They are inert:

- They were only ever demo material for the local federation topology, and were
  labelled as such where they appeared.
- They were trusted by nothing outside those demo files — no deployed relay, no
  release artifact, and no configuration in this repository referenced them.
- They no longer appear at the tip, and nothing reads them, so anything signed
  with them now verifies against nothing.

They have deliberately **not** been removed from history. Doing so would rewrite
every commit in the repository, which would invalidate 82 tags and the published
GitHub Releases that are pinned to specific commits. That cost is not
proportionate to demo keys that protect nothing. If a secret scanner reports
them, this section is the disposition.

## Historical diagrams

Earlier blockchain identity, anchoring, and revocation diagrams have been moved
to the [historical-artifact archive](history/README.md). They illustrate an
earlier direction and are not current security guidance or required AIMTP
architecture.
