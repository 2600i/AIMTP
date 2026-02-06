# AIMTP v0.1

## Status
- Draft specification
- Version string: `aimtp/0.1`

## Goals
- Simple JSON envelope for AI message transfer.
- Clear validation via JSON Schema.
- Forward compatibility through permissive extension fields.

## Conformance
- Producers MUST emit JSON objects that validate against the AIMTP schemas.
- Consumers MUST validate and reject invalid envelopes.
- Consumers MUST ignore unknown fields unless an implementation profile requires them.

## Versioning
- The envelope `spec` field identifies the protocol version.
- v0.1 uses the exact string `aimtp/0.1`.
- Minor revisions (e.g., `0.1.x`) may clarify text without changing schema semantics.
- Breaking changes require a new `spec` version (e.g., `aimtp/0.2`).

## Envelope
The envelope wraps a single message and optional routing/security metadata.

### Required Fields
- `spec`: Protocol version string. Must be `aimtp/0.1`.
- `id`: Unique identifier for this envelope. Recommended UUID v4.
- `timestamp`: RFC 3339 UTC timestamp.
- `message`: The message payload (see Message).

### Optional Fields
- `sender`: String identifier for the sender.
- `recipient`: String identifier for the recipient.
- `intent`: High-level intent for routing or interpretation (e.g., `task.request`, `task.response`).
- `task`: Optional task request/response object (see Task).
- `signature`: Object containing signature metadata (see Security).
- `metadata`: Free-form object for extensions.

## Message
The message represents a single AI message.

### Required Fields
- `id`: Unique identifier for this message. Recommended UUID v4.
- `role`: One of `system`, `user`, `assistant`, `tool`.
- `content`: UTF-8 text content.

### Optional Fields
- `content_type`: MIME type for content. Default `text/plain`.
- `attachments`: Array of attachment descriptors.
- `metadata`: Free-form object for extensions.

## Task
Tasks encode request/response intent and status. They are optional and carried on the envelope.

### Task Request
- `kind`: Must be `request`.
- `id`: Unique task identifier.
- `type`: Optional task type identifier (implementation-defined).
- `input`: Optional JSON object containing task inputs.
- `expects_response`: Optional boolean hint. If `true`, the sender expects a response; receivers MAY acknowledge with a `running` response before a final status.
- `metadata`: Optional extensions.

### Task Response
- `kind`: Must be `response`.
- `id`: Unique identifier for this Task Response (distinct from the request `id`).
- `in_response_to`: MUST reference the originating Task Request `id`.
- `status`: One of `running`, `succeeded`, `failed`.
- `output`: Optional JSON object containing results. MUST be absent if `status` is `failed`.
- `error`: Optional structured error (see Error Model). MUST be present if `status` is `failed` and MUST be absent if `status` is `succeeded`.
- `metadata`: Optional extensions.

### Response Expectations
- `expects_response` is a best-effort hint indicating the sender would like a response.
- Receivers SHOULD honor `expects_response=true` when feasible, but MAY omit a response in constrained or fire-and-forget contexts.

### Task Semantics
- `intent` is an envelope-level hint for routing/interpretation (e.g., `task.request`), while `task.type` is a task-specific semantic identifier (e.g., `summarize.v1`). They are related but not interchangeable.
- `input` and `output` MUST be JSON objects when present.
- `running` responses MAY be used as acknowledgements for long-running tasks. A later response referencing the same request MAY deliver a terminal status.
- If `status` is `succeeded`, `error` MUST be absent.
- If `status` is `failed`, `error` MUST be present and `output` MUST be absent.
- If `status` is `running`, `output` and `error` SHOULD be absent.


## Attachments
An attachment is a metadata reference to binary content.

### Required Fields
- `name`: File name or logical label.
- `content_type`: MIME type.
- `size`: Size in bytes (integer, >= 0).

### Optional Fields
- `sha256`: Lowercase hex SHA-256 hash of the content.
- `url`: URL to fetch the attachment.

