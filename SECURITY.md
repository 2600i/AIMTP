# Security policy

AIMTP is a developer preview. The Agent Trust Gateway is an experimental
authorization boundary, not a hardened production control. Reports are welcome
on that understanding.

## Reporting a vulnerability

**Do not open a public issue for a security report.**

Preferred: use GitHub's private vulnerability reporting on this repository
(**Security → Report a vulnerability**). It keeps the report, the discussion,
and the fix in one place until disclosure.

Alternative: email `steve@2600i.com` with `AIMTP SECURITY` in the subject.

Please include the affected file or endpoint, the version or commit, what an
attacker gains, and a reproduction — a signed envelope, a `curl` invocation, or
a failing test is ideal.

You will get an acknowledgement within **5 business days**. Because this is a
preview maintained by a small team, please allow **90 days** before public
disclosure, and tell us if you intend to publish sooner so we can prioritise.

## Scope

In scope:

- `src/`, `runtime/`, `sdk/`, `cli/` — the reference implementation
- The Agent Trust Gateway: identity binding, policy evaluation, constraints,
  approval lifecycle, replay protection, operator authentication, audit
- The reference relay: authentication, allowlists, mailbox lease/ack/retry,
  dead-lettering, CORS
- Canonical signing and signature verification, including any input that causes
  two conforming implementations to disagree on the canonical payload bytes
- Schema validation bypasses, and conformance vectors that pass when they should
  fail

Out of scope:

- The `examples/` demos and `tools/` demo scripts, which use fixed demo keys
- Findings that require an attacker to already hold the operator token, the
  relay API key, or a trusted signing key
- Denial of service from unbounded local resource use in a demo
- Dependency advisories with no demonstrated path to exploitation here — send
  those as a normal issue or pull request

## Known and accepted — please do not report these

Each of the following is deliberate and documented. A report about one is not a
finding.

- **Ed25519 private keys are reachable in this repository's git history.** They
  were demo material for the local federation topology, were trusted by nothing
  outside those demo files, appear nowhere at the tip, and now verify against
  nothing. See [`docs/security.md`](docs/security.md#keys-that-remain-in-git-history)
  for the full disposition and why history was not rewritten.
- **The Gateway's protected purchase handler is a simulation.** It performs no
  payment and proxies to no external system. See
  [`docs/trust-gateway.md`](docs/trust-gateway.md).
- **The relay denies every request when no `AIMTP_API_KEY` is configured.** That
  is fail-closed behaviour, not a misconfiguration.
- **The federation, capability, IntentOS, and trust-bundle surfaces are inert by
  default** and only activate under explicit opt-in environment variables.
- **`/healthz` is unauthenticated.** It reports that the process is serving and
  nothing about approvals, policy, or audit.

## Supported versions

| Surface | Version | Status |
| --- | --- | --- |
| Wire protocol | `aimtp/0.1` | Frozen — see [`docs/aimtp-1.0-freeze.md`](docs/aimtp-1.0-freeze.md) |
| Reference implementation | `1.0.0` | Supported; fixes land on `main` |
| Earlier `0.x` implementations | — | Not supported |

The `1.0.0` implementation version marks a compatibility line, not a claim that
every surface is production-ready, hardened, scalable, or compliant.

## Deploying this safely

If you run any of this outside a laptop, read
[`docs/security.md`](docs/security.md) and
[`docs/trust-gateway.md`](docs/trust-gateway.md) first. In particular: set
`AIMTP_BIND_HOST`, set an API key, keep the Gateway's operator routes off any
public interface, and put TLS in front of everything.
