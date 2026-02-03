# AIMTP v0.1

## Status
- Draft specification
- Version string: `aimtp/0.1`

## Goals
- Simple JSON envelope for AI message transfer.
- Clear validation via JSON Schema.

## Envelope
The envelope wraps a single message.

### Required Fields
- `spec`: Protocol version string. Must be `aimtp/0.1`.
- `id`: Unique identifier for this envelope. Recommended UUID v4.
- `timestamp`: RFC 3339 UTC timestamp.
- `message`: The message payload.

### Optional Fields
- `sender`: String identifier for the sender.
- `recipient`: String identifier for the recipient.
- `signature`: Object containing signature metadata.
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

## Attachments
An attachment is a metadata reference to binary content.

### Required Fields
- `name`: File name or logical label.
- `content_type`: MIME type.
- `size`: Size in bytes.

### Optional Fields
- `sha256`: Lowercase hex SHA-256 hash of the content.
- `url`: URL to fetch the attachment.

## Security
- This spec does not mandate a signature format.
- If `signature` is present, it should include `key_id` and `signature` fields.

## Errors
- Invalid envelopes should be rejected with a transport-appropriate error.

## Compatibility
- Unknown fields MUST be ignored unless explicitly required by an implementation profile.
