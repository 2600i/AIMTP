"use strict";

const fs = require("fs");
const path = require("path");

const RFC3339_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const SCHEMA_DIR = path.join(__dirname, "..", "schemas");

function loadSchema(filename) {
  const fullPath = path.join(SCHEMA_DIR, filename);
  const raw = fs.readFileSync(fullPath, "utf-8");
  return JSON.parse(raw);
}

const ENVELOPE_SCHEMA = loadSchema("envelope.schema.json");
const MESSAGE_SCHEMA = loadSchema("message.schema.json");

const SPEC_VERSION = ENVELOPE_SCHEMA.properties.spec.const;
const ROLE_VALUES = new Set(MESSAGE_SCHEMA.properties.role.enum);
const STATUS_VALUES = new Set(
  ENVELOPE_SCHEMA.properties.task.oneOf[1].properties.status.enum
);
const SHA256_REGEX = new RegExp(
  MESSAGE_SCHEMA.properties.attachments.items.properties.sha256.pattern
);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pushError(errors, path, message) {
  errors.push({ path, message });
}

function validateMessage(message) {
  const errors = [];
  if (!isPlainObject(message)) {
    return [{ path: "message", message: "message must be an object" }];
  }

  if (typeof message.id !== "string" || message.id.trim() === "") {
    pushError(errors, "message.id", "id must be a non-empty string");
  }

  if (typeof message.role !== "string" || !ROLE_VALUES.has(message.role)) {
    pushError(errors, "message.role", "role must be one of system, user, assistant, tool");
  }

  if (!Object.prototype.hasOwnProperty.call(message, "content")) {
    pushError(errors, "message.content", "content is required");
  }

  if (message.content_type !== undefined && typeof message.content_type !== "string") {
    pushError(errors, "message.content_type", "content_type must be a string");
  }

  if (message.attachments !== undefined) {
    if (!Array.isArray(message.attachments)) {
      pushError(errors, "message.attachments", "attachments must be an array");
    } else {
      message.attachments.forEach((attachment, index) => {
        const base = `message.attachments[${index}]`;
        if (!isPlainObject(attachment)) {
          pushError(errors, base, "attachment must be an object");
          return;
        }
        if (typeof attachment.name !== "string" || attachment.name.trim() === "") {
          pushError(errors, `${base}.name`, "name must be a non-empty string");
        }
        if (typeof attachment.content_type !== "string") {
          pushError(errors, `${base}.content_type`, "content_type must be a string");
        }
        if (!Number.isInteger(attachment.size) || attachment.size < 0) {
          pushError(errors, `${base}.size`, "size must be a non-negative integer");
        }
        if (attachment.sha256 !== undefined && !SHA256_REGEX.test(attachment.sha256)) {
          pushError(errors, `${base}.sha256`, "sha256 must be lowercase hex");
        }
        if (attachment.url !== undefined) {
          if (typeof attachment.url !== "string") {
            pushError(errors, `${base}.url`, "url must be a string");
          } else {
            try {
              new URL(attachment.url);
            } catch (_err) {
              pushError(errors, `${base}.url`, "url must be a valid URL");
            }
          }
        }
      });
    }
  }

  if (message.metadata !== undefined && !isPlainObject(message.metadata)) {
    pushError(errors, "message.metadata", "metadata must be an object");
  }

  return errors;
}

function validateTask(task) {
  const errors = [];
  if (task === undefined) {
    return errors;
  }

  if (!isPlainObject(task)) {
    return [{ path: "task", message: "task must be an object" }];
  }

  if (typeof task.kind !== "string") {
    pushError(errors, "task.kind", "kind must be a string");
    return errors;
  }

  if (task.kind === "request") {
    if (typeof task.id !== "string" || task.id.trim() === "") {
      pushError(errors, "task.id", "id must be a non-empty string");
    }
    if (task.type !== undefined && typeof task.type !== "string") {
      pushError(errors, "task.type", "type must be a string");
    }
    if (task.input !== undefined && !isPlainObject(task.input)) {
      pushError(errors, "task.input", "input must be an object");
    }
    if (task.expects_response !== undefined && typeof task.expects_response !== "boolean") {
      pushError(errors, "task.expects_response", "expects_response must be a boolean");
    }
    if (task.metadata !== undefined && !isPlainObject(task.metadata)) {
      pushError(errors, "task.metadata", "metadata must be an object");
    }

    if (Object.prototype.hasOwnProperty.call(task, "in_response_to")) {
      pushError(errors, "task.in_response_to", "in_response_to is not allowed on request");
    }
    if (Object.prototype.hasOwnProperty.call(task, "status")) {
      pushError(errors, "task.status", "status is not allowed on request");
    }
    if (Object.prototype.hasOwnProperty.call(task, "output")) {
      pushError(errors, "task.output", "output is not allowed on request");
    }
    if (Object.prototype.hasOwnProperty.call(task, "error")) {
      pushError(errors, "task.error", "error is not allowed on request");
    }

    return errors;
  }

  if (task.kind === "response") {
    if (typeof task.id !== "string" || task.id.trim() === "") {
      pushError(errors, "task.id", "id must be a non-empty string");
    }
    if (typeof task.in_response_to !== "string" || task.in_response_to.trim() === "") {
      pushError(errors, "task.in_response_to", "in_response_to must be a non-empty string");
    }
    if (task.type !== undefined && typeof task.type !== "string") {
      pushError(errors, "task.type", "type must be a string");
    }
    if (typeof task.status !== "string") {
      pushError(errors, "task.status", "status must be a string");
    } else if (!STATUS_VALUES.has(task.status)) {
      pushError(errors, "task.status", "status must be pending, running, succeeded, or failed");
    }

    if (task.output !== undefined && !isPlainObject(task.output)) {
      pushError(errors, "task.output", "output must be an object");
    }

    if (task.error !== undefined) {
      if (!isPlainObject(task.error)) {
        pushError(errors, "task.error", "error must be an object");
      } else {
        if (typeof task.error.code !== "string" || task.error.code.trim() === "") {
          pushError(errors, "task.error.code", "code must be a non-empty string");
        }
        if (typeof task.error.message !== "string" || task.error.message.trim() === "") {
          pushError(errors, "task.error.message", "message must be a non-empty string");
        }
        if (task.error.details !== undefined && !isPlainObject(task.error.details)) {
          pushError(errors, "task.error.details", "details must be an object");
        }
      }
    }

    if (task.metadata !== undefined && !isPlainObject(task.metadata)) {
      pushError(errors, "task.metadata", "metadata must be an object");
    }

    if (task.status === "failed") {
      if (task.error === undefined) {
        pushError(errors, "task.error", "error is required when status is failed");
      }
      if (Object.prototype.hasOwnProperty.call(task, "output")) {
        pushError(errors, "task.output", "output is not allowed when status is failed");
      }
    }

    if (task.status === "succeeded") {
      if (Object.prototype.hasOwnProperty.call(task, "error")) {
        pushError(errors, "task.error", "error is not allowed when status is succeeded");
      }
    }

    if (task.status === "pending" || task.status === "running") {
      if (Object.prototype.hasOwnProperty.call(task, "output")) {
        pushError(errors, "task.output", "output is not allowed when status is pending or running");
      }
      if (Object.prototype.hasOwnProperty.call(task, "error")) {
        pushError(errors, "task.error", "error is not allowed when status is pending or running");
      }
    }

    return errors;
  }

  pushError(errors, "task.kind", "kind must be request or response");
  return errors;
}

