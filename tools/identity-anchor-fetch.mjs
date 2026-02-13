#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

const HTTP_TIMEOUT_MS = 5000;

function normalizeNonEmptyString(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function normalizeDistributionMode(value) {
  const normalized = normalizeNonEmptyString(value).toLowerCase();
  if (normalized === "fs" || normalized === "http" || normalized === "off") {
    return normalized;
  }
  return "off";
}

function normalizePolicyMode(value) {
  const normalized = normalizeNonEmptyString(value).toLowerCase();
  if (normalized === "warn" || normalized === "enforce" || normalized === "off") {
    return normalized;
  }
  return "off";
}

function shouldRun(mode) {
  return (
    process.env.INTENTOS_PROTOCOL_VERSION === "0.4" &&
    process.env.INTENTOS_IDENTITY === "on" &&
    (mode === "fs" || mode === "http")
  );
}

function buildValidator() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const anchorSchemaPath = path.resolve(scriptDir, "../spec/identity-anchor-v0.4.schema.json");
  const anchorSetSchemaPath = path.resolve(scriptDir, "../spec/identity-anchor-set-v0.4.schema.json");

  const anchorSchema = JSON.parse(fs.readFileSync(anchorSchemaPath, "utf8"));
  const anchorSetSchema = JSON.parse(fs.readFileSync(anchorSetSchemaPath, "utf8"));

  const ajv = new Ajv({ allErrors: true, strict: false });
  ajv.addSchema(anchorSchema, anchorSchema.$id);
  return ajv.compile(anchorSetSchema);
}

function formatValidationErrors(validate) {
  return (validate.errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message || "invalid"}`)
    .join("; ");
}

async function fetchJsonFromHttp(urlValue) {
  const parsed = new URL(urlValue);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("identity_anchor_fetch_url_must_be_http_or_https");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const response = await fetch(parsed, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`identity_anchor_fetch_http_status_${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function loadRawAnchorPayload(mode) {
  if (mode === "fs") {
    const anchorPath = normalizeNonEmptyString(process.env.INTENTOS_TRUST_IDENTITY_ANCHORS_PATH);
    if (!anchorPath) {
      return null;
    }
    return fs.readFileSync(anchorPath, "utf8");
  }

  const anchorUrl = normalizeNonEmptyString(process.env.INTENTOS_TRUST_HTTP_IDENTITY_ANCHORS_URL);
  if (!anchorUrl) {
    return null;
  }
  return fetchJsonFromHttp(anchorUrl);
}

function printWarnDiagnostic(message, mode) {
  if (mode !== "warn") {
    return;
  }
  console.warn(
    JSON.stringify({
      event: "intentos_identity_anchor_distribution",
      mode,
      diagnostic: message
    })
  );
}

async function main() {
  const distributionMode = normalizeDistributionMode(process.env.INTENTOS_TRUST_DISTRIBUTION);
  const policyMode = normalizePolicyMode(process.env.INTENTOS_RECEIPT_POLICY);

  if (!shouldRun(distributionMode)) {
    console.log("FETCH SKIPPED");
    return;
  }

  try {
    const rawPayload = await loadRawAnchorPayload(distributionMode);
    if (!rawPayload) {
      console.log("FETCH OK count=0");
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(rawPayload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`identity_anchor_fetch_invalid_json:${message}`);
    }

    const validate = buildValidator();
    if (!validate(parsed)) {
      throw new Error(`identity_anchor_fetch_schema_invalid:${formatValidationErrors(validate)}`);
    }

    const anchorCount = Array.isArray(parsed.anchors) ? parsed.anchors.length : 0;
    console.log(`FETCH OK count=${anchorCount}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (policyMode === "enforce") {
      console.error(message);
      process.exit(1);
      return;
    }
    printWarnDiagnostic(message, policyMode);
    console.log("FETCH OK count=0");
  }
}

main();
