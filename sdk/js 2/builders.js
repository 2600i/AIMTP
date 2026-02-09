"use strict";

const { randomUUID } = require("crypto");
const { SPEC_VERSION } = require("./constants");
const { validateEnvelope, validateMessage, validateTask } = require("./validators");

function withDefaultsId(value) {
  if (typeof value === "string" && value.trim() !== "") {
    return value;
  }
  return randomUUID();
}

function createMessage(options = {}) {
  const {
    id,
    role,
    content,
    content_type,
    attachments,
    metadata
  } = options;

  if (role === undefined) {
    throw new Error("createMessage requires role");
  }
  if (!Object.prototype.hasOwnProperty.call(options, "content")) {
    throw new Error("createMessage requires content");
  }

  const message = {
    id: withDefaultsId(id),
    role,
    content
  };

  if (content_type !== undefined) {
    message.content_type = content_type;
  } else {
    message.content_type = "text/plain";
  }

  if (attachments !== undefined) {
    message.attachments = attachments;
  }
  if (metadata !== undefined) {
    message.metadata = metadata;
  }

  return message;
}

function createTaskRequest(options = {}) {
  const { id, type, input, expects_response, metadata } = options;

  const task = {
    kind: "request",
    id: withDefaultsId(id)
  };

  if (type !== undefined) {
    task.type = type;
  }
  if (input !== undefined) {
    task.input = input;
  }
  if (expects_response !== undefined) {
    task.expects_response = expects_response;
  }
  if (metadata !== undefined) {
    task.metadata = metadata;
  }

  return task;
}

function createTaskResponse(options = {}) {
  const { id, in_response_to, status, type, output, error, metadata } = options;

  if (in_response_to === undefined || in_response_to === "") {
    throw new Error("createTaskResponse requires in_response_to");
  }
  if (status === undefined || status === "") {
    throw new Error("createTaskResponse requires status");
  }

  const responseId = withDefaultsId(id);
  if (responseId === in_response_to) {
    throw new Error("createTaskResponse requires id distinct from in_response_to");
  }

  const task = {
    kind: "response",
    id: responseId,
    in_response_to,
    status
  };

  if (type !== undefined) {
    task.type = type;
  }
  if (output !== undefined) {
    task.output = output;
  }
  if (error !== undefined) {
    task.error = error;
  }
  if (metadata !== undefined) {
    task.metadata = metadata;
  }

  return task;
}

function createEnvelope(options = {}) {
  const {
    id,
    timestamp,
    sender,
    recipient,
    intent,
    message,
    task,
    signature,
    metadata,
    spec
  } = options;

  if (!message) {
    throw new Error("createEnvelope requires message");
  }

  const envelope = {
    spec: spec || SPEC_VERSION,
    id: withDefaultsId(id),
    timestamp: timestamp || new Date().toISOString(),
    message
  };

  if (sender !== undefined) {
    envelope.sender = sender;
  }
  if (recipient !== undefined) {
    envelope.recipient = recipient;
  }
  if (intent !== undefined) {
    envelope.intent = intent;
  }
  if (task !== undefined) {
    envelope.task = task;
  }
  if (signature !== undefined) {
    envelope.signature = signature;
  }
  if (metadata !== undefined) {
    envelope.metadata = metadata;
  }

  return envelope;
}

function validateMessageOrThrow(message) {
  const errors = validateMessage(message);
  if (errors.length) {
    const messageText = errors.map((err) => `${err.path}: ${err.message}`).join("; ");
    const error = new Error(`Invalid AIMTP message: ${messageText}`);
    error.errors = errors;
    throw error;
  }
  return message;
}

function validateTaskOrThrow(task) {
  const errors = validateTask(task);
  if (errors.length) {
    const messageText = errors.map((err) => `${err.path}: ${err.message}`).join("; ");
    const error = new Error(`Invalid AIMTP task: ${messageText}`);
    error.errors = errors;
    throw error;
  }
  return task;
}

function validateEnvelopeOrThrow(envelope) {
  const errors = validateEnvelope(envelope);
  if (errors.length) {
    const messageText = errors.map((err) => `${err.path}: ${err.message}`).join("; ");
    const error = new Error(`Invalid AIMTP envelope: ${messageText}`);
    error.errors = errors;
    throw error;
  }
  return envelope;
}

module.exports = {
  createMessage,
  createTaskRequest,
  createTaskResponse,
  createEnvelope,
  validateMessageOrThrow,
  validateTaskOrThrow,
  validateEnvelopeOrThrow
};