## Error Model
- Invalid envelopes MUST be rejected.
- Implementations SHOULD return a structured error object with:
  - `code`: Stable machine-readable code (e.g., `invalid_schema`).
  - `message`: Human-readable description.
  - `details`: Optional object with field-level errors.
- Transports without structured errors SHOULD surface an equivalent failure.

## Security
- The signature model is chain-agnostic and does not reference any blockchain.
- If `signature` is present, implementations SHOULD use this signature block:
  - `alg`: Signature algorithm identifier (e.g., `ed25519`, `secp256k1`).
  - `kid`: Signing key identifier.
  - `sig`: Signature bytes encoded as base64.
  - `created_at`: Optional RFC3339 signing timestamp.
  - `expires_at`: Optional RFC3339 expiration timestamp.
- Backward compatibility aliases are allowed:
  - `key_id` as alias for `kid`
  - `signature` as alias for `sig`
- Implementations SHOULD validate signatures when a trust policy exists.

### Canonical Signing Payload
- The signing payload is the full envelope JSON object with the top-level
  `signature` field removed.
- Serialization MUST be deterministic:
  - UTF-8 encoding
  - JSON object keys sorted lexicographically at every level
  - Arrays preserved in existing order
  - No insignificant whitespace
- Signature verification MUST run against these canonical bytes.

## Runtime Delivery Profile (Non-normative)
The AIMTP relay runtime provides **at-least-once** delivery when mailbox polling
is used. Envelopes are leased to the recipient on poll and MUST be explicitly
acknowledged to be removed from the queue.

Recommended behavior for runtimes:
- Lease a message on poll and return a `lease_id` plus `lease_expires_at`.
- If the lease expires without acknowledgement, requeue the message with backoff.
- Track a retry counter per message. After `max_retries`, move the message to a
  dead-letter queue for investigation.

Implementations MAY expose mailbox-specific HTTP endpoints to support leasing,
acknowledgement, failure, retries, and dead-letter inspection. These endpoints
are outside the core AIMTP envelope schema and may vary by deployment.

## Runtime Trust Policy (Non-normative)
Reference runtime policy modes:
- `off`: signature verification disabled.
- `warn`: verification runs; failures are logged but envelopes are accepted.
- `enforce`: verification failures reject the envelope.

Reference runtime environment variables:
- `AIMTP_SIGNATURE_POLICY=off|warn|enforce`
- `AIMTP_TRUSTED_KEYS` (comma-separated `kid=public_key` entries)
- `AIMTP_TRUSTED_KEYS_FILE` (optional key map file path)
- `AIMTP_SIGNATURE_CLOCK_SKEW_SEC` (optional non-negative integer)

## Examples

### Minimal Envelope
```json
{
  "spec": "aimtp/0.1",
  "id": "0b74b6f3-2a2f-4a58-9d0f-2c0d82b8d4f2",
  "timestamp": "2025-01-01T00:00:00Z",
  "message": {
    "id": "7f5e2d1c-1f48-4f87-9d2c-2e784684f2b3",
    "role": "user",
    "content": "Hello from AIMTP"
  }
}
```

### Envelope With Attachment
```json
{
  "spec": "aimtp/0.1",
  "id": "4d3b9e11-7b74-4c08-8a8c-8a1f8f59a7f1",
  "timestamp": "2025-01-01T00:00:00Z",
  "sender": "client-123",
  "recipient": "agent-456",
  "message": {
    "id": "c07f4d2b-0f5b-4f2e-8a3c-3a2a7b0c9e2d",
    "role": "assistant",
    "content": "See the attached file.",
    "content_type": "text/plain",
    "attachments": [
      {
        "name": "report.pdf",
        "content_type": "application/pdf",
        "size": 102400,
        "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        "url": "https://example.com/report.pdf"
      }
    ],
    "metadata": {
      "topic": "finance"
    }
  },
  "metadata": {
    "trace_id": "trace-abc-123"
  }
}
```

## Compatibility
- Unknown fields MUST be ignored unless explicitly required by an implementation profile.
