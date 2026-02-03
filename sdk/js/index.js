"use strict";

const { SPEC_VERSION } = require("./constants");
const { validateMessage, validateTask, validateEnvelope } = require("./validators");
const {
  createMessage,
  createTaskRequest,
  createTaskResponse,
  createEnvelope,
  validateMessageOrThrow,
  validateTaskOrThrow,
  validateEnvelopeOrThrow
} = require("./builders");
const { encodeEnvelope, decodeEnvelope } = require("./codec");

module.exports = {
  SPEC_VERSION,
  validateMessage,
  validateTask,
  validateEnvelope,
  createMessage,
  createTaskRequest,
  createTaskResponse,
  createEnvelope,
  validateMessageOrThrow,
  validateTaskOrThrow,
  validateEnvelopeOrThrow,
  encodeEnvelope,
  decodeEnvelope
};
