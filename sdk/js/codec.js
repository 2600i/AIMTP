"use strict";

const { validateEnvelope } = require("./validators");

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
  encodeEnvelope,
  decodeEnvelope
};
