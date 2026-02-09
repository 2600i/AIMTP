"use strict";

const SPEC_VERSION = "aimtp/0.1";
const ROLE_VALUES = new Set(["system", "user", "assistant", "tool"]);
const RFC3339_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const SHA256_REGEX = /^[a-f0-9]{64}$/;

module.exports = {
  SPEC_VERSION,
  ROLE_VALUES,
  RFC3339_REGEX,
  SHA256_REGEX
};
