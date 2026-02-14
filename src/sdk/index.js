"use strict";

const ROLE_VALUES = new Set(["system", "user", "assistant", "tool"]);
const SPEC_VERSION = "aimtp/0.1";
const RFC3339_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const SHA256_REGEX = /^[a-f0-9]{64}$/;
const INTENT_TYPE_VALUES = new Set([
  "task.request",
  "task.response",
  "task.update",
  "task.cancel",
  "event",
  "query"
]);
const INTENT_PRIORITY_VALUES = new Set(["low", "normal", "high", "urgent"]);
const ACTION_TYPE_VALUES = new Set(["invoke", "route", "transform", "store", "notify"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateIntentValue(errors, path, value) {
  if (typeof value === "string") {
    return;
  }
  if (!isPlainObject(value)) {
    errors.push({ path, message: "intent must be a string or object" });
    return;
  }

  if (typeof value.type !== "string" || value.type.trim() === "") {
    errors.push({ path: `${path}.type`, message: "type must be a non-empty string" });
  } else if (!INTENT_TYPE_VALUES.has(value.type) && value.type.length > 128) {
    errors.push({ path: `${path}.type`, message: "type must be 128 characters or fewer" });
  }

  if (value.priority !== undefined) {
    const validStringPriority =
      typeof value.priority === "string" && INTENT_PRIORITY_VALUES.has(value.priority);
    const validNumericPriority =
      Number.isInteger(value.priority) && value.priority >= 0 && value.priority <= 100;
    if (!validStringPriority && !validNumericPriority) {
      errors.push({
        path: `${path}.priority`,
        message: "priority must be low, normal, high, urgent, or an integer 0-100"
      });
    }
  }

  if (
    value.deadline !== undefined &&
    (typeof value.deadline !== "string" || !RFC3339_REGEX.test(value.deadline))
  ) {
    errors.push({ path: `${path}.deadline`, message: "deadline must be RFC3339 date-time" });
  }

  if (value.requires_ack !== undefined && typeof value.requires_ack !== "boolean") {
    errors.push({ path: `${path}.requires_ack`, message: "requires_ack must be a boolean" });
  }

  if (value.tags !== undefined) {
    if (!Array.isArray(value.tags)) {
      errors.push({ path: `${path}.tags`, message: "tags must be an array" });
    } else {
      value.tags.forEach((tag, index) => {
        if (typeof tag !== "string" || tag.trim() === "") {
          errors.push({
            path: `${path}.tags[${index}]`,
            message: "tag must be a non-empty string"
          });
        }
      });
    }
  }
}

function validateActions(errors, path, actions) {
  if (actions === undefined) {
    return;
  }
  if (!Array.isArray(actions)) {
    errors.push({ path, message: "actions must be an array" });
    return;
  }
  actions.forEach((action, index) => {
    const base = `${path}[${index}]`;
    if (!isPlainObject(action)) {
      errors.push({ path: base, message: "action must be an object" });
      return;
    }
    if (typeof action.id !== "string" || action.id.trim() === "") {
      errors.push({ path: `${base}.id`, message: "id must be a non-empty string" });
    }
    if (typeof action.type !== "string" || action.type.trim() === "") {
      errors.push({ path: `${base}.type`, message: "type must be a non-empty string" });
    } else if (!ACTION_TYPE_VALUES.has(action.type) && action.type.length > 128) {
      errors.push({ path: `${base}.type`, message: "type must be 128 characters or fewer" });
    }
    if (!isPlainObject(action.inputs)) {
      errors.push({ path: `${base}.inputs`, message: "inputs must be an object" });
    }
    if (action.constraints !== undefined && !isPlainObject(action.constraints)) {
      errors.push({
        path: `${base}.constraints`,
        message: "constraints must be an object"
      });
    }
    if (action.on_success !== undefined && !isPlainObject(action.on_success)) {
      errors.push({
        path: `${base}.on_success`,
        message: "on_success must be an object"
      });
    }
    if (action.on_failure !== undefined && !isPlainObject(action.on_failure)) {
      errors.push({
        path: `${base}.on_failure`,
        message: "on_failure must be an object"
      });
    }
  });
}

function validateCapabilities(errors, path, capabilities) {
  if (capabilities === undefined) {
    return;
  }
  if (!isPlainObject(capabilities)) {
    errors.push({ path, message: "capabilities must be an object" });
    return;
  }
  const fields = ["offered", "required"];
  fields.forEach((field) => {
    if (capabilities[field] === undefined) {
      return;
    }
    if (!Array.isArray(capabilities[field])) {
      errors.push({ path: `${path}.${field}`, message: `${field} must be an array` });
      return;
    }
    capabilities[field].forEach((value, index) => {
      if (typeof value !== "string" || value.trim() === "") {
        errors.push({
          path: `${path}.${field}[${index}]`,
          message: "capability must be a non-empty string"
        });
      }
    });
  });
}

function validateNegotiation(errors, path, negotiation) {
  if (negotiation === undefined) {
    return;
  }
  if (!isPlainObject(negotiation)) {
    errors.push({ path, message: "negotiation must be an object" });
    return;
  }
  if (negotiation.offer !== undefined && !isPlainObject(negotiation.offer)) {
    errors.push({ path: `${path}.offer`, message: "offer must be an object" });
  }
  if (negotiation.counter !== undefined && !isPlainObject(negotiation.counter)) {
    errors.push({ path: `${path}.counter`, message: "counter must be an object" });
  }
  if (negotiation.accept !== undefined && typeof negotiation.accept !== "boolean") {
    errors.push({ path: `${path}.accept`, message: "accept must be a boolean" });
  }
  if (negotiation.reject !== undefined && typeof negotiation.reject !== "boolean") {
    errors.push({ path: `${path}.reject`, message: "reject must be a boolean" });
  }
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

  if (message.intent !== undefined) {
    validateIntentValue(errors, "message.intent", message.intent);
  }

  validateActions(errors, "message.actions", message.actions);
  validateCapabilities(errors, "message.capabilities", message.capabilities);
  validateNegotiation(errors, "message.negotiation", message.negotiation);

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

  if (envelope.intent !== undefined) {
    validateIntentValue(errors, "intent", envelope.intent);
  }

  validateActions(errors, "actions", envelope.actions);
  validateCapabilities(errors, "capabilities", envelope.capabilities);
  validateNegotiation(errors, "negotiation", envelope.negotiation);

  if (envelope.signature !== undefined) {
    if (!isPlainObject(envelope.signature)) {
      errors.push({ path: "signature", message: "signature must be an object" });
    } else {
      // Signature validation here is structural only; cryptographic verification is runtime policy.
      const hasKid =
        (typeof envelope.signature.kid === "string" && envelope.signature.kid.trim() !== "") ||
        (typeof envelope.signature.key_id === "string" && envelope.signature.key_id.trim() !== "");
      if (!hasKid) {
        errors.push({
          path: "signature.kid",
          message: "kid (or key_id) must be a non-empty string"
        });
      }
      const hasSig =
        (typeof envelope.signature.sig === "string" && envelope.signature.sig.trim() !== "") ||
        (typeof envelope.signature.signature === "string" &&
          envelope.signature.signature.trim() !== "");
      if (!hasSig) {
        errors.push({
          path: "signature.sig",
          message: "sig (or signature) must be a non-empty string"
        });
      }
      if (envelope.signature.alg !== undefined && typeof envelope.signature.alg !== "string") {
        errors.push({ path: "signature.alg", message: "alg must be a string" });
      }
      if (
        envelope.signature.created_at !== undefined &&
        (typeof envelope.signature.created_at !== "string" ||
          !RFC3339_REGEX.test(envelope.signature.created_at))
      ) {
        errors.push({
          path: "signature.created_at",
          message: "created_at must be RFC3339 date-time"
        });
      }
      if (
        envelope.signature.expires_at !== undefined &&
        (typeof envelope.signature.expires_at !== "string" ||
          !RFC3339_REGEX.test(envelope.signature.expires_at))
      ) {
        errors.push({
          path: "signature.expires_at",
          message: "expires_at must be RFC3339 date-time"
        });
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

const sdkExports = {
  SPEC_VERSION,
  validateMessage,
  validateEnvelope,
  encodeEnvelope,
  decodeEnvelope
};

module.exports = sdkExports;

// Backward-compatible CJS export shape: keep named exports available at top-level.
module.exports.decodeEnvelope = decodeEnvelope;
module.exports.encodeEnvelope = encodeEnvelope;
module.exports.validateEnvelope = validateEnvelope;

if (!module.exports.default) {
  module.exports.default = sdkExports;
}

if (
  process.env.NODE_ENV !== "production" &&
  typeof module.exports.validateEnvelope !== "function"
) {
  throw new Error("AIMTP SDK export invariant failed: validateEnvelope must be a function");
}
