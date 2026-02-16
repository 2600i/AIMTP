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

function normalizeOnOff(value) {
  const normalized = normalizeNonEmptyString(value).toLowerCase();
  if (normalized === "on" || normalized === "off") {
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

function shouldRun(distributionMode, revocationsMode) {
  return (
    process.env.INTENTOS_PROTOCOL_VERSION === "0.4" &&
    revocationsMode === "on" &&
    (distributionMode === "fs" || distributionMode === "http")
  );
}

function buildValidator() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const schemaPath = path.resolve(scriptDir, "../spec/revocation-set-v0.4.schema.json");
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  const ajv = new Ajv({ allErrors: true, strict: false });
  return ajv.compile(schema);
}

function formatValidationErrors(validate) {
  return (validate.errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message || "invalid"}`)
    .join("; ");
}

async function fetchJsonFromHttp(urlValue) {
  const parsed = new URL(urlValue);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("revocation_fetch_url_must_be_http_or_https");
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
      throw new Error(`revocation_fetch_http_status_${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function loadRawRevocationPayload(mode) {
  if (mode === "fs") {
    const revocationPath = normalizeNonEmptyString(process.env.INTENTOS_TRUST_BUNDLE_REVOCATIONS_PATH);
    if (!revocationPath) {
      return { source: null, payload: null };
    }
    return { source: revocationPath, payload: fs.readFileSync(revocationPath, "utf8") };
  }

  const revocationUrl = normalizeNonEmptyString(process.env.INTENTOS_TRUST_HTTP_REVOCATIONS_URL);
  if (!revocationUrl) {
    return { source: null, payload: null };
  }
  return { source: revocationUrl, payload: await fetchJsonFromHttp(revocationUrl) };
}

function printWarnDiagnostic(message, mode) {
  if (mode !== "warn") {
    return;
  }
  console.warn(
    JSON.stringify({
      event: "intentos_revocation_distribution",
      mode,
      diagnostic: message
    })
  );
}

function printSummary(summary) {
  console.log(JSON.stringify(summary));
}

async function main() {
  const distributionMode = normalizeDistributionMode(process.env.INTENTOS_TRUST_DISTRIBUTION);
  const revocationsMode = normalizeOnOff(process.env.INTENTOS_REVOCATIONS);
  const policyMode = normalizePolicyMode(process.env.INTENTOS_REVOCATION_POLICY);

  if (!shouldRun(distributionMode, revocationsMode)) {
    printSummary({
      skipped: true,
      mode: distributionMode,
      revocationsMode,
      policyMode,
      accepted: true,
      revocationCount: 0,
      source: null,
      warnings: [],
      errors: []
    });
    return;
  }

  let source = null;
  try {
    const loaded = await loadRawRevocationPayload(distributionMode);
    source = loaded.source;

    if (!loaded.payload) {
      printSummary({
        skipped: false,
        mode: distributionMode,
        revocationsMode,
        policyMode,
        accepted: true,
        revocationCount: 0,
        source,
        warnings: [],
        errors: []
      });
      return;
    }

    if (policyMode === "off") {
      printSummary({
        skipped: false,
        mode: distributionMode,
        revocationsMode,
        policyMode,
        accepted: true,
        revocationCount: 0,
        source,
        warnings: [],
        errors: []
      });
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(loaded.payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`revocation_fetch_invalid_json:${message}`);
    }

    const validate = buildValidator();
    if (!validate(parsed)) {
      throw new Error(`revocation_fetch_schema_invalid:${formatValidationErrors(validate)}`);
    }

    const count = Array.isArray(parsed.revocations) ? parsed.revocations.length : 0;
    printSummary({
      skipped: false,
      mode: distributionMode,
      revocationsMode,
      policyMode,
      accepted: true,
      revocationCount: count,
      source,
      warnings: [],
      errors: []
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (policyMode === "enforce") {
      printSummary({
        skipped: false,
        mode: distributionMode,
        revocationsMode,
        policyMode,
        accepted: false,
        revocationCount: 0,
        source,
        warnings: [],
        errors: [message]
      });
      process.exit(1);
      return;
    }

    printWarnDiagnostic(message, policyMode);
    printSummary({
      skipped: false,
      mode: distributionMode,
      revocationsMode,
      policyMode,
      accepted: false,
      revocationCount: 0,
      source,
      warnings: policyMode === "warn" ? [message] : [],
      errors: []
    });
  }
}

main();