function validateEnvelope(envelope) {
  const errors = [];
  if (!isPlainObject(envelope)) {
    return [{ path: "envelope", message: "envelope must be an object" }];
  }

  if (envelope.spec !== SPEC_VERSION) {
    pushError(errors, "spec", `spec must be ${SPEC_VERSION}`);
  }

  if (typeof envelope.id !== "string" || envelope.id.trim() === "") {
    pushError(errors, "id", "id must be a non-empty string");
  }

  if (typeof envelope.timestamp !== "string" || !RFC3339_REGEX.test(envelope.timestamp)) {
    pushError(errors, "timestamp", "timestamp must be RFC3339 date-time");
  }

  if (envelope.sender !== undefined && typeof envelope.sender !== "string") {
    pushError(errors, "sender", "sender must be a string");
  }

  if (envelope.recipient !== undefined && typeof envelope.recipient !== "string") {
    pushError(errors, "recipient", "recipient must be a string");
  }

  if (envelope.intent !== undefined && typeof envelope.intent !== "string") {
    pushError(errors, "intent", "intent must be a string");
  }

  if (!Object.prototype.hasOwnProperty.call(envelope, "message")) {
    pushError(errors, "message", "message is required");
  } else {
    errors.push(...validateMessage(envelope.message));
  }

  if (envelope.signature !== undefined) {
    if (!isPlainObject(envelope.signature)) {
      pushError(errors, "signature", "signature must be an object");
    } else {
      // Signature validation here is structural only; cryptographic verification is runtime policy.
      const hasKid =
        (typeof envelope.signature.kid === "string" && envelope.signature.kid.trim() !== "") ||
        (typeof envelope.signature.key_id === "string" && envelope.signature.key_id.trim() !== "");
      if (!hasKid) {
        pushError(
          errors,
          "signature.kid",
          "kid (or key_id) must be a non-empty string"
        );
      }
      const hasSig =
        (typeof envelope.signature.sig === "string" && envelope.signature.sig.trim() !== "") ||
        (typeof envelope.signature.signature === "string" &&
          envelope.signature.signature.trim() !== "");
      if (!hasSig) {
        pushError(
          errors,
          "signature.sig",
          "sig (or signature) must be a non-empty string"
        );
      }
      if (envelope.signature.alg !== undefined && typeof envelope.signature.alg !== "string") {
        pushError(errors, "signature.alg", "alg must be a string");
      }
      if (
        envelope.signature.created_at !== undefined &&
        (typeof envelope.signature.created_at !== "string" ||
          !RFC3339_REGEX.test(envelope.signature.created_at))
      ) {
        pushError(errors, "signature.created_at", "created_at must be RFC3339 date-time");
      }
      if (
        envelope.signature.expires_at !== undefined &&
        (typeof envelope.signature.expires_at !== "string" ||
          !RFC3339_REGEX.test(envelope.signature.expires_at))
      ) {
        pushError(errors, "signature.expires_at", "expires_at must be RFC3339 date-time");
      }
    }
  }

  if (envelope.metadata !== undefined && !isPlainObject(envelope.metadata)) {
    pushError(errors, "metadata", "metadata must be an object");
  }

  errors.push(...validateTask(envelope.task));

  return errors;
}

module.exports = {
  SPEC_VERSION,
  validateMessage,
  validateTask,
  validateEnvelope
};
