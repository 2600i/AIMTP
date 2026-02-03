"use strict";

const ROLE_VALUES = new Set(["system", "user", "assistant", "tool"]);
const SPEC_VERSION = "aimtp/0.1";
const RFC3339_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const SHA256_REGEX = /^[a-f0-9]{64}$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateMessage(message) {
  const errors = [];
  if (!isPlainObject(message)) {
    return [{ path: "message", message: "message must be an object" }];
  }

  if (typeof message.id !== "string" || message.id.trim() === "") {
    errors.push({ path: "message.id", message: "id must be a non-empty string" });
  }

  if (typeof message.role !== "string" || !ROLE_VALUES.has(message.role)) {
    errors.push({ path: "message.role", message: "role must be one of system, user, assistant, tool" });
  }

  if (typeof message.content !== "string") {
    errors.push({ path: "message.content", message: "content must be a string" });
  }

  if (message.content_type !== undefined && typeof message.content_type !== "string") {
    errors.push({ path: "message.content_type", message: "content_type must be a string" });
  }

  if (message.attachments !== undefined) {
    if (!Array.isArray(message.attachments)) {
      errors.push({ path: "message.attachments", message: "attachments must be an array" });
    } else {
      message.attachments.forEach((attachment, index) => {
        const base = `message.attachments[${index}]`;
        if (!isPlainObject(attachment)) {
          errors.push({ path: base, message: "attachment must be an object" });
          return;
        }
        if (typeof attachment.name !== "string" || attachment.name.trim() === "") {
          errors.push({ path: `${base}.name`, message: "name must be a non-empty string" });
        }
        if (typeof attachment.content_type !== "string") {
          errors.push({ path: `${base}.content_type`, message: "content_type must be a string" });
        }
        if (!Number.isInteger(attachment.size) || attachment.size < 0) {
          errors.push({ path: `${base}.size`, message: "size must be a non-negative integer" });
        }
        if (attachment.sha256 !== undefined && !SHA256_REGEX.test(attachment.sha256)) {
          errors.push({ path: `${base}.sha256`, message: "sha256 must be lowercase hex" });
        }
        if (attachment.url !== undefined) {
          if (typeof attachment.url !== "string") {
            errors.push({ path: `${base}.url`, message: "url must be a string" });
          } else {
            try {
              new URL(attachment.url);
            } catch (_err) {
              errors.push({ path: `${base}.url`, message: "url must be a valid URL" });
            }
          }
        }
      });
    }
  }

  if (message.metadata !== undefined && !isPlainObject(message.metadata)) {
    errors.push({ path: "message.metadata", message: "metadata must be an object" });
  }

  return errors;
}

function validateEnvelope(envelope) {
  const errors = [];
  if (!isPlainObject(envelope)) {
    return [{ path: "envelope", message: "envelope must be an object" }];
  }

  if (envelope.spec !== SPEC_VERSION) {
    errors.push({ path: "spec", message: `spec must be ${SPEC_VERSION}` });
  }

  if (typeof envelope.id !== "string" || envelope.id.trim() === "") {
    errors.push({ path: "id", message: "id must be a non-empty string" });
  }

  if (typeof envelope.timestamp !== "string" || !RFC3339_REGEX.test(envelope.timestamp)) {
    errors.push({ path: "timestamp", message: "timestamp must be RFC3339 date-time" });
  }

  if (envelope.sender !== undefined && typeof envelope.sender !== "string") {
    errors.push({ path: "sender", message: "sender must be a string" });
  }

  if (envelope.recipient !== undefined && typeof envelope.recipient !== "string") {
    errors.push({ path: "recipient", message: "recipient must be a string" });
  }

  if (envelope.signature !== undefined) {
    if (!isPlainObject(envelope.signature)) {
      errors.push({ path: "signature", message: "signature must be an object" });
    } else {
      if (typeof envelope.signature.key_id !== "string" || envelope.signature.key_id.trim() === "") {
        errors.push({ path: "signature.key_id", message: "key_id must be a non-empty string" });
      }
      if (typeof envelope.signature.signature !== "string" || envelope.signature.signature.trim() === "") {
        errors.push({ path: "signature.signature", message: "signature must be a non-empty string" });
      }
      if (envelope.signature.alg !== undefined && typeof envelope.signature.alg !== "string") {
        errors.push({ path: "signature.alg", message: "alg must be a string" });
      }
    }
  }

  if (envelope.metadata !== undefined && !isPlainObject(envelope.metadata)) {
    errors.push({ path: "metadata", message: "metadata must be an object" });
  }

  const messageErrors = validateMessage(envelope.message);
  return errors.concat(messageErrors);
}

function encodeEnvelope(envelope) {
  const errors = validateEnvelope(envelope);
  if (errors.length) {
    const message = errors.map((err) => `${err.path}: ${err.message}`).join("; ");
    const error = new Error(`Invalid AIMTP envelope: ${message}`);
    error.errors = errors;
    throw error;
  }
  return JSON.stringify(envelope);
}

function decodeEnvelope(payload) {
  if (typeof payload !== "string") {
    throw new Error("Payload must be a JSON string");
  }
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch (err) {
    const error = new Error("Invalid JSON payload");
    error.cause = err;
    throw error;
  }
  const errors = validateEnvelope(parsed);
  if (errors.length) {
    const message = errors.map((err) => `${err.path}: ${err.message}`).join("; ");
    const error = new Error(`Invalid AIMTP envelope: ${message}`);
    error.errors = errors;
    throw error;
  }
  return parsed;
}

module.exports = {
  SPEC_VERSION,
  validateMessage,
  validateEnvelope,
  encodeEnvelope,
  decodeEnvelope
};
